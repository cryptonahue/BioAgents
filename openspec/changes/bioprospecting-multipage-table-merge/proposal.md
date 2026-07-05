# Proposal: bioprospecting-multipage-table-merge

## Intent

Multi-page tables in bioprospecting PDFs are currently persisted as N
independent rows in `research_evidence_tables`. The downstream chain
breaks: the LLM extractor sees N unrelated `tables:` blocks, the
`identity_key` dedup produces two clusters for one logical table, the
viewer shows N disjoint bboxes with no navigation, and the quality gate
counts fragments as separate tables (can spuriously trigger
`low_table_count`).

This change ships a **detector merge + defensive prompt chain walk**
behind a configurable merge mode, so a 50-row table that spans pages
5-6-7 is one logical entity to the LLM and the user, with a navigation
affordance in the viewer.

## Scope

### Modified capability: `pdf-table-extraction`

New requirement **`Multi-Page Table Continuation`** with these
sub-requirements:

#### continues_from_id self-FK

Add a nullable self-FK to `research_evidence_tables`; the head of a
chain is `NULL`, every tail fragment points to the previous fragment's
id. `(source_id, page, table_index)` uniqueness is unchanged. `bbox`
is unchanged. Read-time chain walk is an application concern.

#### research_evidence_table_merges_override (v1: per-pair only)

New table for admin overrides. **v1 scope is per-pair only** — the
`override_mode` (per-source mode pin) row is deferred to v2 (YAGNI).

```sql
CREATE TABLE IF NOT EXISTS public.research_evidence_table_merges_override (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES public.research_sources(id) ON DELETE CASCADE,
  table_id UUID NOT NULL REFERENCES public.research_evidence_tables(id) ON DELETE CASCADE,
  other_table_id UUID NOT NULL REFERENCES public.research_evidence_tables(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('force_merge', 'force_unmerge')),
  confidence_score NUMERIC(4,3) CHECK (confidence_score >= 0 AND confidence_score <= 1),
  reason TEXT NOT NULL,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### 3-tier merge mode (env-configurable)

`TABLE_MERGE_MODE` env var (default `hard-confidence`),
`TABLE_MERGE_THRESHOLD` env var (default `0.7`).

| Mode              | Behavior                                                                       |
| ----------------- | ------------------------------------------------------------------------------ |
| `hard`            | Merge iff (no `Table N.` prefix on T₂) AND headers match (case/whitespace).    |
| `hard-confidence` | Score 0-1 weighted by 4 signals; merge iff score > `TABLE_MERGE_THRESHOLD`.    |
| `manual`          | Detector never merges. Only admin overrides create FK links.                   |

`hard-confidence` signals:

| Signal                                       | Weight |
| -------------------------------------------- | ------ |
| Header match (normalized)                    | 0.4    |
| Column count match                           | 0.2    |
| X-anchor alignment ≤ 4pt (`X_TOLERANCE_PT`)  | 0.2    |
| Page distance = 1 + same `tableIndex`        | 0.2    |

**Negative signal** (score forced to 0): T₂'s first row matches
`/^Table\s+\d+\.?/i`.

### New API routes (admin)

All three guarded by `authResolver({ required: true, role: 'admin' })`
(established pattern in `compound-authority`).

- `POST /api/research-brain/tables/:tableId/merge-with/:otherTableId`
  — body `{ reason, confidence_score? }`. Writes `force_merge` override
  and updates the FK. Idempotent.
- `DELETE /api/research-brain/tables/:tableId/merge-override` —
  removes any override involving the table and clears the FK on the
  chain tail.
- `GET /api/research-brain/tables/:tableId/merges` — returns ranked
  candidate merges for the source (used by the future admin UI).

### New detector helper

`src/services/files/providers/localPdfTableProvider.ts` exports
`mergeTablesAcrossPages(tables, mode)` and
`scoreMergeCandidate(t1, t2)`. Pure function; runs as a post-pass
after the per-page loop. The orchestrator signature is unchanged.

### Defensive prompt builder chain walk

`buildTablesPromptSection` walks the `continuesFromId` chain at LLM
prompt construction time and emits a single `tables:` block per chain
with sub-markers per fragment. **Defensive merging also fires** when
`continuesFromId` is NULL but two adjacent fragments match the `hard`
heuristic — the LLM gets a unified view even on already-cached rows
that pre-date the FK.

### Viewer: Part X of N badge + pager

`EvidenceLightbox` and `ViewerPage` gain a "Part X of N" badge and a
next/prev pager. Auto-follow scroll is opt-in (default **OFF**) with
a clear toggle on the badge — no surprise auto-scroll.

### Backfill script

`scripts/merge-multipage-tables.ts`. Idempotent, dry-run by default.
**Incremental: skips sources that already have at least one chain.**
Apply mode writes FK + override rows.

## Out of scope (deferred)

- Widening `bbox` to a JSONB array (Option B from exploration).
- Mistral-side merge pass; the defensive prompt walk unifies the LLM
  view regardless of provider.
- Per-source mode override (`override_mode` row) — v2 YAGNI.
- Frontend admin UI for the 3 new routes.
- "Body-row cell-value continuity" heuristic (case 4 split).

## Approach summary

```
Local provider per-page loop
        ↓
mergeTablesAcrossPages(tables, mode)   ← detector-side
        ↓
ExtractedTable[] with continuesFromId
        ↓
