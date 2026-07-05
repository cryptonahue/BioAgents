# Proposal: Bioprospecting Review UI

## Intent

Operators and admins have no first-class surface to triage the three detection systems wired into BioAgents (fact-level review, contradiction detection, semantic dedup). The backend is complete for contradictions and dedup, and partially complete for compound authority, but the only existing review UI is the fact-level review inside `ResearchBrainPage`. This change ships a dedicated `/admin` page with internal tabs for Contras, Dedup, and Stats so operators can answer "what needs my attention?" without knowing source IDs or calling APIs.

## Scope

### In Scope

- New `/admin` page (`AdminPage.tsx`) with three sub-tabs: Contras, Dedup, Stats
- Four new backend routes for global listing, stats, and unmerge operations
- New `dedup_audit` table + three soft-delete columns on `research_bioprospecting_fact_edges`
- Unmerge flow with a dropdown + free-text reason dialog (reason REQUIRED, dropdown REQUIRED, detail optional)
- Bulk resolve/dismiss on the Contras tab (per-row checkbox + "Resolve selected" / "Dismiss selected" buttons)
- Dedup tab defaults to "last 7 days" window, matches the `last7d` bucket of Stats
- Stats card surfaces `{ today, last7d } × { found, resolved, dismissed, pending, merges, unmerges }`
- Admin gate via JWT `role === "admin"` on both API and sidebar nav
- 50/page pagination for all admin list endpoints
- 25-30 hermetic tests for new hooks, service helpers, and the unmerge flow

### Out of Scope (deferred to PR #2 follow-up)

- Compound authority admin tab (failed/pending compounds + audit log)
- "Failed compounds" badge in `ResearchBrainPage`'s review tab
- `GET /api/research-brain/compounds/audit?since=7d` endpoint
- Geographic conflict detection (already deferred from contradiction Phase 1)
- Real-time streaming contradiction detection
- Caching of stats responses (v1 is plain `COUNT(*)`)

## Capabilities

### New Capabilities

- `bioprospecting-review-ui`: Operator-facing admin page to triage contradictions, review/undo dedup merges, and observe activity stats. Three sub-tabs (Contras, Dedup, Stats) gated on JWT `role === "admin"`.

### Modified Capabilities

- `bioprospecting-contradiction-detection`: Adds global list + stats endpoints; existing per-source route stays. The capability now also exposes a bulk resolve operation (client-side N×single-resolve with optimistic UI).
- `bioprospecting-semantic-dedup`: Adds a read endpoint for recent merge events, a group-detail endpoint, and an unmerge mutation. The unmerge soft-deletes the edge row (does NOT clear the `merged_into_fact_id` cache or rewrite the identity_key), preserving reversibility.

## Approach

### 1. Schema changes (1 new table, 3 new columns)

**New table** `research_bioprospecting_dedup_audit` — mirrors `compound_authority_audit`:

```sql
CREATE TABLE research_bioprospecting_dedup_audit (
  id BIGSERIAL PRIMARY KEY,
  fact_id UUID NOT NULL REFERENCES research_bioprospecting_facts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('merge', 'unmerge')),
  old_canonical_id UUID REFERENCES research_bioprospecting_facts(id) ON DELETE SET NULL,
  new_canonical_id UUID REFERENCES research_bioprospecting_facts(id) ON DELETE SET NULL,
  user_id TEXT,
  reason TEXT,
  reason_category TEXT CHECK (reason_category IN ('false_positive', 'different_compound', 'measurement_error', 'other')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dedup_audit_fact_idx ON research_bioprospecting_dedup_audit (fact_id, created_at DESC);
CREATE INDEX dedup_audit_created_idx ON research_bioprospecting_dedup_audit (created_at DESC);
```

**New columns on `research_bioprospecting_fact_edges`** (soft-delete, reversible):

