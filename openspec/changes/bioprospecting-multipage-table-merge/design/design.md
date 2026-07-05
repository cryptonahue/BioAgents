# Design: bioprospecting-multipage-table-merge

## Technical Approach

A two-layer fix for multi-page tables: a **detector-side post-pass** that links
same-`tableIndex` fragments across consecutive pages via a self-FK
(`continues_from_id`), plus a **defensive prompt chain walk** in
`buildTablesPromptSection` that unifies fragments at LLM-prompt time regardless
of whether the detector caught the link. The viewer gains a "Part X of N" badge
with opt-in auto-follow scroll. An admin override table + 3 routes close the
loop for human-in-the-loop corrections.

The detector change is local to `localPdfTableProvider.ts` (a pure post-pass
function added after the per-page loop on lines 109-123). The prompt builder
change is local to `pdfTablePromptBuilder.ts`. The viewer is local to
`EvidenceLightbox.tsx` + `ViewerPage.tsx`. The schema delta is one nullable
self-FK + one new override table. The migration and the detector ship in PR #1;
the prompt walk, viewer, and backfill ship in PR #2; the admin API ships in
PR #3.

This design locks in the spec's `Multi-Page Table Continuation` requirement
plus the `MODIFIED` requirements on `Quality Gate And Fallback` and
`Prompt Injection Of Extracted Tables`.

## Architecture Decisions

### Decision: Detector merge runs as a post-pass on the per-page output

**Choice**: After the per-page loop in `localPdfTableProvider.ts` (lines
109-123) returns a flat `ExtractedTable[]`, run a pure function
`mergeTablesAcrossPages(tables, mode)` that walks consecutive pages and patches
`continuesFromId` on tail fragments. The orchestrator signature is unchanged.

**Alternatives considered**:
- Embed merge logic inside `detectTablesOnPage` (per-page function) — rejected;
  needs cross-page context, so a post-pass is the right boundary.
- Merge at the orchestrator (`pdfTableExtractor.ts`) level — rejected; leaks
  provider logic into the orchestrator and is harder to unit-test (needs
  extracting the pdfjs dependency).
- Merge at persistence time in `persistExtractedTables` — rejected; the merge
  decision needs the in-memory extracted data, not the persisted shape.

**Rationale**: The provider-local boundary is the natural seam (the Mistral
provider will get its own pass later; same shape). The post-pass is a pure
function with no pdfjs dependency, which means the unit tests can drive it
with hand-rolled `ExtractedTable[]` fixtures — same pattern as the existing
`detectTablesOnPage` tests in
`src/services/files/__tests__/localPdfTableProvider.test.ts`.

### Decision: Chain depth capped at 10

**Choice**: `mergeTablesAcrossPages` walks at most 10 consecutive pages
(`MAX_CHAIN_DEPTH = 10`). A chain longer than 10 pages is treated as a single
chain head and a new chain (no further `continuesFromId`).

**Alternatives considered**:
- Unbounded chain walk — rejected; misconfigured `continues_from_id` rows in
  the DB could cause an infinite loop in the prompt walker.
- Cap at 3 (the spec mentions 3+ page chains are rare) — rejected; 5-page
  chains are real (long appendix tables in PMC PDFs) and 3 is too tight.
- Cap at 5 — rejected; not enough headroom for the case 1 fixture.

**Rationale**: 10 covers every observed case with margin and gives the prompt
walker a hard upper bound. The cycle-detection in the prompt walker uses the
same 10-cap as a defensive stop (see Decision below).

### Decision: Score tie-break prefers same `tableIndex`

**Choice**: When two merge candidates have identical scores, prefer the pair
where both fragments have the same `tableIndex`. Ties that still do not
resolve fall back to lower `page` distance, then lower first-fragment `page`.

**Alternatives considered**:
- Prefer same header length — rejected; matching column count (which is
  already a signal) usually means matching header length, so the
  discrimination is weak.
- Random tie-break — rejected; non-determinism makes the merge hard to
  reason about in tests and backfill output.
- No tie-break (return both candidates and let downstream decide) — rejected;
  the function is `ExtractedTable[] → ExtractedTable[]` and must return one
  definitive chain, not a set of options.