persistExtractedTables                 ← unchanged signature
        ↓
research_evidence_tables (FK chain)
        ↓
buildTablesPromptSection               ← chain walk + defensive
        ↓
LLM sees unified tables: block
        ↓
Viewer: Part X of N badge + opt-in auto-scroll
```

## PR split (3 chained PRs, ~770 LOC total)

| PR  | Scope                                                            | ~LOC |
| --- | ---------------------------------------------------------------- | ---- |
| #1  | Migration (`continues_from_id` + override table) + detector: `mergeTablesAcrossPages`, `scoreMergeCandidate` + detector unit tests | ~270 |
| #2  | Prompt chain walk + defensive merge + viewer badge/pager + opt-in auto-scroll + backfill script + integration tests | ~340 |
| #3  | 3 admin API routes (`POST merge-with`, `DELETE merge-override`, `GET merges`) + admin auth + override table tests | ~160 |

Each slice has a clear start, finish, autonomous scope, verification,
and rollback. No cross-slice schema dependency (PR #1 owns the
migration; #2 and #3 add code against it).

## Affected areas

| Area | Impact | Description |
| --- | --- | --- |
| `src/services/files/providers/localPdfTableProvider.ts` | Modified | New `mergeTablesAcrossPages` + `scoreMergeCandidate` post-pass. |
| `src/services/files/pdfTableExtractor.ts` | Modified | Extend `ExtractedTable` with `continuesFromId`; pass through persist. |
| `src/services/files/pdfTablePromptBuilder.ts` | Modified | Chain walk + defensive merge in `buildTablesPromptSection`. |
| `src/services/files/qualityGate.ts` | Modified | Count chain heads as 1 for `low_table_count`. |
| `supabase/migrations/<date>_multipage_table_merge.sql` | New | `continues_from_id` column + override table + indexes. |
| `src/routes/admin/table-merges.ts` | New | 3 admin routes, `authResolver({ required: true, role: 'admin' })`. |
| `scripts/merge-multipage-tables.ts` | New | Incremental, dry-run-first backfill. |
| `client/src/components/EvidenceLightbox.tsx` | Modified | Part X of N badge, pager, opt-in auto-scroll toggle. |
| `client/src/pages/ViewerPage.tsx` | Modified | Wire badge into the table list. |
| `openspec/specs/pdf-table-extraction/spec.md` | Modified | Add `Multi-Page Table Continuation` requirement. |

## Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| False-positive merges on consecutive pages with matching columns | Med | `Table N.` prefix negative signal + threshold + admin override escape hatch. |
| 3+ page chains not handled by pair-wise merge | Low | Detector chain-walks; integration test fixture for 5-page chain. |
| Cached rows from prior PR have no FK | High (already known) | Defensive prompt walk merges at prompt time regardless of FK. |
| Mistral rows lack FK chain | Med | Defensive prompt walk unifies LLM view; DB FK is best-effort for Mistral. |
| 400-line review budget exceeded | High | Locked 3-PR chained split (table above). |

## Rollback plan

- **PR #1**: drop the migration; detector returns to no-merge behavior
  (env not set ⇒ merge is opt-in anyway, but PR #1 defaults to
  `hard-confidence` at 0.7 — revert is a single env rollback to
  `TABLE_MERGE_MODE=manual` until the migration is dropped).
- **PR #2**: prompt chain walk is additive on a code path already
  conditional on having fragments — guard with a `TABLE_MERGE_ENABLED`
  feature flag for instant disable; viewer badge is a pure render
  change, revert the file.
- **PR #3**: admin routes are additive; remove the route file and
  drop `force_merge` override rows.

## Success criteria

- [ ] A PDF with a table spanning pages 5-6-7 produces one
  `continues_from_id` chain in `research_evidence_tables` (default
  `hard-confidence` mode, threshold 0.7).
- [ ] LLM prompt for that source contains a single `tables:` block
  per chain with per-fragment sub-markers.
- [ ] Viewer shows "Part X of N" badge and pager; auto-scroll toggle
  is OFF by default.
- [ ] Admin can `force_merge` a missed link via the new route; the
  override is persisted and respected on next extraction.
- [ ] Backfill script dry-run lists detected links; `--apply` writes
  them; re-runs are no-ops.
- [ ] With `TABLE_MERGE_MODE=manual`, the detector writes zero FK
  links; only admin overrides create them.
- [ ] The change ships as 3 chained PRs, each under the 400-line
  review budget.

## Capabilities contract

### Modified Capabilities

- `pdf-table-extraction`: adds a `Multi-Page Table Continuation`
  requirement (schema delta on `research_evidence_tables` + new
  `research_evidence_table_merges_override` table + detector merge
  helper + prompt chain walk + viewer badge).

### New Capabilities

- None. The admin API and the override table are part of the
  `pdf-table-extraction` capability delta (single domain).

## Resolved decisions (locked by orchestrator)

1. Admin auth: `authResolver({ required: true, role: 'admin' })`.
2. Threshold: env `TABLE_MERGE_THRESHOLD` (default 0.7).
3. Backfill re-runs: incremental (skip sources with existing chains).
4. Auto-scroll default: OFF, opt-in.
5. Override scope: v1 per-pair only; per-source mode pin deferred to v2.
6. PR split: 3 chained PRs (schema+detector / prompt+viewer+backfill / admin API).
