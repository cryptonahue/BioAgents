# Design: Bioprospecting Review UI

## Technical Approach

Two-track delivery: (1) a thin backend layer that exposes the existing contradiction and dedup data through 4 admin-only routes plus 2 service helpers, and (2) a self-contained `AdminPage.tsx` with three sub-tabs that talks to those routes. The change reuses the existing `authResolver({ role: "admin" })` gate (no new auth), the existing `ResearchBrainPage` patterns for the lightbox/table styles, and a soft-delete (`is_active` flag) on `fact_edges` so the unmerge is reversible without touching the `identity_key` partial unique index. The two migrations are additive and idempotent (`ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`). LOC target ~1100-1400 (frontend ~700, backend ~350, tests ~250) — single PR (Q5 exception, per proposal: `corpus-dashboard` shipped at 1044 LOC precedent).

## Architecture Decisions

### Decision: Soft-delete edge rows instead of hard delete

| Option | Tradeoff | Decision |
|---|---|---|
| (a) Soft-delete via `is_active = false` | Reversible; `identity_key` partial index untouched; preserves `merged_into_fact_id` cache | **Chosen** |
| (b) Hard-delete + re-canonicalize | Destructive; risks breaking search filters that walk the edge table | Rejected |
| (c) Manual fact edit + new merge | Worst UX; operator must understand identity-key semantics | Rejected |

**Rationale**: The partial unique index on `identity_key` is the *correctness* guard. Soft-deleting the edge row keeps that index intact so the previously-merged fact remains eligible to re-merge via the normal inline path. The `merged_into_fact_id` cache stays populated (a future reconciliation job can sweep stale rows). See proposal §1.

### Decision: One stats query with FILTER clauses, not 6 small queries

| Option | Tradeoff | Decision |
|---|---|---|
| (a) Single SQL with 6 `COUNT(*) FILTER (WHERE ...)` | 1 round-trip; 8 metrics total (2 windows × 4 contras) for the contras side; Supabase JS exposes it via `.rpc()` | **Chosen** |
| (b) 8 separate `COUNT(*)` queries | Simpler JS; 8 round-trips per stats card render | Rejected |
| (c) 2 separate CTEs (contradictions vs edges) | Best of both; 2 round-trips | Rejected (over-engineering for v1) |

**Rationale**: Supabase's `.from('view').select('...')` cannot express `COUNT(*) FILTER`. The 4 contras metrics are best served by a single `rpc()` call against a Postgres function `get_contradiction_stats(windows interval[])`. The 2 dedup metrics come from the existing `fact_edges` table (cheaper, simpler). Total: **2 round-trips** for the stats endpoint. Migration adds the function as `SECURITY DEFINER` and grants `EXECUTE` to `service_role` only (the route uses `getServiceClient()`).

### Decision: Unmerge CAS guard via `WHERE is_active = true`

```sql
UPDATE research_bioprospecting_fact_edges
SET is_active = false, unmerged_at = NOW(), unmerged_by = $1
WHERE merged_fact_id = $2 AND is_active = true
RETURNING canonical_fact_id, match_rule, merged_at;
```