**Rationale**: Same `tableIndex` is the strongest prior in real multi-page
PDFs — the local detector's per-page loop already assigns `tableIndex` 0, 1,
2... per page, and multi-page tables almost always carry the same
`tableIndex` across the chain.

### Decision: Per-pair override always wins over detector

**Choice**: Before consulting `scoreMergeCandidate` for any pair (T₁, T₂), the
detector checks the override table for `(T₁, T₂)` or `(T₂, T₁)`. If a row
exists:
- `action = "force_merge"` → write `T₂.continuesFromId = T₁.id` and stop.
- `action = "force_unmerge"` → clear any `T₂.continuesFromId` linking back
  to T₁ and skip this pair.
- Otherwise (no row) → fall through to the mode-driven scorer.

**Alternatives considered**:
- Override only consulted when the detector disagrees (below-threshold score)
  — rejected; the spec scenario "Admin force-merge is respected on
  re-extraction" requires the override to win regardless of score, so the
  detector must consult the override table even when its own score would
  already merge.
- Override consulted at prompt-build time, not detector time — rejected; the
  detector is where the FK is written, so the override must be applied
  before the FK is decided.

**Rationale**: A human-admin override is the authoritative source of truth
for the pair. Per the spec: "the override table takes precedence over
detector output." This decision makes the override precedence
implementation-local, not deferred to a higher layer.

### Decision: Prompt chain walker has cycle detection

**Choice**: `buildTablesPromptSection` builds a `Set<string>` of visited table
ids while walking each `continues_from_id` chain. A repeat-id aborts the walk
for that chain (treats the current node as the head).

**Alternatives considered**:
- Trust the FK to be acyclic and walk without checks — rejected; a bug in
  the backfill script or a malicious admin override could write a cycle.
- Use a recursive CTE in the DB to validate the chain at write time — out
  of scope for v1 (the detector writes are tightly controlled and the
  override API can add a CHECK constraint in v2).

**Rationale**: Cycle detection is a 4-line guard (`if (visited.has(id)) break;
visited.add(id);`). It is cheap insurance against a class of bugs that would
otherwise be silent (the prompt builder hangs in a loop on a buggy chain).

### Decision: Auto-scroll opt-in via badge button, default OFF

**Choice**: Each "Part X of N" badge in the viewer has a small "Follow"
toggle. Default is OFF. Toggling ON causes the next/prev pager buttons to
auto-scroll to the next fragment in the chain after the user clicks one.

**Alternatives considered**:
- Auto-scroll on by default — rejected; surprise scroll is hostile UX.
- Keyboard shortcut (e.g. `Shift+→`) — rejected; the chain fragments are
  rarely long enough to justify a dedicated shortcut, and discoverability is
  low.
- Auto-scroll on every next/prev click (no toggle) — rejected; some users
  navigate between fragments to compare and don't want a forced jump.

**Rationale**: The toggle is a single click on the badge, which is already
where the user is looking when navigating chain fragments. A button on the
table head of each fragment is the right discoverability/permanence
trade-off.

### Decision: Backfill is a CLI script, not a cron worker

**Choice**: `scripts/merge-multipage-tables.ts` is a one-shot CLI matching
the existing pattern in `scripts/normalize-taxonomy.ts`. Invocation:
`bun run scripts/merge-multipage-tables.ts [--apply] [--limit=100]`.

**Alternatives considered**:
- Cron worker on a schedule — rejected; backfill is a one-time operation
  per source. Once a source has a chain, the script skips it. There is no
  need to poll.
- BullMQ job queue — rejected; the script is operator-driven, not
  user-driven, and the existing taxonomy backfill uses the same CLI
  pattern.

**Rationale**: Consistency with `normalize-taxonomy.ts` and
`backfill-dedupe-bioprospecting-facts.ts`. The script reads sources with no
chain, runs the same `mergeTablesAcrossPages` algorithm on their persisted
tables, and writes FKs. Idempotent by construction.

## Data Flow

