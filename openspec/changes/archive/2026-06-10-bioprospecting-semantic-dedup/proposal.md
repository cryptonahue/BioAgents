# Proposal: Bioprospecting Semantic Deduplication

## Intent

`research_bioprospecting_facts` accumulates near-identical rows across sources and
extraction runs. `replaceBioprospectingFactsForSource` (`src/services/researchBrain/db.ts:357-451`)
already wipes per source, but cross-source and within-batch duplicates persist:
adjacent LLM batches from `bioprospectingExtractor.ts` produce two facts for the
same species-compound pair with minor wording differences, the heuristic
fallback emits one fact per matching chunk with no cross-batch awareness, and
the LLM has no canonical entity vocabulary. Downstream: `contradictionDetector`
false-positives, search inflation, and review triage noise.

This change introduces a deterministic, rule-based dedup layer that merges
semantically equivalent facts while preserving full provenance, and lays the
schema groundwork for a future embedding-backed dedup tier.

## Scope

### In Scope

- **Compound normalizer** — conservative (lowercase + NFKD diacritic strip + whitespace collapse). Reuses `normalizeForMatch` from `search.ts:1151-1158`. No suffix collapse, no plural folding, no chemistry-aware transforms. Lives in `src/services/researchBrain/normalize.ts`.
- **Identity key** — deterministic tuple `(normalized_species, normalized_compound, normalized_bioactivity, organism_part, geography)`. `result_summary`, `quote`, `measurement_*`, and `condition` are NOT part of the key (too high-cardinality, too much LLM drift).
- **Edge-table merge model** — both rows preserved. New table `research_bioprospecting_fact_edges (canonical_fact_id, merged_fact_id, match_rule, merged_at)`. Consistent with the existing `research_edges` pattern.
- **Insertion path** — inline merge in `replaceBioprospectingFactsForSource` (catches within-source and cross-source on re-extract) plus a one-shot backfill script `scripts/backfill-dedupe-bioprospecting-facts.ts` modeled on `measurements.ts`. No BullMQ worker.
- **Search behavior** — `searchBioprospectingFacts` filters out merged (non-canonical) rows by default. New `includeDuplicates: true` query flag exposes the full set. The `searchBioprospectingFacts` TS signature gains the flag.
- **Review status precedence** — on merge, the row with `review_status = 'verified'` wins as canonical. If neither is verified, the most recently updated row wins. Tied rows with different verified status keep the verified one; humans can revert via `updateBioprospectingFact` (no automatic un-merge — manual only).
- **Schema migration** — `supabase/migrations/<ts>_bioprospecting_dedup.sql` adds the edge table, a partial unique index on the identity key for canonical rows, and indexes to keep search fast.

### Out of Scope

- Embedding-backed semantic dedup (pgvector column, embedding generation, cosine threshold). The edge table and identity key are designed to slot a future `match_rule = 'embedding'` enum value in, but no embedding work ships in this change.
- Automated contradiction detection between merged facts.
- User-facing UI for managing duplicate groups.
- Auto-merge on conflicting `measurement_value` — kept as separate facts; only identical identity-key tuples merge.
- Taxon-aware merge of `(genus)` vs `(species, genus)` aliases. Deferred to a follow-up that builds on `taxonomy.ts`.

## Capabilities

### New Capabilities
- `bioprospecting-fact-dedup`: identity-key normalization, inline merge at insert, edge-table lineage, search filtering, and backfill script for `research_bioprospecting_facts`.

### Modified Capabilities
- None. No spec files exist yet; this change introduces the only capability touching the bioprospecting facts surface.

## Approach

**Phase 1 — Normalization + key.** Extract the existing `normalizeForMatch` logic into a documented `normalizeForIdentity` in `src/services/researchBrain/normalize.ts`. Build a pure `buildIdentityKey(fact) => string` function and a `findCanonicalMatch(candidate, existingRows) => match | null` that does a single SQL round-trip with the partial unique index.

**Phase 2 — Schema.** Migration adds `research_bioprospecting_fact_edges` (FK to facts, `match_rule text CHECK in ('identity_key','future_embedding')`, `merged_at timestamptz`). Partial unique index `WHERE canonical_fact_id = merged_fact_id` is meaningless, so the table just has a composite PK. Index on `(canonical_fact_id)` and `(merged_fact_id)` for reverse lookups. Add a generated stored column `identity_key text` on `research_bioprospecting_facts` (nullable for back-compat) with a partial unique index `WHERE identity_key IS NOT NULL AND review_status != 'merged'`.

**Phase 3 — Inline merge.** In `replaceBioprospectingFactsForSource`, after the source-wipe, group incoming facts by `buildIdentityKey`. For each group, pick the canonical (verified wins, else most recent `updated_at`). Insert the canonical row, then for each non-canonical sibling insert an edge row pointing to it. Non-canonical incoming rows are still inserted (preserving the rule that the wipe is by source, not by dedup outcome) — the edge records the relationship. Search filters them out by default.