```sql
ALTER TABLE research_bioprospecting_fact_edges
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN unmerged_at TIMESTAMPTZ,
  ADD COLUMN unmerged_by TEXT;
CREATE INDEX dedup_edge_active_idx ON research_bioprospecting_fact_edges (canonical_fact_id, is_active);
```

Rationale (decision Q1): the unique partial index on `identity_key` lives on the facts table, not the edge. Soft-deleting the edge (`is_active = false`) keeps the previously-merged fact pointing at its former canonical via the `merged_into_fact_id` cache, leaves the identity index untouched, and allows re-merge. A one-shot reconciliation can later clear stale cache rows. Hard-delete + re-canonicalize (option b) is destructive; manual fact edit first (option c) is worst UX. The unmerge dialog's reason field is required, dropdown + textarea (Q1 decision: dropdown values `false_positive` | `different_compound` | `measurement_error` | `other` + free textarea for detail; dropdown REQUIRED, textarea OPTIONAL).

### 2. Backend changes (4 new routes + 2 service helpers)

**New routes** (all in `src/routes/research-brain.ts`):

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET`  | `/api/research-brain/contradictions?status=&sourceId=&limit=50&offset=0` | admin | Global paginated list of contradictions with filters. |
| `GET`  | `/api/research-brain/contradictions/stats` | admin | Returns `{ today: {...}, last7d: {...} }` with the metric set below. |
| `GET`  | `/api/research-brain/dedup/events?limit=50&offset=0&since=7d` | admin | List recent merge events (joins `fact_edges` → `dedup_audit` → facts). |
| `POST` | `/api/research-brain/dedup/:factId/unmerge` | admin | Soft-deletes the edge row, writes `dedup_audit` row with `event_type='unmerge'`, returns the updated group. Body: `{ reason: string, reasonCategory: 'false_positive'\|'different_compound'\|'measurement_error'\|'other' }`. |

**Reused** (no change, just wired to client):
- `POST /api/research-brain/contradictions/:id/resolve` — exists; client bulk action N×calls with optimistic UI update.
- `getDuplicateGroup(factId)` in `src/services/researchBrain/db.ts` — exposed via the new dedup/events response payload.

**Service helpers** (added to existing files):
- `listContradictionsGlobal({ status?, sourceId?, limit, offset })` in `contradictionDb.ts`
- `getContradictionStats()` in `contradictionDb.ts` — runs `COUNT(*)` GROUP BY `resolution_status` for `created_at >= now() - interval '1 day'` and `'7 days'`.
- `listRecentMergeEvents({ limit, offset, since })` in `db.ts` — joins `fact_edges` to `dedup_audit` to return `{ eventId, factId, canonicalFactId, matchRule, mergedAt, unmergedAt?, unmergedBy?, isActive, factSummary }[]`.
- `unmergeFact({ factId, userId, reason, reasonCategory })` in `db.ts` — sets `is_active=false`, `unmerged_at=now()`, `unmerged_by=userId` on the edge row matching `merged_fact_id=factId AND is_active=true`, then inserts the audit row. Returns the updated edge.

**Stats response shape** (Q4 decision: Contras + Dedup in the same card):

```json
{
  "today":    { "found": N, "resolved": N, "dismissed": N, "pending": N, "merges": N, "unmerges": N },
  "last7d":   { "found": N, "resolved": N, "dismissed": N, "pending": N, "merges": N, "unmerges": N }
}
```

- `found` = `COUNT(contradictions WHERE created_at >= window)`
- `resolved` = `COUNT(contradictions WHERE resolution_status='resolved' AND resolved_at >= window)`
- `dismissed` = `COUNT(contradictions WHERE resolution_status='dismissed' AND resolved_at >= window)`
- `pending` = `found - resolved - dismissed` (computed)
- `merges` = `COUNT(fact_edges WHERE merged_at >= window AND is_active=true)`
- `unmerges` = `COUNT(fact_edges WHERE unmerged_at >= window)`

No caching in v1 (Q3 decision): the `resolution_status` index is already in place, `COUNT(*)` is O(log n) cheap, and admin pages are low-traffic.

### 3. Frontend changes

**New page** `client/src/pages/AdminPage.tsx` (~600-800 LOC):
- Internal tab state: `'contras' | 'dedup' | 'stats'`
- Each tab is a sub-component (~200 LOC each) co-located in the same file
- Reuses `EvidenceLightbox` from `ResearchBrainPage` for fact provenance drill-down
- Reuses the `useAdmin()` role-check pattern (decode JWT `claims.role`)
- Mounts at `/admin` route in both `LegacyAppShell` and `CoralAppShell`

**Tab 1 — Contras** (Q3 decision: per-row checkbox + bulk buttons):
- Table of unresolved contradictions (default filter), columns: sourceA snippet, sourceB snippet, type, detected_at, status, checkbox
- Per-row actions: "Resolve" / "Dismiss" buttons
- Footer action bar (visible when ≥1 row selected): "Resolve selected (N)" / "Dismiss selected (N)" / "Clear selection"
- On bulk click: N×`POST /contradictions/:id/resolve` with optimistic UI (rows fade out, revert on any 4xx/5xx with toast)
- Filter chips: `All | Unresolved | Resolved | Dismissed`
- Pagination: 50/page with prev/next
- Empty state with a "Run detection on a source" link to `ResearchBrainPage`

**Tab 2 — Dedup** (Q2 decision: defaults to last 7 days):
- Window selector: `Today | Last 7 days (default) | Last 30 days | All time` — bound to `since` param
- List of merge events (newest first): each row shows `{ canonicalFactId, mergedFactId, matchRule, mergedAt, factSummary snippet }`
- Click row → expanded panel showing the duplicate group via `getDuplicateGroup(factId)` — all members with their identity_key + bioactivity values
- Per-row "Unmerge" button → opens unmerge dialog
- **Unmerge dialog** (Q1 decision):
  - Dropdown: `<select required>` with values `false_positive` | `different_compound` | `measurement_error` | `other`
  - Textarea: optional, free text for additional detail
  - Validation: form submits only if dropdown has a value
  - On submit: `POST /dedup/:factId/unmerge` with `{ reason: textarea, reasonCategory: dropdown }`
  - Success: row fades out, toast "Unmerged", audit written
  - Failure: inline error, row stays
- Pagination: 50/page

**Tab 3 — Stats**:
- Single card with two side-by-side sections: `Today` | `Last 7 days`
- Each section shows 6 metric tiles: `Found | Resolved | Dismissed | Pending | Merges | Unmerges`
- Auto-refresh on tab open (no polling in v1)
- "View all activity →" link to the Contras tab with `?status=resolved` filter

**New client hooks** in `client/src/hooks/useResearchBrain.ts` (or a new `client/src/hooks/useAdminReview.ts`):
- `useAdminContradictions({ status, sourceId, page })` — list
- `useResolveContradiction()` — single mutation
- `useBulkResolveContradictions()` — N×mutation with optimistic batching
- `useDedupEvents({ since, page })` — list
- `useDedupGroup(factId)` — group detail
- `useUnmergeFact()` — mutation with reason
- `useAdminStats()` — stats snapshot

**New CSS** `client/src/styles/admin.css` (~150 LOC) — mirrors `corpus.css` table styling.

**Sidebar** `client/src/components/Sidebar.jsx`:
- Add a "Admin" nav button, gated on `useAdmin()` (decode JWT role)
- Position below the existing Library + Research Brain buttons

**Router mount** in `client/src/index.jsx`:
- Register `<AdminPage />` at `/admin` in both `LegacyAppShell` and `CoralAppShell`
- Import the new CSS once at top-level

### 4. Tests (25-30 hermetic cases)

- Service-level: `unmergeFact` happy path, `unmergeFact` on already-unmerged (no-op + idempotent audit), `unmergeFact` on nonexistent fact (404), `listRecentMergeEvents` pagination, `getContradictionStats` math correctness across two windows.
- Route-level: contradictions list with status filter, contradictions list with sourceId filter, dedup events list, unmerge auth gate (403 for non-admin), resolve auth gate.
- Hook-level: `useAdminContradictions` fetch + cache, `useBulkResolveContradictions` partial-failure rollback (e.g. 1 of 3 fails).
- Component-level: AdminPage tab switching, Contras tab bulk action, Dedup tab unmerge dialog validation (dropdown required, submit disabled when empty).

No new RLS policies — auth is API-layer (admin gate), matching the existing pattern in `src/middleware/authResolver.ts:334-353`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `supabase/migrations/20260616XXXXXX_create_dedup_audit.sql` | New | `dedup_audit` table (~15 LOC) |
| `supabase/migrations/20260616XXXXXX_dedup_edge_soft_delete.sql` | New | 3 cols + index on edge table (~10 LOC) |
| `src/routes/research-brain.ts` | Modified | Add 4 new routes (contradictions list, contradictions stats, dedup events, dedup unmerge) |
| `src/services/researchBrain/contradictionDb.ts` | Modified | Add `listContradictionsGlobal()` + `getContradictionStats()` helpers |
| `src/services/researchBrain/db.ts` | Modified | Add `listRecentMergeEvents()` + `unmergeFact()` helpers |
| `src/services/researchBrain/types.ts` | Modified | Add `RecentDedupEvent` + `DedupStats` + `UnmergeRequest` types |
| `client/src/pages/AdminPage.tsx` | New | 3-tab admin page (~600-800 LOC) |
| `client/src/pages/index.ts` | Modified | Export `AdminPage` |
| `client/src/index.jsx` | Modified | Register `/admin` route in both shells + import `admin.css` |
| `client/src/hooks/useResearchBrain.ts` or `useAdminReview.ts` | Modified/New | 7 new hooks for admin operations |
| `client/src/components/Sidebar.jsx` | Modified | Add admin nav button gated on role |
| `client/src/styles/admin.css` | New | Admin page styles (~150 LOC) |
| `src/middleware/authResolver.ts` | Reused | No change; `authResolver({ required: true, role: "admin" })` is the gate |
| Tests | New | 25-30 hermetic cases across service, route, hook, component |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Admin page LOC exceeds 400-line PR budget | Medium | Single PR is approved exception (Q5 decision); precedent: `corpus-dashboard` shipped at 1044 LOC. Page is large because of three sub-tabs, not gold-plating. |
| Unmerge race condition (two admins unmerge the same edge) | Low | `WHERE is_active = true` on the UPDATE acts as a CAS guard; second writer sees 0 rows affected and returns 409. |
| Stats endpoint becomes slow with corpus growth | Low | Q3 decision: no caching in v1; revisit if `COUNT(*)` exceeds 50ms in production. Indexes on `resolution_status` and `created_at` are in place. |
| Admin nav leaks to non-admin users | Low | `useAdmin()` reads JWT `claims.role`; API independently enforces `authResolver({ role: "admin" })` and 403s. Defense in depth. |
| Soft-delete edge grows unboundedly | Low | Periodic job (PR #2 or later) marks edges `is_active=false` older than 90 days as "archived"; not blocking v1. |
| User types a long reason in unmerge textarea and expects it to be required | Low | Q1 decision: textarea is OPTIONAL by design; only the dropdown category is required. UI shows a helper "Detail is optional" under the textarea. |

## Rollback Plan

1. **Frontend disable** — remove the `/admin` route mount in `client/src/index.jsx` and the sidebar nav button in `Sidebar.jsx`. Two-line revert. Backend routes stay but are unreachable.
2. **Backend disable** — leave routes registered but add an `if (!isAdmin) return 403` short-circuit at the top of each new handler (already present). No data is lost.
3. **Schema preserve** — `dedup_audit` rows are append-only; soft-delete columns on `fact_edges` are additive and default-safe. `is_active=true` is the default for new edges; existing edges get `is_active=true` via the `DEFAULT true` clause on backfill.
4. **Destructive rollback** (only if the unmerge semantic turns out to be wrong) — drop the `is_active`/`unmerged_at`/`unmerged_by` columns and the `dedup_audit` table; no downstream schema dependencies. Unmerge UI is removed with the routes.

## Dependencies

- Existing `research_bioprospecting_contradictions` table (migration `20260610000000`) — has `resolution_status` and `resolved_at` columns
- Existing `research_bioprospecting_fact_edges` table (migration `20260610060000`) — base edge table to be extended with soft-delete columns
- `authResolver({ required: true, role: "admin" })` middleware in `src/middleware/authResolver.ts:334-353`
- `getDuplicateGroup(factId)` in `src/services/researchBrain/db.ts:863` — reused for group detail
- `EvidenceLightbox` component from `ResearchBrainPage` — reused for fact provenance drill-down
- JWT `claims.role` decoding on the client (existing pattern)

## Locked Decisions (reference)

1. **Q1 unmerge semantic**: soft-delete edge with `is_active BOOL`, `unmerged_at TIMESTAMPTZ`, `unmerged_by TEXT` — preserves reversibility, leaves identity index untouched.
2. **Q1 unmerge reason UI**: dropdown (required) with values `false_positive` | `different_compound` | `measurement_error` | `other` + free textarea (optional) for detail.
3. **Q2 admin gate**: JWT `role === "admin"` for both API (`authResolver({ role: "admin" })`) and sidebar nav (`useAdmin()` hook).
4. **Q3 stats perf**: no caching, simple `COUNT(*)` queries with the existing `resolution_status` index.
5. **Q4 pagination**: 50/page default with offset pagination.
6. **Q5 PR split**: single PR for PR #1 (this change); PR #2 is the deferred compound authority admin tab.
7. **Q6 deferred (PR #2)**: compound authority admin tab + "Failed compounds" link in `ResearchBrainPage`'s review tab.
8. **Q1 (this turn) unmerge reason UI**: dropdown + textarea (encoded in #2 above).
9. **Q2 (this turn) Dedup tab default window**: `last7d`, matches the Stats `last7d` bucket.
10. **Q3 (this turn) Contras bulk resolve**: per-row checkbox + "Resolve selected" / "Dismiss selected" buttons (no master "resolve all visible" button).
11. **Q4 (this turn) Stats card shape**: Contras + Dedup in the same card, `{ today: { found, resolved, dismissed, pending, merges, unmerges }, last7d: { ... } }`.

## Success Criteria

- [ ] `research_bioprospecting_dedup_audit` table created with correct schema
- [ ] 3 soft-delete columns added to `research_bioprospecting_fact_edges`
- [ ] 4 new admin routes registered: contradictions list, contradictions stats, dedup events, dedup unmerge
- [ ] `AdminPage.tsx` mounted at `/admin` in both shells with 3 sub-tabs (Contras, Dedup, Stats)
- [ ] Unmerge dialog enforces dropdown-required, textarea-optional
- [ ] Contras tab bulk resolve works for N selected rows with optimistic UI and per-row rollback on partial failure
- [ ] Dedup tab defaults to `last7d` window; window selector changes the `since` param
- [ ] Stats card renders `{ today, last7d } × { found, resolved, dismissed, pending, merges, unmerges }`
- [ ] Sidebar shows "Admin" nav button only when JWT role is `admin`
- [ ] All non-admin callers receive 403 from the 4 new routes
- [ ] 25-30 hermetic tests pass
- [ ] LOC stays within 1100-1400 (frontend ~700, backend ~350, tests ~250)
- [ ] Compound authority tab is NOT in this PR (deferred to PR #2)