```
                    ┌──────────────────────────────┐
                    │   localPdfTableProvider.ts   │
                    │      detectTablesOnPage      │
                    │     (per-page, line 113)     │
                    └──────────────┬───────────────┘
                                   │ ExtractedTable[]
                                   │ (one per page×table)
                                   ▼
                    ┌──────────────────────────────┐
                    │  mergeTablesAcrossPages      │
                    │  (NEW post-pass, this PR)    │
                    │                              │
                    │  for each consecutive pair:  │
                    │    1. look up override       │
                    │       (T1,T2) || (T2,T1)     │
                    │    2. if override ⇒ apply    │
                    │    3. else mode-driven:      │
                    │       - hard: 1-2 conditions │
                    │       - hard-conf: scoring   │
                    │       - manual: skip         │
                    │    4. patch T2.continuesFromId│
                    └──────────────┬───────────────┘
                                   │ ExtractedTable[] with
                                   │   continuesFromId set on tails
                                   ▼
                    ┌──────────────────────────────┐
                    │   persistExtractedTables     │
                    │   (unchanged, gains          │
                    │    continuesFromId column)   │
                    └──────────────┬───────────────┘
                                   │ INSERT with new column
                                   ▼
                    ┌──────────────────────────────┐
                    │  research_evidence_tables    │
                    │  (id, source_id, page,       │
                    │   table_index, headers,      │
                    │   rows, bbox, ...            │
                    │   continues_from_id)         │
                    └──────────────┬───────────────┘
                                   │ SELECT for source
                                   ▼
                    ┌──────────────────────────────┐
                    │  buildTablesPromptSection    │
                    │  (NEW chain walk, this PR)   │
                    │                              │
                    │  1. group by chain head      │
                    │  2. cycle-detect with Set    │
                    │  3. order fragments by page  │
                    │  4. emit one tables: block   │
                    │     with sub-markers         │
                    │  5. defensive merge on       │
                    │     continuesFromId=NULL     │
                    │     rows that match hard     │
                    └──────────────┬───────────────┘
                                   │ tables: block (markdown)
                                   ▼
                                 LLM
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `supabase/migrations/20260614000000_multipage_table_merge.sql` | Create (PR #1) | `continues_from_id` self-FK + override table + 2 indexes. |
| `src/services/files/providers/localPdfTableProvider.ts` | Modify (PR #1) | New `mergeTablesAcrossPages`, `scoreMergeCandidate`, `MAX_CHAIN_DEPTH` constant. Post-pass call inserted after line 123. No changes to `detectTablesOnPage`. |
| `src/services/files/pdfTableExtractor.ts` | Modify (PR #1) | Extend `ExtractedTable` with `continuesFromId?: string \| null`; same on `ResearchEvidenceTableRow`; pass-through in `persistExtractedTables` and `rowToExtractedTable`. |
| `src/services/files/qualityGate.ts` | Modify (PR #2) | New `chainHeadCount(tables)` helper that counts rows with `continues_from_id IS NULL` as 1 chain; `evaluateQualityGate` reports `chainHeads` in the result. |
| `src/services/files/pdfTablePromptBuilder.ts` | Modify (PR #2) | `buildTablesPromptSection` walks `continuesFromId` chains (cycle-detected) and emits one `tables:` block per chain with per-fragment `page=N table=M` sub-markers. Defensive merge: if `continuesFromId` is null but a consecutive pair matches the `hard` heuristic, fold them anyway. |
| `scripts/merge-multipage-tables.ts` | Create (PR #2) | CLI matching `scripts/normalize-taxonomy.ts` shape. Dry-run by default; `--apply` writes FK + override rows. |
| `client/src/components/EvidenceLightbox.tsx` | Modify (PR #2) | New `ChainPager` subcomponent: "Part X of N" badge + prev/next buttons + "Follow" toggle. Renders when the current fact's table has a chain. |
| `client/src/pages/ViewerPage.tsx` | Modify (PR #2) | Sidebar table list shows "Part X of N" suffix on chain members; clicking a chain head activates the chain in the lightbox-style pager. |
| `src/routes/admin/table-merges.ts` | Create (PR #3) | 3 admin routes, each guarded by `authResolver({ required: true, role: "admin" })`. |
| `src/index.ts` | Modify (PR #3) | Import and mount `tableMergesRoute`. |
| `src/services/files/__tests__/localPdfTableProvider.test.ts` | Modify (PR #1) | Add a `describe("mergeTablesAcrossPages")` block with 6 fixtures: single-page passthrough, 2-page merge in `hard`, 3-page chain, `hard-confidence` threshold gate, negative-signal `Table N.` prefix, and `manual` mode no-op. |
| `src/services/files/__tests__/pdfTablePromptBuilder.test.ts` | Modify (PR #2) | Add 3 fixtures: chain walk, defensive merge (no-FK pair), cycle detection. |
| `src/services/files/__tests__/qualityGate.test.ts` | Modify (PR #2) | Add 1 fixture: 3 fragments on a chain count as 1 toward `low_table_count`. |
| `src/services/files/__tests__/table-merges.route.test.ts` | Create (PR #3) | 3 fixtures: POST merge-with happy + idempotent, DELETE merge-override, GET merges returns ranked candidates. |

## Interfaces / Contracts

```typescript
// src/services/files/providers/localPdfTableProvider.ts (additions)