**Phase 4 — Backfill.** `scripts/backfill-dedupe-bioprospecting-facts.ts` scans all facts where `identity_key IS NULL`, computes the key, then runs an in-memory grouping pass ordered by `source_id` (deterministic tiebreak) to assign canonical/merged status and emit edge rows. Dry-run mode prints stats. Mirrors `measurements.ts` shape: CLI flags, batched commits, log progress, idempotent.

**Phase 5 — Search filter.** Add `includeDuplicates?: boolean` to the `searchBioprospectingFacts` params type. Default behavior: `WHERE id NOT IN (SELECT merged_fact_id FROM research_bioprospecting_fact_edges)`. When the flag is true, no filter applied. Read-path only, no write impact.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/services/researchBrain/normalize.ts` | New | `normalizeForIdentity`, `buildIdentityKey` |
| `src/services/researchBrain/db.ts` | Modified | `replaceBioprospectingFactsForSource` runs inline merge; new `findMergedFactIds` and `getDuplicateGroup` helpers |
| `src/services/researchBrain/types.ts` | Modified | Add `BioprospectingFactEdge`, extend `BioprospectingFact` with optional `identityKey` and `mergedIntoFactId` |
| `src/services/researchBrain/search.ts` | Modified | `searchBioprospectingFacts` accepts `includeDuplicates`; default filters merged rows |
| `supabase/migrations/<ts>_bioprospecting_dedup.sql` | New | Edge table, generated column, partial unique index |
| `scripts/backfill-dedupe-bioprospecting-facts.ts` | New | One-shot backfill, dry-run by default |
| `src/services/researchBrain/measurements.ts` | Reference | Pattern template for backfill script (not modified) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Aggressive normalizer collapses legitimately distinct compounds (e.g., "quercetin" vs "quercetin-3-O-glucoside") | Med | Conservative normalizer (lowercase + diacritics + whitespace only). `identity_key` includes `bioactivity` and `organism_part` to reduce false positives. Backfill runs in dry-run by default; production cutover gated on stats review. |
| Migration on a large existing table blocks writes | Low | `ADD COLUMN ... GENERATED ALWAYS AS ... STORED` is metadata-only in PG12+. Partial unique index built `CONCURRENTLY` (out-of-band index creation in a follow-up migration). |
| Inline merge slows down `replaceBioprospectingFactsForSource` | Low | Identity-key lookup is a single btree probe per incoming fact; merge grouping is in-memory. No additional SQL round-trips per fact. |
| Reviewer sees "missing" facts after search filter ships | Med | `includeDuplicates: true` exposes the full set. `searchBioprospectingFacts` JSDoc warns about the default. Edge table lets us reconstruct the group. |
| Backfill script double-edges on re-run | Low | Idempotent: skip rows where the canonical already has an edge for the same `merged_fact_id`. Backfill logs edge-insert count and skipped count. |

## Rollback Plan

1. Revert the migration: `DROP TABLE research_bioprospecting_fact_edges; DROP INDEX IF EXISTS ...` and drop the generated `identity_key` column. Existing facts are untouched (column drop is non-destructive to row data; only the computed key is lost).
2. Revert the inline merge: revert `replaceBioprospectingFactsForSource` to its pre-change implementation. Re-running an extraction will re-create the duplicates the merge removed, but no data is lost.
3. Revert the search filter: revert `searchBioprospectingFacts` signature change. Old callers (no `includeDuplicates` flag) get the pre-change behavior.
4. The backfill script is additive (only inserts edge rows) and can stay deployed even if the rest is rolled back — its outputs are inert if the search filter is reverted.

Steps 1-3 are independent. Worst case: roll back all three, leave the migration applied, and the next dedup change picks up where this one stopped.

## Dependencies

- `src/services/researchBrain/search.ts` — reuses `normalizeForMatch` (NFKD + diacritic strip). The new `normalizeForIdentity` is a thin wrapper plus whitespace collapse; same primitives.
- `src/services/researchBrain/taxonomy.ts` — pattern reference for normalization + canonicalize + upsert, not a runtime dependency.
- `src/services/researchBrain/measurements.ts` — pattern reference for the backfill script template.
- No external service or new LLM provider required.

## Success Criteria

- [ ] Inline merge: re-running extraction on a source that previously produced N near-duplicate facts now produces 1 fact + N-1 edge rows.
- [ ] Backfill: on the current `research_bioprospecting_facts` table, the script reports a stable merge ratio (run twice on the same data, identical edge count) and dry-run shows a non-trivial merged-row count.
- [ ] Search: `searchBioprospectingFacts` default response excludes merged rows; passing `includeDuplicates: true` returns them; result counts differ by exactly the merged-row count for any test query.
- [ ] Verified precedence: a `verified` fact merged with an `unverified` duplicate keeps the verified row as canonical. Confirmed via unit test on `findCanonicalMatch`.
- [ ] No regressions: `bun run build:client`, `bun run start` boot, and the existing `__tests__/contradictionDetector.test.ts` pass.
- [ ] Migration is reversible: rollback drops the edge table and generated column without data loss on `research_bioprospecting_facts`.
