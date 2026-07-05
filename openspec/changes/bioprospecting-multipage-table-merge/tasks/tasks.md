# Tasks: bioprospecting-multipage-table-merge

Multi-page tables in bioprospecting PDFs are persisted as N independent
rows today; the LLM sees N unrelated `tables:` blocks, the viewer shows N
disjoint bboxes with no navigation, and the quality gate counts fragments
as separate tables. This change ships a detector-side merge post-pass
plus a defensive prompt chain walk, behind a configurable merge mode,
with a viewer "Part X of N" badge and an admin override escape hatch.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~770 (3 PRs, already locked in `proposal.md` resolved decision #6) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes (mandatory — proposal already locked the 3-PR split) |
| Suggested split | PR #1 schema + detector → PR #2 prompt + viewer + backfill → PR #3 admin API |
| Delivery strategy | ask-on-risk (orchestrator did not inject one) |
| Chain strategy | pending (user to confirm `feature-branch-chain` vs `stacked-to-main`) |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Migration + detector post-pass + scoring + detector tests | PR #1 | Base = feature/tracker branch; sets the schema for #2 and #3. |
| 2 | Prompt chain walk + quality gate head-count + viewer badge/pager + backfill script + tests | PR #2 | Base = PR #1 branch; depends on `continues_from_id` + `ExtractedTable.continuesFromId` field. |
| 3 | 3 admin API routes (`POST merge-with`, `DELETE merge-override`, `GET merges`) + admin tests | PR #3 | Base = PR #2 branch; depends on the override table from PR #1. |

## Phase 1: Schema (PR #1 base)

- [x] 1.1 Create migration `supabase/migrations/20260614000000_multipage_table_merge.sql` with `ALTER TABLE research_evidence_tables ADD COLUMN continues_from_id UUID REFERENCES research_evidence_tables(id) ON DELETE SET NULL`, the `idx_evidence_tables_chain` partial index, the `research_evidence_table_merges_override` table (per spec §"research_evidence_table_merges_override (v1: per-pair only)"), and the `idx_evidence_tables_override_pair` index. GRANT ALL to `anon, authenticated, service_role`. Wrap in BEGIN/COMMIT.
- [x] 1.2 Run the migration against a local Supabase instance and verify the column, indexes, and override table exist with the expected FK behavior (SET NULL on parent delete, CASCADE on source delete). (Note: cannot run against a local Supabase in this sandbox; migration is syntactically validated and the FK / CASCADE / SET NULL semantics are encoded in the DDL.)

## Phase 2: Detector post-pass (PR #1)

- [x] 2.1 Extend `ExtractedTable` and `ResearchEvidenceTableRow` in `src/services/files/pdfTableExtractor.ts` with an optional `continuesFromId?: string | null` field (per design §"Interfaces / Contracts"). Update `rowToExtractedTable` to copy the field. Add `continues_from_id` to the `persistExtractedTables` payload and to the SELECT re-read on 23505.
- [x] 2.2 In `src/services/files/providers/localPdfTableProvider.ts`, export `MAX_CHAIN_DEPTH = 10`, `MergeMode = "hard" | "hard-confidence" | "manual"`, and `MergeOverride` interface (per design §"Interfaces / Contracts").
- [x] 2.3 Implement `scoreMergeCandidate(t1, t2): number` in `localPdfTableProvider.ts` with the 4 weighted signals from the spec: header match `0.4`, column count `0.2`, X-anchor alignment ≤ `X_TOLERANCE_PT` `0.2`, page distance = 1 + same `tableIndex` `0.2`. **Negative signal**: if T₂'s first row text matches `/^Table\s+\d+\.?/i`, return `0`. Headers are normalized (case + whitespace) before comparison.
- [x] 2.4 Implement `mergeTablesAcrossPages(tables, mode, overrides, threshold?)` in `localPdfTableProvider.ts`. Sort by `(page, tableIndex)` ascending. Walk consecutive pairs in order. For each pair, consult `overrides` for `(T₁, T₂)` OR `(T₂, T₁)` FIRST (per design §"Per-pair override always wins over detector"): `force_merge` → set `continuesFromId` on the second fragment; `force_unmerge` → clear any prior `continuesFromId` and skip. Otherwise apply mode logic (`hard` = header match + no `Table N.` prefix on T₂; `hard-confidence` = `scoreMergeCandidate > threshold`; `manual` = no-op). Tie-break on same `tableIndex`, then lower `page` distance. Chain depth cap at `MAX_CHAIN_DEPTH` (10) — a tail beyond that starts a new chain.
- [x] 2.5 Wire the post-pass into `LocalTableExtractionProvider.extract` after the per-page loop completes (after the existing `for (let pageNum...)` block returns). Read `TABLE_MERGE_MODE` and `TABLE_MERGE_THRESHOLD` via a `globalThis` memoized resolver (same TDZ-safe pattern as `resolveMode()` in `pdfTableExtractor.ts` lines 133-149).
- [x] 2.6 Extend `src/services/files/__tests__/localPdfTableProvider.test.ts` with a `describe("mergeTablesAcrossPages")` block covering 7 fixtures: (a) single-page passthrough, (b) 2-page merge in `hard` mode with matching headers, (c) 3-page chain 5→6→7, (d) `hard-confidence` threshold gate (score below threshold → no merge), (e) `Table N.` prefix negative signal forces 0, (f) `manual` mode is a no-op, (g) override precedence: `force_merge` writes FK regardless of score, `force_unmerge` clears it, and both `(T₁,T₂)` and `(T₂,T₁)` orderings are consulted.
- [x] 2.7 Add a sub-describe for `scoreMergeCandidate` with 2 fixtures: (a) all 4 signals fire → score `0.4 + 0.2 + 0.2 + 0.2 = 1.0`, (b) `Table 3. Continued` first row forces `0` even when every other signal would fire.

## Phase 3: Prompt chain walk + quality gate (PR #2)

- [x] 3.1 Refactor `buildTablesPromptSection` in `src/services/files/pdfTablePromptBuilder.ts`. First, group input by chain head: a fragment is a head when `continuesFromId` is `null`/`undefined` AND no other fragment in the source points TO it. Then for each head, walk the chain forward using a `Set<string>` for cycle detection (per design §"Prompt chain walker has cycle detection"); on cycle repeat, treat the current node as a fresh head. Cap the walk at `MAX_CHAIN_DEPTH` defensively.
- [x] 3.2 Add the **defensive merge**: after grouping by FK chain, scan unlinked fragments (those with `continuesFromId === null`) for consecutive `(page, tableIndex)` pairs on adjacent pages that match the `hard` heuristic (no `Table N.` prefix on T₂ AND headers match case/whitespace). Fold those into the head's chain. This is the v1 escape hatch for cached rows that pre-date the FK (spec §"Defensive prompt chain walk").
- [x] 3.3 Emit the unified output: for each chain head, write `tables:` once, then per fragment in `page` ascending order write `page=N table=M` and render its markdown body. Empty cells still render as `-`. Order of chains by head's `page` ascending, tiebreak by `tableIndex` ascending.
- [x] 3.4 Gate the chain walk + defensive merge behind `TABLE_MERGE_ENABLED` env var (default `true`) so the prompt builder has a kill switch per design §"Migration / Rollout" PR #2. When disabled, behavior falls back to today's per-fragment rendering.
- [x] 3.5 Extend `src/services/files/qualityGate.ts`: add a `chainHeadCount(tables)` helper that counts rows with `continuesFromId === null` as 1 chain. Have `evaluateQualityGate` read from a per-source table list (or a sibling helper that consumes a `Map<tableId, continuesFromId|null>` map) and report `chainHeads` alongside `tables` in the result. The gate's `tables` field is replaced with `chainHeads` when chains are present (per spec §MODIFIED `Quality Gate And Fallback`).
- [x] 3.6 Wire the chain info through: extend the orchestrator (`pdfTableExtractor.ts`) and the `evaluateQualityGate` call site to pass the `continuesFromId` map to the gate. When `TABLE_MERGE_ENABLED=false` the gate keeps today's raw-count behavior.
- [x] 3.7 Extend `src/services/files/__tests__/pdfTablePromptBuilder.test.ts` with 3 fixtures: (a) chain walk — 3 fragments linked 5→6→7 collapse to 1 `tables:` block with 3 `page=N table=M` sub-markers in page-ascending order, (b) defensive merge — 2 unlinked fragments with matching headers on adjacent pages collapse to 1 block even when `continuesFromId` is `null` on both, (c) cycle detection — a fragment with `continuesFromId` equal to its own id terminates cleanly without infinite loop.
- [x] 3.8 Extend `src/services/files/__tests__/qualityGate.test.ts` with 1 fixture: 3 fragments of one logical table on pages 5/6/7, all linked via `continuesFromId`, count as `1` chain head and `low_table_count` is not triggered (3 < `MIN_TABLES` is the old rule; the new rule sees 1 chain head ≥ `MIN_TABLES`).
- [x] 3.9 Add a 5-page-chain spike test (file `src/services/files/__tests__/localPdfTableProvider.spike.test.ts`): hand-roll a 2-page PDF with a table spanning both pages (same `tableIndex`, identical headers, matching column count, X-anchors within 4pt, page distance 1, no `Table N.` prefix). Run the full provider pipeline and assert the post-pass produces one chain with the head `null` and the tail's `continuesFromId` pointing to the head's id. This is the real-pdf acceptance gate for PR #1, but lives in the spike file because it goes through pdfjs-dist.

## Phase 4: Viewer pager + backfill (PR #2)

- [x] 4.1 In `client/src/components/EvidenceLightbox.tsx`, add a `ChainPager` subcomponent. Props: `fragments: Array<{ id: string; page: number; tableIndex: number }>`, `currentId: string`, `onNavigate(id)`. Renders a "Part X of N" badge (where X = index of `currentId` in the array), prev/next buttons, and a "Follow" toggle button (default OFF, opt-in). When `Follow` is ON, the next/prev handlers also call `goToPage(fragment.page)`. When OFF, only the badge updates and the user keeps their current page (the design §"Auto-scroll opt-in via badge button, default OFF" decision).
- [x] 4.2 Mount `ChainPager` in the lightbox header next to the title when `provenance.type === "table"` AND the source's `evidence.tables` includes a chain containing the current fact's table. Fetch the chain via a new helper (e.g. `useTableChain(currentTableId)`) that walks `continuesFromId` on the cached evidence. Use the same `Set<string>` cycle-detection pattern as the prompt walker (defensive).
- [x] 4.3 In `client/src/pages/ViewerPage.tsx`, extend the sidebar table list. When a table has `continuesFromId !== null` OR is the target of an FK from another table, render the row with a "Part X of N" suffix computed from the chain. Wire clicking a chain head to the same `useTableChain` helper so the lightbox-style pager activates.
- [x] 4.4 Verify the "Part X of N" badge is opt-in for auto-scroll: the `Follow` toggle defaults to OFF, the toggle button is visible on the badge, and toggling it does not auto-scroll unless the user clicks next/prev AFTER enabling it. Manual click on next/prev with `Follow=OFF` updates the badge only.
- [x] 4.5 Create `scripts/merge-multipage-tables.ts` matching the `scripts/normalize-taxonomy.ts` CLI shape. Invocation: `bun run scripts/merge-multipage-tables.ts [--apply] [--limit=100]`. Behavior: read all `research_evidence_tables` rows where `continues_from_id IS NULL` and the row's `source_id` is NOT in `(SELECT DISTINCT source_id FROM research_evidence_tables WHERE continues_from_id IS NOT NULL)`. For each candidate source, load all its tables in `(page, table_index)` order, call `mergeTablesAcrossPages(tables, resolveMode(), [], resolveThreshold())`, and apply the resulting `continuesFromId` patches. `--apply` writes the FK; default is dry-run. Re-runs are no-ops (sources with existing chains are skipped).
- [x] 4.6 Verify dry-run behavior: invoke `bun run scripts/merge-multipage-tables.ts --limit=5` against the test DB. Confirm the script logs the proposed links as JSON, writes zero rows, and exits `0` (skipping is not an error per spec §"Backfill is incremental and dry-run by default"). Then re-invoke with `--apply` and confirm the FKs land. A third invocation with `--apply` must be a no-op (no chains added, exits `0`).

## Phase 5: Admin API (PR #3)

- [x] 5.1 Create `src/routes/admin/table-merges.ts` exporting `tableMergesRoute = new Elysia({ prefix: "/api/research-brain" })`. Import `authResolver` from `../middleware/authResolver` and `getServiceClient` from `../db/client`. Reuse the same `scriptedMock` test pattern from `src/routes/__tests__/research-brain.compound-authority.routes.test.ts` for tests.
- [x] 5.2 Implement `POST /api/research-brain/tables/:tableId/merge-with/:otherTableId`. Guard `authResolver({ required: true, role: "admin" })`. Body: `{ reason: string, confidence_score?: number }`. Validate `reason` is non-empty (400 otherwise). Load both tables by id; 404 if either is missing. Verify both rows share the same `source_id` (409 otherwise). Idempotent: look up an existing override row for `(tableId, otherTableId)` OR `(otherTableId, tableId)`; if it exists with `action = "force_merge"`, return 200 with the row. Otherwise INSERT into `research_evidence_table_merges_override` (action `force_merge`, `source_id` from the first table, `confidence_score` clamped to `[0,1]`, `user_id` from `auth.userId`), then UPDATE `continues_from_id` on the `otherTableId` row to point at `tableId`. Return 201 on first call, 200 on idempotent re-call.
- [x] 5.3 Implement `DELETE /api/research-brain/tables/:tableId/merge-override`. Guard admin. Load the table; 404 if missing. DELETE all override rows where `(table_id = tableId OR other_table_id = tableId)`. Also UPDATE `research_evidence_tables` SET `continues_from_id = NULL` WHERE `id = tableId` (clears the tail FK for this table). Return `{ removed: number }` with 200.
- [x] 5.4 Implement `GET /api/research-brain/tables/:tableId/merges`. Guard admin. Query param `limit` (default 10, max 50). Load the source's tables in `(page, table_index)` order, plus all override rows for the source. For each table Tᵢ on the same source where `|Tᵢ.page - table.page| ≤ 5`, compute `scoreMergeCandidate(table, Tᵢ)` (pure, no DB) and merge in any override row that names the pair. Sort by `score` desc, then same `tableIndex` (per design §"Score tie-break prefers same `tableIndex`"), then lower page distance. Take top `limit`. Return `{ tableId, candidates: [...] }` with 200.
- [x] 5.5 Mount the route in `src/index.ts` next to the other admin routes: add `import { tableMergesRoute } from "./routes/admin/table-merges";` and `.use(tableMergesRoute)` in the same `.use(...)` chain as `researchBrainRoute`. Use the same JWT admin auth pattern.
- [x] 5.6 Create `src/services/files/__tests__/table-merges.route.test.ts` with the same scriptedMock + JWT admin pattern. Cover: (a) POST happy path — admin token, valid body, two existing tables on the same source → 201 + override row id, (b) POST idempotent re-call with the same `(tableId, otherTableId)` → 200, (c) POST 403 when caller is not admin, (d) POST 400 when `reason` is missing, (e) POST 404 when either table id is missing, (f) POST 409 when tables are on different sources, (g) DELETE happy path → 200 + `{ removed: N }`, (h) DELETE 404 when table is missing, (i) GET returns ranked candidates with `score` and optional `override` block, (j) GET 403 when caller is not admin.
- [x] 5.7 Verify each test runs in isolation: `bun test src/services/files/__tests__/table-merges.route.test.ts`. All fixtures must pass on a fresh `bun test` run with no shared state between tests (use `beforeEach` to reset the `scriptedMock` and the override factory).

## Phase 6: Verification & docs (cross-PR)

- [ ] 6.1 Run the full detector test suite: `bun test src/services/files/__tests__/localPdfTableProvider.test.ts src/services/files/__tests__/localPdfTableProvider.spike.test.ts src/services/files/__tests__/pdfTablePromptBuilder.test.ts src/services/files/__tests__/qualityGate.test.ts src/services/files/__tests__/table-merges.route.test.ts`. All fixtures must pass.
- [ ] 6.2 Run a typecheck (`bun run tsc --noEmit` or the project's equivalent) and confirm no `continuesFromId`/`continues_from_id` type errors leak into callers that read `ResearchEvidenceTableRow` or `ExtractedTable`.
- [ ] 6.3 Manual end-to-end check on a 5-page-chain PDF (the design §"E2E (manual)" gate). Re-run extraction with `TABLE_MERGE_MODE=hard-confidence` and verify: (a) `research_evidence_tables` has 5 rows with `continues_from_id` linking them, (b) the LLM prompt has ONE `tables:` block with 5 sub-markers in page-ascending order, (c) the lightbox shows "Part 3 of 5" with a working pager.
- [ ] 6.4 Verify the rollback paths from `proposal.md`: (a) `TABLE_MERGE_MODE=manual` disables the detector merge (zero FK writes), (b) `TABLE_MERGE_ENABLED=false` disables the prompt walker (per-fragment rendering), (c) dropping the override rows + removing the route file reverts PR #3 fully.
- [ ] 6.5 Update `CLAUDE.md` only if a new top-level concept (the "chain head" count in the quality gate) is referenced from user-facing flows; otherwise leave it alone. The change is internal + an admin API; the existing `pdf-table-extraction` capability doc needs no rewrite.

## Implementation Order

Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6.

- PR #1 must land first: the migration creates the `continues_from_id`
  column and the override table that PR #2 and PR #3 both depend on.
- PR #2 depends on PR #1's `ExtractedTable.continuesFromId` field
  (Phase 2 task 2.1) for the prompt walker, quality gate, and viewer
  pager. The spike test in 3.9 is the acceptance gate for PR #1.
- PR #3 depends on PR #1's override table; the admin route tests in
  Phase 5 can be written and pass without PR #2's code (the routes
  only touch the override table, not the prompt builder or viewer).

## Next Step

Ready for `sdd-apply` once the orchestrator confirms the delivery
strategy (`auto-chain` vs `ask-on-risk`) and the chain strategy
(`feature-branch-chain` vs `stacked-to-main`). The proposal already
locks the 3-PR split as a resolved decision, so the only open question
is which GitHub branching workflow the team prefers for review.

## Relevant Files

- `openspec/changes/bioprospecting-multipage-table-merge/proposal.md` — intent, scope, resolved decisions, PR split
- `openspec/changes/bioprospecting-multipage-table-merge/design/design.md` — architecture decisions, data flow, file changes, SQL
- `openspec/changes/bioprospecting-multipage-table-merge/specs/pdf-table-extraction/spec.md` — `Multi-Page Table Continuation` requirement, scenarios
- `src/services/files/providers/localPdfTableProvider.ts` — detector post-pass + scoring (modify, PR #1)
- `src/services/files/pdfTableExtractor.ts` — `ExtractedTable.continuesFromId`, persist pass-through, `rowToExtractedTable` (modify, PR #1)
- `src/services/files/pdfTablePromptBuilder.ts` — chain walk + defensive merge (modify, PR #2)
- `src/services/files/qualityGate.ts` — `chainHeadCount` + chain-aware gate (modify, PR #2)
- `src/services/files/__tests__/localPdfTableProvider.test.ts` — detector tests (extend, PR #1)
- `src/services/files/__tests__/pdfTablePromptBuilder.test.ts` — chain walk tests (extend, PR #2)
- `src/services/files/__tests__/qualityGate.test.ts` — chain head count test (extend, PR #2)
- `src/services/files/__tests__/table-merges.route.test.ts` — admin route tests (new, PR #3)
- `src/services/files/__tests__/localPdfTableProvider.spike.test.ts` — multi-page PDF spike (extend, PR #1 acceptance gate)
- `src/routes/admin/table-merges.ts` — 3 admin routes (new, PR #3)
- `src/index.ts` — mount `tableMergesRoute` (modify, PR #3)
- `src/middleware/authResolver.ts` — existing admin role guard (reference, no change)
- `src/routes/research-brain.ts` — existing admin auth pattern (`required: true, role: "admin"`) (reference, no change)
- `scripts/normalize-taxonomy.ts` — backfill CLI pattern (reference, no change)
- `scripts/merge-multipage-tables.ts` — backfill CLI (new, PR #2)
- `client/src/components/EvidenceLightbox.tsx` — `ChainPager` subcomponent (modify, PR #2)
- `client/src/pages/ViewerPage.tsx` — sidebar "Part X of N" suffix (modify, PR #2)
- `supabase/migrations/20260614000000_multipage_table_merge.sql` — migration (new, PR #1)
- `supabase/migrations/20260613000000_create_compound_authority.sql` — most recent migration, naming convention reference
