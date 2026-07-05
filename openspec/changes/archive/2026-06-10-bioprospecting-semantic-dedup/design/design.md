# Design: Bioprospecting Semantic Deduplication

## Technical Approach

Phase 1 ships a deterministic, rule-based identity-key dedup layer for
`research_bioprospecting_facts`: a stored generated `identity_key` column,
`research_bioprospecting_fact_edges` lineage table, inline merge in
`replaceBioprospectingFactsForSource`, a backfill script, and an
`includeDuplicates` filter in `searchBioprospectingFacts`. Embedding-backed
dedup is PR2; the edge table already accepts `match_rule = 'embedding'` so
PR2 lands additively.

## Architecture Decisions

| Decision | Choice | Tradeoff | Why |
|---|---|---|---|
| Identity key shape | 5-tuple: `species \| compound \| bioactivity \| organism_part \| geography` | `source_id` blocks cross-source dedup; `relation_type` makes paraphrases unmergeable; high-cardinality fields absorb LLM drift | Spec scenario: `quercetin` vs `quercetin-3-O-glucoside` stays distinct |
| Storage | `identity_key TEXT GENERATED ALWAYS AS (...) STORED` on facts | App-computed nullable column drifts; trigger-maintained adds complexity | Spec-mandated, re-evaluates on UPDATE, indexes naturally |
| ASCII-fold primitive | `translate(lower(x), 'áéíóú...ñ', 'aeiou...n')` | `unaccent` extension not enabled in any migration (grep clean); enabling is project-wide | `translate()` is IMMUTABLE (generated columns validate), covers 30+ diacritics, matches TS for ASCII-foldable inputs |
| Merged-row invariant | Edge-table composite PK `(canonical, merged)` + `CHECK` self-edge | The proposal's `WHERE review_status != 'merged'` is **stale and dropped** — `review_status` enum has no `'merged'` value | Graph edge, not row state; composite PK + partial unique index together guarantee canonical/merged/standalone trichotomy |
| Key source of truth | TS `buildIdentityKey` for pre-insert grouping; SQL `identity_key` post-insert | TS needed for in-memory grouping before any row exists; SQL is the index truth | Avoids N round-trips in `replaceBioprospectingFactsForSource` |

## Data Flow

```
extractBioprospectingFactsForSource
  → buildIdentityKey per fact → group by key (nulls → singleton)
  → for each group of size K ≥ 2: pick canonical (verified > updated_at > source_id)
  → insert ALL K rows + K-1 edges
  → partial unique index catches cross-source collision → re-route
  → return [canonical, merged, ...]

searchBioprospectingFacts (default):  id NOT IN (SELECT merged_fact_id FROM edges)
searchBioprospectingFacts (includeDuplicates: true): no filter
backfill: facts WHERE id NOT IN (edges.merged_fact_id), group by key, INSERT edges ON CONFLICT DO NOTHING
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/services/researchBrain/normalize.ts` | Create | `normalizeForIdentity`, `buildIdentityKey` |
| `src/services/researchBrain/types.ts` | Modify | Add `BioprospectingFactEdge`; extend `BioprospectingFact` with optional `identity_key` and `merged_into_fact_id` |
| `src/services/researchBrain/db.ts` | Modify | Inline merge in `replaceBioprospectingFactsForSource`; add `findMergedFactIds`, `getDuplicateGroup`; `searchBioprospectingFacts` gains `includeDuplicates` + SQL filter |
| `supabase/migrations/<ts>_bioprospecting_dedup.sql` | Create | Edge table, generated `identity_key`, partial unique index, edge FK indexes |
| `scripts/backfill-dedupe-bioprospecting-facts.ts` | Create | CLI backfill mirroring `normalize-measurements.ts`; dry-run by default; idempotent via PK skip |
| `src/services/researchBrain/index.ts` | Modify | Re-export `normalize` |

## Interfaces / Contracts

```typescript
// normalize.ts
export function normalizeForIdentity(value: string): string;
export function buildIdentityKey(fact: BioprospectingFact): string | null;

// types.ts
export type BioprospectingFactEdge = {
  canonical_fact_id: string; merged_fact_id: string;
  match_rule: "identity_key" | "embedding"; merged_at: string;
};
// BioprospectingFact gains optional: identity_key, merged_into_fact_id

// db.ts — BioprospectingFactSearchParams gains: includeDuplicates?: boolean
// New helpers: findMergedFactIds(factIds), getDuplicateGroup(factId)
```