export const MAX_CHAIN_DEPTH = 10;
export const X_TOLERANCE_PT = 4; // existing

export type MergeMode = "hard" | "hard-confidence" | "manual";

export interface MergeOverride {
  tableId: string;
  otherTableId: string;
  action: "force_merge" | "force_unmerge";
  confidenceScore?: number;
}

/**
 * Post-pass: patch `continuesFromId` on tail fragments of multi-page
 * chains. Pure function. Runs after the per-page loop in `extract()`.
 *
 * @param tables  Per-page ExtractedTable[] from `detectTablesOnPage`.
 * @param mode    One of "hard" | "hard-confidence" | "manual".
 * @param overrides  Per-pair overrides from the DB. The detector must
 *                   consult this list BEFORE calling `scoreMergeCandidate`.
 * @param threshold  Score threshold for `hard-confidence` mode. Default 0.7.
 */
export function mergeTablesAcrossPages(
  tables: ExtractedTable[],
  mode: MergeMode,
  overrides: MergeOverride[],
  threshold?: number,
): ExtractedTable[];

/**
 * Score 0..1 for whether T2 is a continuation of T1. Implements the
 * 4-signal weighted formula from the spec. Returns 0 (forced) when
 * T2's first row matches `/^Table\s+\d+\.?/i`.
 */
export function scoreMergeCandidate(
  t1: ExtractedTable,
  t2: ExtractedTable,
): number;
```

```typescript
// src/services/files/pdfTableExtractor.ts (additions)

export interface ExtractedTable {
  // ... existing fields ...
  continuesFromId?: string | null; // NEW — null for first fragment
}

export interface ResearchEvidenceTableRow {
  // ... existing fields ...
  continues_from_id?: string | null; // NEW
}
```

```typescript
// src/routes/admin/table-merges.ts

// POST /api/research-brain/tables/:tableId/merge-with/:otherTableId
//   body: { reason: string, confidence_score?: number }
//   201: { id, tableId, otherTableId, action: "force_merge" }
//   200: same shape (idempotent re-call)
//   400: missing reason
//   404: either tableId not found
//   403: authResolver blocks (admin role required)
//   409: tables belong to different sources

// DELETE /api/research-brain/tables/:tableId/merge-override
//   204: no body
//   200: { removed: number }
//   404: table not found
//   403: authResolver blocks