- 0 rows updated → `NoActiveEdgeError` → 409
- 1 row updated → fetch audit details, insert audit row in same tx
- 2+ rows updated → defensive `AmbiguousEdgeError` → 409 (shouldn't happen, schema permits it)
- The `WHERE is_active = true` clause is the compare-and-set guard: a second concurrent unmerge sees zero rows and 409s.

### Decision: New `src/services/researchBrain/reviewService.ts` for read-side helpers

| Option | Tradeoff | Decision |
|---|---|---|
| (a) New `reviewService.ts` file | Single concern (admin review); ~200 LOC; clean separation | **Chosen** |
| (b) Add to `contradictionDb.ts` + `db.ts` | Less new code; mixed concerns | Rejected |
| (c) Add to routes directly | Logic in route layer; harder to test | Rejected |

**Rationale**: The new helpers (`listContradictionsGlobal`, `getContradictionStats`, `listRecentMergeEvents`, `unmergeFact`) are admin-review-specific and have no callers outside this change. A new file keeps the diff clean. The helpers re-export from `db.ts` / `contradictionDb.ts` so existing tests are unaffected.

### Decision: Frontend tabs in a single `AdminPage.tsx` file

| Option | Tradeoff | Decision |
|---|---|---|
| (a) Single `AdminPage.tsx` with 3 co-located sub-components (~200 LOC each) | One file to review; shared layout; no prop drilling | **Chosen** |
| (b) 3 separate files | Cleaner per-tab ownership; more files; tab state lifted to a context | Rejected |
| (c) One file with a single mega-component | Hard to review, no sub-component isolation | Rejected |

**Rationale**: The 3 tabs share tab state, role-gating, and the toast/error surface. Sub-components accept a shared `adminApi` object plus a `useAdmin()` role-check. The file lands at ~700-800 LOC (within the 400-line PR budget exception documented in proposal Q5).

### Decision: New `client/src/styles/admin.css`, not extending `corpus.css`

| Option | Tradeoff | Decision |
|---|---|---|
| (a) New `admin.css` (~150 LOC) | Separation of concerns; clear ownership | **Chosen** |
| (b) Extend `corpus.css` | One fewer file; but `corpus.css` is 385 LOC and growing | Rejected |
| (c) Reuse `corpus.css` class names | Couples the two pages; refactor risk | Rejected |

**Rationale**: `corpus.css` already has its own design system; the admin page reuses its CSS variables (color tokens, spacing) but introduces tab-specific styles that don't belong in a corpus-dashboard file. Imported once in `client/src/index.jsx`.

### Decision: Bulk resolve is N×single-call (not a new bulk endpoint)

| Option | Tradeoff | Decision |
|---|---|---|
| (a) Client-side N×`POST /contradictions/:id/resolve` with `Promise.allSettled` | Reuses existing per-row route; per-row rollback is trivial | **Chosen** |
| (b) New `POST /contradictions/bulk-resolve` | 1 round-trip; needs new validation/error contract; partial-failure semantics | Rejected for v1 |
| (c) Optimistic only, no rollback | Worst UX on failure | Rejected |

**Rationale**: The existing `POST /api/research-brain/contradictions/:id/resolve` is idempotent and well-tested. A bulk endpoint duplicates its validation and error mapping for marginal latency gain. `Promise.allSettled` lets the UI revert the failed row(s) and surface a per-row toast without a new server contract.

### Decision: Pagination cursor vs offset

| Option | Tradeoff | Decision |
|---|---|---|
| (a) Offset/limit, 50/page, max 200 | Simple; admin lists are low-volume; deep paging is OK | **Chosen for v1** |
| (b) Cursor (keyset) | Better for very large tables; needs composite cursor | Deferred (PR #2 if needed) |

**Rationale**: Admin pages render at most a few hundred rows; offset is fine. Spec mandates 50/default, 200/max — both route layer and client hook hard-code the same numbers.

### Decision: Stats response shape — Contras + Dedup in one card

```typescript
type StatsWindow = {
  found: number;      // contradictions created_at >= window
  resolved: number;   // contradictions resolved_at >= window AND status='resolved'
  dismissed: number;  // contradictions resolved_at >= window AND status='dismissed'
  pending: number;    // max(0, found - resolved - dismissed) — clamped
  merges: number;     // fact_edges WHERE merged_at >= window AND is_active = true
  unmerges: number;   // fact_edges WHERE unmerged_at >= window
};
type StatsResponse = { today: StatsWindow; last7d: StatsWindow };
```

**Rationale**: Operator's "what needs my attention?" question spans both systems (Q4 decision). The card is a 2×6 grid (2 windows × 6 metrics). `pending` is computed in code after the SQL aggregation and clamped to `0` (clock-skew defense, spec scenario).

## Data Flow

### Unmerge flow

```
[Operator clicks "Unmerge"]                            [Operator selects "Different compound"]
        │                                                       │
        ▼                                                       ▼
[AdminPage: open dialog]  ──►  [Fill reasonCode, reasonDetail]  ──►  [Click "Unmerge" button]
        │                                                       │
        ▼                                                       ▼
[useUnmergeFact().mutate({ factId, reasonCode, reasonDetail })]
        │
        ▼
[POST /api/research-brain/dedup/:factId/unmerge] ──► [authResolver({ role: "admin" })]
        │                                                       │
        │                                                       ▼
        │                                          [reviewService.unmergeFact()]
        │                                                       │
        │                                                       ▼
        │                                          [BEGIN TRANSACTION]
        │                                                       │
        │                                          ┌────────────┴────────────┐
        │                                          ▼                         ▼
        │                                  [UPDATE edge row            [INSERT INTO
        │                                   WHERE is_active=true]       dedup_audit]
        │                                          │                         │
        │                                          └────────────┬────────────┘
        │                                                       ▼
        │                                          [COMMIT / ROLLBACK]
        │                                                       │
        │                                                       ▼
        │                                          [Return { edge, audit }]
        ▼
[Toast "Unmerged" / inline error on 4xx/5xx]
```

### Stats query plan

```
[GET /api/research-brain/contradictions/stats]
        │
        ▼
[authResolver({ role: "admin" })]
        │
        ▼
[contradictionDb.getContradictionStats()]
        │
        ├──► supabase.rpc("get_contradiction_stats", { window_1d: "1 day", window_7d: "7 days" })
        │         │
        │         ▼
        │    [SELECT COUNT(*) FILTER (WHERE ...),
        │            COUNT(*) FILTER (WHERE resolution_status='resolved' AND resolved_at >= ...),
        │            COUNT(*) FILTER (WHERE resolution_status='dismissed' AND resolved_at >= ...),
        │            COUNT(*) AS found
        │     FROM research_bioprospecting_contradictions
        │     WHERE created_at >= NOW() - window_1d OR created_at >= NOW() - window_7d]
        │         │
        │         ▼
        │    [{ window: "1d", found: 12, resolved: 3, dismissed: 1 },
        │     { window: "7d", found: 124, resolved: 38, dismissed: 12 }]
        │
        └──► supabase.from("research_bioprospecting_fact_edges")
                  .select("merged_at, unmerged_at, is_active", { count: "exact", head: false })
                  .gte("merged_at", "NOW() - INTERVAL '7 days'")
                  │
                  ▼
            [{ ... }, { ... }]  (rows counted in JS — merges = is_active && merged_at; unmerges = unmerged_at)
        │
        ▼
[Return { today: { found, resolved, dismissed, pending, merges, unmerges },
          last7d: { ... } }]
```

**Note**: The contras RPC returns 6 rows (3 metrics × 2 windows) and the edges query returns the rowset for in-JS counting. Total: **2 round-trips**. The `pending` field is computed in code as `max(0, found - resolved - dismissed)`.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `supabase/migrations/20260616000000_create_dedup_audit.sql` | Create | New `research_bioprospecting_dedup_audit` table (~25 LOC). Mirrors `compound_authority_audit` minus partitioning (not insert-heavy enough to need it). |
| `supabase/migrations/20260616000100_dedup_edge_soft_delete.sql` | Create | 3 columns on `fact_edges` + 1 partial index (~10 LOC). Idempotent `ADD COLUMN IF NOT EXISTS`. |
| `supabase/migrations/20260616000200_get_contradiction_stats_rpc.sql` | Create | Postgres function `get_contradiction_stats()` returning 6 rows (3 metrics × 2 windows) via `COUNT(*) FILTER`. ~20 LOC. |
| `src/services/researchBrain/reviewService.ts` | Create | New file. 4 exported helpers: `listContradictionsGlobal`, `getContradictionStats`, `listRecentMergeEvents`, `unmergeFact`. Re-exports existing `getDuplicateGroup` for the group-detail call. ~200 LOC. |
| `src/services/researchBrain/index.ts` | Modify | Add `export * from "./reviewService"`. |
| `src/services/researchBrain/db.ts` | Modify | Add `WHERE is_active = true` to the edge reads in `findMergedFactIds` and `getDuplicateGroup` (1 line each, per spec scenario). |
| `src/services/researchBrain/contradictionDb.ts` | Modify | No file changes — helpers are in the new `reviewService.ts` to keep concerns separate. |
| `src/services/researchBrain/types.ts` | Modify | Add `StatsWindow`, `StatsResponse`, `RecentDedupEvent`, `UnmergeRequest`, `UnmergeResponse` types. ~30 LOC. |
| `src/routes/research-brain.ts` | Modify | Add 4 new routes (`GET /contradictions`, `GET /contradictions/stats`, `GET /dedup/events`, `POST /dedup/:factId/unmerge`). ~150 LOC. |
| `client/src/pages/AdminPage.tsx` | Create | 3-tab admin page with co-located sub-components. ~700-800 LOC. |
| `client/src/pages/index.ts` | Modify | Add `export { AdminPage } from './AdminPage'`. |
| `client/src/index.jsx` | Modify | Import `./styles/admin.css`; add `<AdminPage path="/admin" />` to `LegacyAppShell` and `CoralAppShell` routers. ~5 LOC. |
| `client/src/components/Sidebar.jsx` | Modify | Add admin nav button gated on `useAdmin()`. ~15 LOC. |
| `client/src/hooks/useAdminReview.ts` | Create | 7 new hooks: `useAdminContradictions`, `useResolveContradiction`, `useBulkResolveContradictions`, `useDedupEvents`, `useDedupGroup`, `useUnmergeFact`, `useAdminStats`. ~250 LOC. |
| `client/src/styles/admin.css` | Create | New stylesheet mirroring `corpus.css` patterns. ~150 LOC. |
| `client/src/hooks/useAdmin.ts` | Create | Shared role-check hook reading JWT `claims.role`. ~30 LOC. |
| `src/services/researchBrain/__tests__/reviewService.test.ts` | Create | Service-level tests for all 4 helpers (~150 LOC, 12 cases). |
| `src/routes/__tests__/adminRoutes.test.ts` | Create | Route-level tests: status/sourceId filters, 401/403, 409 on double-unmerge (~80 LOC, 8 cases). |
| `client/src/hooks/__tests__/useAdminReview.test.ts` | Create | Hook-level tests: bulk resolve partial-failure rollback (~50 LOC, 3 cases). |
| `client/src/pages/__tests__/AdminPage.test.tsx` | Create | Component-level tests: tab switching, unmerge dialog validation (~30 LOC, 2 cases). |

**Total LOC estimate**: ~1100-1400 (frontend ~700, backend ~350, tests ~250).

## Interfaces / Contracts

### Route contracts

```typescript
// GET /api/research-brain/contradictions?status=&sourceId=&limit=50&offset=0
// auth: required, role=admin
// 200: { contradictions: Contradiction[], total: number, limit: number, offset: number }
// 400: invalid limit/offset
// 401/403: auth

// GET /api/research-brain/contradictions/stats
// auth: required, role=admin
// 200: { today: StatsWindow, last7d: StatsWindow }
// 401/403: auth

// GET /api/research-brain/dedup/events?limit=50&offset=0&since=7d
// auth: required, role=admin
// 200: { events: RecentDedupEvent[] }
// 401/403: auth

// POST /api/research-brain/dedup/:factId/unmerge
// body: { reasonCode: 'false_positive'|'different_compound'|'measurement_error'|'other',
//         reasonDetail?: string }
// 200: { edge: UpdatedEdge, audit: AuditRow }
// 400: invalid reasonCode
// 404: fact not found
// 409: no active edge (already unmerged or ambiguous multi-edge)
// 401/403: auth
```

### Service helpers

```typescript
// reviewService.ts
export async function listContradictionsGlobal(params: {
  status?: "unresolved" | "resolved" | "dismissed";
  sourceId?: string;
  limit: number;   // 1-200, default 50
  offset: number;  // >= 0, default 0
}): Promise<{
  rows: ResearchBioprospectingContradiction[];
  total: number;
  limit: number;
  offset: number;
}>;

export async function getContradictionStats(): Promise<{
  today: StatsWindow;
  last7d: StatsWindow;
}>;

export async function listRecentMergeEvents(params: {
  limit: number;
  offset: number;
  since: "24h" | "7d" | "30d" | "all";
}): Promise<{ events: RecentDedupEvent[] }>;

export class NoActiveEdgeError extends Error {}
export class AmbiguousEdgeError extends Error {}
export class InvalidReasonCategoryError extends Error {}
export class FactNotFoundError extends Error {}

export async function unmergeFact(params: {
  factId: string;
  userId: string;
  reason: string | null;
  reasonCategory: "false_positive" | "different_compound" | "measurement_error" | "other";
}): Promise<{ edge: UpdatedEdge; audit: AuditRow }>;
```

### Stats response

```typescript
export type StatsWindow = {
  found: number;       // non-negative integer
  resolved: number;    // non-negative integer
  dismissed: number;   // non-negative integer
  pending: number;     // max(0, found - resolved - dismissed)
  merges: number;      // active merges in window
  unmerges: number;    // unmerges in window
};

export type StatsResponse = {
  today: StatsWindow;
  last7d: StatsWindow;
};
```

### Recent dedup event

```typescript
export type RecentDedupEvent = {
  eventId: string;          // composite: edge row PK
  factId: string;           // the merged_fact_id
  canonicalId: string;      // the canonical_fact_id
  mergedFactId: string;     // = factId
  matchRule: "identity_key" | "embedding";
  mergedAt: string;         // ISO8601
  unmergedAt: string | null;
  unmergedBy: string | null;
  isActive: boolean;
  reasonCode: "false_positive" | "different_compound" | "measurement_error" | "other" | null;
  reasonDetail: string | null;
};
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| **Unit (service)** | `unmergeFact` happy path, idempotency on double-unmerge, `NoActiveEdgeError` on missing fact, `AmbiguousEdgeError` on multi-edge, `listRecentMergeEvents` pagination, `listContradictionsGlobal` status/sourceId filters, `getContradictionStats` `pending` clamping | `bun test src/services/researchBrain/__tests__/reviewService.test.ts` (12 cases) |
| **Unit (lineage)** | `getDuplicateGroup` returns `null` for unmerged edge; `findMergedFactIds` excludes unmerged facts | Extend `src/services/researchBrain/__tests__/dedup.test.ts` (2 cases) |
| **Integration (route)** | 4 new routes: 200 happy path, 400 on invalid params, 401/403 on missing/wrong role, 409 on double-unmerge, 404 on missing fact | `bun test src/routes/__tests__/adminRoutes.test.ts` (8 cases) |
| **Hook** | `useAdminContradictions` fetch + cache; `useBulkResolveContradictions` partial-failure rollback (1 of 3 fails); `useUnmergeFact` fires with reason payload | `bun test client/src/hooks/__tests__/useAdminReview.test.ts` (3 cases) |
| **Component** | `AdminPage` tab switching (contras → dedup → stats); unmerge dialog submit-disabled-when-empty | `bun test client/src/pages/__tests__/AdminPage.test.tsx` (2 cases) |
| **DB migration** | Idempotency: re-running migrations on a populated DB is a no-op | Manual `psql` smoke test (not in unit suite) |

**Total test count**: ~27 cases (within spec's 25-30 target).

## Migration / Rollout

1. **Schema migration** (3 new files, run in order):
   - `20260616000000_create_dedup_audit.sql` — creates `research_bioprospecting_dedup_audit` table + 3 indexes.
   - `20260616000100_dedup_edge_soft_delete.sql` — adds `is_active`, `unmerged_at`, `unmerged_by` columns to `fact_edges` (all `IF NOT EXISTS`); creates `idx_dedup_edge_active_canonical` index.
   - `20260616000200_get_contradiction_stats_rpc.sql` — creates `get_contradiction_stats(_1d interval, _7d interval)` SECURITY DEFINER function; grants `EXECUTE` to `service_role`.

2. **Backwards compatibility**:
   - `is_active` defaults to `TRUE`; existing rows backfill automatically (PostgreSQL 11+ `ADD COLUMN ... NOT NULL DEFAULT`).
   - Existing `identity_key` partial unique index is untouched.
   - Inline merge in `replaceBioprospectingFactsForSource` (db.ts) does NOT need changes — new edges inherit `is_active = true` via the `DEFAULT`.
   - The two lineage helpers (`getDuplicateGroup`, `findMergedFactIds`) get one `WHERE is_active = true` line each; pre-delta behavior is preserved for active edges.

3. **Rollout steps**:
   - Merge PR (single, ~1100-1400 LOC).
   - Deploy migrations first (idempotent, no app dependency).
   - Deploy backend (new routes inert until frontend calls them).
   - Deploy frontend (admin nav button appears for `role: "admin"` users).
   - Smoke test: admin opens `/admin`, switches tabs, resolves 1 contradiction, unmerges 1 fact with reason, refreshes page.

4. **Rollback plan** (per proposal):
   - **Frontend disable**: remove `<AdminPage path="/admin" />` from both routers; remove sidebar nav button. Two-line revert.
   - **Backend disable**: routes remain registered but admin-gated; non-admin callers get 403.
   - **Schema preserve**: `dedup_audit` rows are append-only; `is_active` columns are additive. No destructive rollback needed in v1.
   - **Destructive rollback** (only if unmerge semantic is wrong): drop `is_active`/`unmerged_at`/`unmerged_by` columns and `dedup_audit` table; no downstream schema dependencies.

## Open Questions

- **Q1**: Should the stats RPC also return `merges`/`unmerges` so the route can stay at 1 round-trip? Trade-off: the RPC becomes a bigger function with mixed metrics; current 2-round-trip design is cleaner. **Decision pending**: 2 round-trips is the v1 default; revisit if the stats card latency exceeds 100ms in production.
- **Q2**: Does the `compound_authority_audit` pattern (monthly partitioning) need to be mirrored for `dedup_audit`? Trade-off: dedup_audit has a single write path (unmerge button, low volume); partitioning is overkill. **Decision pending**: not partitioned in v1; revisit if dedup_audit grows past 100k rows.
- **Q3**: The `useBulkResolveContradictions` hook's `Promise.allSettled` pattern has no per-request batching limit. Should we cap at 50 resolves per bulk action to match the page size? **Decision pending**: cap at 50 in the hook to keep UX consistent (operator selects 50 → click button → 50 parallel calls). Anything more is a separate "Resolve page" UX.
- **Q4**: The `is_active` partial index on `fact_edges(canonical_fact_id, is_active)` — should it be a `UNIQUE` index? **Decision pending**: NO. The composite PK `(canonical_fact_id, merged_fact_id)` is the uniqueness guard; partial index is read-side only. A `UNIQUE` partial index would reject legitimate re-merge paths.

All four open questions are non-blocking — the design can proceed with the v1 defaults documented above.