### SQL — generated `identity_key` column

Expression: `lower(btrim(regexp_replace(coalesce(translate(lower(<field>), <diacritic_map>, <ascii_map>), '') || '|' || ... [5 fields], '[^a-z0-9|]+', ' ', 'g')))`. Diacritic→ASCII map `'áéíóúàèìòùâêîôûäëïöüçñ'` → `'aeiouaeiouaeiouaeioucn'`, applied to each of the 5 fields, all `||`-joined with `'|'`. The chain (`lower`, `translate`, `coalesce`, `||`, `regexp_replace`, `btrim`) is fully IMMUTABLE in PG — required for `GENERATED ... STORED`. Full column DDL lives in the migration file.

### SQL — edge table + indexes

`research_bioprospecting_fact_edges` with PK `(canonical_fact_id, merged_fact_id)`, `CHECK (canonical_fact_id <> merged_fact_id)`, `match_rule CHECK IN ('identity_key', 'embedding')`. Two FK indexes on each side. `idx_bioprospecting_facts_identity_key_unique` partial unique on `identity_key WHERE identity_key IS NOT NULL`. Full DDL in the migration file.

## Inline Merge Algorithm (replaceBioprospectingFactsForSource)

1. Pre-wipe (existing): delete facts for `source.id`.
2. Group incoming `facts` by `buildIdentityKey` (nulls → singleton).
3. Per group of size K ≥ 2: pick canonical — `verified` > `updated_at desc` > `source_id asc` > `id asc`.
4. Insert ALL K rows (preserves source-wipe invariant).
5. For each non-canonical sibling, insert edge `(canonical.id, sibling.id, 'identity_key', NOW())`. Catch PG 23505 → treat as already-merged.
6. Cross-source re-route: scan returned rows for `identity_key` collisions with pre-existing canonicals; write edge `(existing.id, new.id, 'identity_key')`.
7. Return `BioprospectingFact[]` with `merged_into_fact_id` populated on siblings.

## Backfill Script (scripts/backfill-dedupe-bioprospecting-facts.ts)

Mirrors `normalize-measurements.ts`. CLI: `--dry-run` (default), `--apply`, `--limit=N` (500), `--batch-size=N` (500). Read `WHERE id NOT IN (edges.merged_fact_id) ORDER BY created_at, id`. Group by `identity_key` (skip nulls), apply canonical rule. `--apply`: `INSERT INTO edges ON CONFLICT (canonical, merged) DO NOTHING`. Log stats + 10 example groups. Half-state safe: additive only, idempotent via PK.

## Search Filter (searchBioprospectingFacts)

`includeDuplicates?: boolean` (default `false`). When false: `request.not("id", "in", "(SELECT merged_fact_id FROM research_bioprospecting_fact_edges)")` on every internal `selectFacts()` call. `getDuplicateGroup` joins the edge table twice (canonical, merged) to resolve either entry point. Ranking and limits untouched.

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | `normalizeForIdentity`, `buildIdentityKey`, `findCanonicalMatch` (precedence) | `__tests__/normalize.test.ts` mirroring `contradictionDetector.test.ts` |
| Integration | `replaceBioprospectingFactsForSource` inline merge | Bun test on Supabase test schema; assert edge count = K-1 per group |
| Integration | `searchBioprospectingFacts` default vs `includeDuplicates: true` | Result counts differ by exactly merged-row count |
| Migration | Apply + rollback | Round-trip on seeded schema; unique index rejects duplicate-key, CHECK rejects self-edges |

## Migration / Rollout

Single migration `20260610xxxxxx_bioprospecting_dedup.sql`: create edge table → add stored `identity_key` column (metadata-only in PG12+, no write lock) → create partial unique index → create edge FK indexes. Cutover gates on dry-run stats review.

Rollback: `DROP TABLE edges`, `DROP INDEX identity_key_unique`, `ALTER TABLE facts DROP COLUMN identity_key`. Row data untouched. Revert the two TS functions.

## Open Questions

None. The five design decisions reconcile the spec, the proposal, and the existing migration history. The proposal's stale `WHERE review_status != 'merged'` clause is explicitly dropped.