// GET /api/research-brain/tables/:tableId/merges
//   query: { limit?: number (default 10) }
//   200: { tableId, candidates: Array<{
//     otherTableId: string,
//     page: number,
//     tableIndex: number,
//     score: number,
//     override?: MergeOverride
//   }> }
//   403: authResolver blocks
```

```sql
-- supabase/migrations/20260614000000_multipage_table_merge.sql (PR #1)

BEGIN;

ALTER TABLE public.research_evidence_tables
  ADD COLUMN IF NOT EXISTS continues_from_id UUID
    REFERENCES public.research_evidence_tables(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_evidence_tables_chain
  ON public.research_evidence_tables (continues_from_id)
  WHERE continues_from_id IS NOT NULL;

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

CREATE INDEX IF NOT EXISTS idx_evidence_tables_override_pair
  ON public.research_evidence_table_merges_override (table_id, other_table_id);

GRANT ALL ON TABLE public.research_evidence_table_merges_override
  TO anon, authenticated, service_role;

COMMIT;
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit (PR #1) | `mergeTablesAcrossPages`: passthrough, 2-page merge, 3-page chain, threshold gate, negative signal, manual no-op, override precedence (both directions of `(T1,T2)` and `(T2,T1)`). | `bun test src/services/files/__tests__/localPdfTableProvider.test.ts` — extend with a new `describe` block. Fixtures are hand-rolled `ExtractedTable[]`. |
| Unit (PR #1) | `scoreMergeCandidate`: 4 signals summed correctly, negative signal forces 0. | Same file, sub-fixtures. |
| Unit (PR #2) | `buildTablesPromptSection` chain walk: 3 fragments collapse to 1 block with 3 sub-markers in page order. | `bun test src/services/files/__tests__/pdfTablePromptBuilder.test.ts`. |
| Unit (PR #2) | `buildTablesPromptSection` defensive merge: 2 unlinked fragments with matching headers collapse to 1 block. | Same. |
| Unit (PR #2) | `buildTablesPromptSection` cycle detection: a self-referential chain terminates cleanly. | Same, with a fixture where a row's `continuesFromId` is set to its own id. |
| Unit (PR #2) | Quality gate counts chain heads. | `bun test src/services/files/__tests__/qualityGate.test.ts`. |
| Integration (PR #2) | `scripts/merge-multipage-tables.ts` dry-run does not write; --apply writes idempotently. | Bash-level: invoke the script against a Supabase test DB. No formal `bun test` fixture. |
| Unit (PR #3) | 3 admin routes: POST happy path + idempotent re-call, DELETE happy path, GET ranked candidates. | `bun test src/services/files/__tests__/table-merges.route.test.ts`. Uses mocked supabase client (same pattern as `pdfTablePromptBuilder.test.ts` mocks). |
| E2E (manual) | Re-run extraction on a 5-page-chain PDF; verify `continues_from_id` chain; verify LLM prompt has one block. | Operator-level, on a real PDF, before merge of PR #2. |

## Migration / Rollout

**Migration**: PR #1 ships the SQL migration. The column is nullable and has a
`SET NULL` ON DELETE behavior, so the migration is non-blocking on existing
rows. No data backfill is required in the migration itself — backfill is a
separate CLI script in PR #2.

**Feature flag**: `TABLE_MERGE_MODE` (default `hard-confidence`),
`TABLE_MERGE_THRESHOLD` (default `0.7`), `TABLE_MERGE_ENABLED` (default
`true`; PR #2 adds this as a kill switch on the prompt chain walker). The
detector reads the env at the same `globalThis` memoization site as
`TABLE_EXTRACTION_PROVIDER` (see `pdfTableExtractor.ts` lines 133-149) to
avoid TDZ in workers.

**Phased rollout**:
1. **PR #1**: Migration + detector post-pass. New behavior activates
   automatically on next extraction (cache miss). With `TABLE_MERGE_MODE=manual`
   the detector writes no FK links, so PR #1 ships with mode=hard-confidence
   but is revertible via env to manual within seconds.
2. **PR #2**: Prompt chain walker + viewer badge/pager + backfill script. The
   prompt walker is gated by `TABLE_MERGE_ENABLED` (env var, default true).
   The viewer change is a pure render delta — no flag needed.
3. **PR #3**: 3 admin routes. Additive, no behavior change for non-admin
   callers. Rollback = remove the route file + drop override rows.

**Backfill strategy**: `scripts/merge-multipage-tables.ts` with
`--apply --limit=100` re-runs the merge post-pass against
`research_evidence_tables` rows that are NOT part of an existing chain
(`continues_from_id IS NULL` for all of them and no descendant). The script
respects the current `TABLE_MERGE_MODE`. Re-runs are no-ops.

## Open Questions

None. All key decisions are resolved (see `Resolved decisions` in
`proposal.md` lines 227-234, and the `Architecture Decisions` section
above).
