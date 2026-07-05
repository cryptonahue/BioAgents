# Tasks: Bioprospecting Semantic Deduplication

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 600-800 (migration ~80, normalize ~50, types ~30, db.ts merge ~80, search filter ~30, backfill ~150, tests ~150) |
| 400-line budget risk | Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 = Foundation; PR 2 = Inline merge + helpers; PR 3 = Search filter + backfill + tests |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | PR | Base |
|------|------|----|------|
| 1 | Schema + normalize + types | PR 1 | main |
| 2 | Inline merge + lineage helpers | PR 2 | PR 1 |
| 3 | Search filter + backfill + tests | PR 3 | PR 2 |

## Phase 1: Foundation (PR 1)

- [x] 1.1 Create `supabase/migrations/<ts>_bioprospecting_dedup.sql`: edge table (PK `(canonical_fact_id, merged_fact_id)`, `CHECK` no self-edge, `match_rule CHECK IN ('identity_key','embedding')`), FK indexes, partial unique index on `(identity_key) WHERE identity_key IS NOT NULL`, stored generated `identity_key TEXT` using IMMUTABLE `lower(translate(...) || '|' || ... || regexp_replace(...) || btrim(...))`.
- [x] 1.2 Create `src/services/researchBrain/normalize.ts`: export `normalizeForIdentity(value): string` (NFKD + diacritic strip + non-alnum→space + collapse + trim + lowercase, reuse `normalizeForMatch` from `search.ts`) and `buildIdentityKey(fact): string | null` (5-tuple `species|compound|bioactivity|organism_part|geography`, null if all five empty).
- [x] 1.3 Modify `src/services/researchBrain/types.ts`: add `BioprospectingFactEdge`; extend `BioprospectingFact` with optional `identity_key?` and `merged_into_fact_id?`.

## Phase 2: Inline Merge + Lineage Helpers (PR 2)

- [x] 2.1 Modify `replaceBioprospectingFactsForSource` in `src/services/researchBrain/db.ts` (lines 357-451): post-wipe, group by `buildIdentityKey` (nulls = singleton). For groups K≥2 pick canonical (verified > `updated_at` desc > `source_id` asc > `id` asc). Insert canonical first; for each non-canonical sibling insert row + edge `(canonical.id, sibling.id, 'identity_key', NOW())`. Catch PG 23505 on canonical → re-route as merged into the existing canonical. Return rows with `merged_into_fact_id` populated on siblings.
- [x] 2.2 Add `findMergedFactIds(factIds): Promise<Set<string>>` to `db.ts`: read-only helper, single `select … in (...)` returns the input subset that appears as `merged_fact_id`.
- [x] 2.3 Add `getDuplicateGroup(factId): Promise<{ canonical, merged[] } | null>` to `db.ts`: union match on `canonical_fact_id` OR `merged_fact_id`, join full fact rows, return null when no edges reference the id.

## Phase 3: Search Filter + Backfill + Tests (PR 3)

- [x] 3.1 Add `includeDuplicates?: boolean` (default false) to `BioprospectingFactSearchParams` in `db.ts`. In `searchBioprospectingFacts` `selectFacts()` (line 663) apply `request.not("id", "in", "(SELECT merged_fact_id FROM research_bioprospecting_fact_edges)")` when flag is absent/false. JSDoc warns callers.
- [x] 3.2 Add `backfillBioprospectingFactDedup({ limit, batchSize, dryRun })` to `db.ts`: read facts where `id NOT IN (SELECT merged_fact_id FROM edges)` ordered by `(created_at, id)`, compute `buildIdentityKey` in-memory, group by key (skip nulls), apply canonical rule, in `--apply` mode insert edges `ON CONFLICT (canonical_fact_id, merged_fact_id) DO NOTHING`. Return `{ scannedFacts, groupsFound, edgesProposed, edgesInserted, edgesSkipped, examples: 10 }`.
- [x] 3.3 Create `scripts/backfill-dedupe-bioprospecting-facts.ts` mirroring `normalize-measurements.ts`: CLI `--dry-run` (default), `--apply`, `--limit=N` (500), `--batch-size=N` (500). Call the helper from 3.2 and log JSON.
- [x] 3.4 Add `export * from "./normalize";` to `src/services/researchBrain/index.ts`.
- [x] 3.5 Create `src/services/researchBrain/__tests__/normalize.test.ts` (mirror `contradictionDetector.test.ts`): diacritic fold; casing/punctuation collapse (dash→space); chemically distinct compounds stay distinct; null-key on all-blank; high-cardinality fields excluded; 5-tuple shape; stable re-runs.
- [x] 3.6 Add unit tests for canonical precedence (verified > `updated_at` > `source_id` > `id`), `getDuplicateGroup` from either side, `findMergedFactIds` subset.
- [x] 3.7 Run `bun run build:client`, `bun test src/services/researchBrain/__tests__/`, verify `bun run start` boots and `contradictionDetector.test.ts` passes.
