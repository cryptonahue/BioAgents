# Exploration: Semantic Deduplication of Bioprospecting Facts

## Current State

### Fact storage

`research_bioprospecting_facts` is defined in
`supabase/migrations/20260606090000_prepare_bioprospecting_ingestion.sql` and
documented in `src/services/researchBrain/types.ts` (see `BioprospectingFact`,
lines 218-275). Each row holds a structured claim about a species/compound/
bioactivity tuple with provenance (`source_id`, `chunk_id`, `quote`, `doi`,
`page`) plus taxonomy FKs (`species_taxon_id`, `genus_taxon_id`,
`family_taxon_id`) populated by `taxonomy.ts`.

Key columns relevant to dedup:

- Identity axes: `species`, `genus`, `family`, `compound`, `bioactivity`,
  `application_area`, `assay_model`, `result_summary`, `quote`,
  `measurement_value/unit/direction`, `condition`, `organism_part`,
  `geography`, `ecosystem`.
- Provenance: `source_id`, `chunk_id`, `page`, `doi`, `quote`.
- Review/triage: `review_status`, `review_note`.
- The `metadata` JSONB carries an `entityCorrectionHistory` array used by
  `updateBioprospectingFactEntities` in `db.ts` (lines 560-647) — it does NOT
  store dedup lineage.

### What the schema enforces today

- No unique constraint on `research_bioprospecting_facts` (any combination of
  fields). The only uniqueness in the schema is on `research_sources`
  (doi / file_path / content_hash) and `research_evidence_chunks`
  (`(source_id, chunk_index)`).
- Helpful partial btree indexes: `lower(species)`, `lower(genus)`,
  `lower(compound)`, `lower(bioactivity)`, `lower(application_area)` — all
  match-only, not dedup-aware.
- No embedding column on `research_bioprospecting_facts`. The vector column
  lives on `documents` (set up in `src/embeddings/setup.sql` /
  `setup-qwen-2560.sql` with HNSW + `match_documents` RPC).
- No `embedding` column on `research_evidence_chunks` either.

### What the code enforces today

- `replaceBioprospectingFactsForSource` (`db.ts:357-451`) does a
  **delete-by-source then insert** on every extraction. This is implicit
  within-source dedup: re-running extraction for the same source never
  produces in-source duplicates because the old rows are wiped first. It does
  NOT dedup across sources.
- `taxonomy.ts` already dedups taxa and aliases via
  `research_taxa (rank, normalized_name)` and
  `research_taxon_aliases (taxon_id, normalized_alias)`. This is the closest
  existing "normalization + identity" pattern we have, and it works because
  the taxon namespace is small and the normalization function
  (`normalizeTaxonName`, `taxonomy.ts:56-63`) is deterministic.
- `search.ts:1151-1158` defines `normalizeForMatch` (NFKD + diacritic strip
  + non-letter/digit to space + lowercase). The contradiction detector
  (`contradictionDetector.ts:28-33`) uses it to build a
  `compound|bioactivity` grouping key. This is rule-based semantic matching
  limited to two fields.
- No embedding-backed dedup of facts exists. `VectorSearchWithReranker`
  (`embeddings/vectorSearch.ts`) operates on `documents` only.
- No `deduplicateFacts` / `findDuplicateFacts` helper. The word "dedup" in the
  code today refers to (a) document-level ingest dedup via `content_hash` in
  `document-ingestion.worker.ts`, (b) BibTeX ref dedup in
  `services/paper/utils/bibtex.ts`, and (c) contradiction dedup-by-key tests
  in `__tests__/contradictionDetector.test.ts`.

### Extraction flow (the producer of duplicates)

`bioprospectingExtractor.ts`:

- `extractBioprospectingFactsForSource` chunks a source into batches of
  `BIOPROSPECTING_BATCH_CHUNKS` (default 8) and asks the LLM for 0-8
  facts per batch with temperature 0. The LLM is given the title and DOI but
  no canonical entity vocabulary.
- `llmFactsForChunkBatch` runs the prompt per batch with no cross-batch
  awareness. Two adjacent chunks that mention the same species-compound pair
  in slightly different wording will produce two near-identical facts.
- A heuristic fallback (`heuristicFactsFromChunks`) generates one fact per
  chunk that matches `bioactivityPattern|compoundPattern`, also batch-blind.
- `replaceBioprospectingFactsForSource` does not deduplicate the in-memory
  list before inserting.

## Affected Areas

- `src/services/researchBrain/bioprospectingExtractor.ts` — only sensible
  place to add an "early" dedup hook (post-LLM, pre-insert), and the natural
  place to dedupe within the new source.
- `src/services/researchBrain/db.ts` — `replaceBioprospectingFactsForSource`
  is the single chokepoint where facts are persisted; any cross-source
  dedup must be wired in here or in a sibling read-then-merge function.
- `src/services/researchBrain/measurements.ts` — already a precedent for
  post-extraction backfill scripts. The "scan eligible facts, apply a
  transformation, dry-run safe" pattern is a perfect template for a dedup
  backfill worker.
- `src/services/researchBrain/taxonomy.ts` — defines the only working
  normalization-then-canonicalize-then-upsert pattern in the codebase.
  Reusing `normalizeTaxonName` plus a new compound normalizer is the lowest-
  friction option for rule-based dedup.
- `src/embeddings/vectorSearch.ts`, `provider.ts`, `config.ts` — if we go
  embedding-based, we need to either (a) add a `pgvector` column +
  `match_facts` RPC analogous to `match_documents`, or (b) store fact
  embeddings in a sibling table. The `documents` table is for raw chunks,
  not facts, so reusing it is wrong.
- `src/services/researchBrain/contradictionDb.ts` — already has the
  "is this row already present?" pattern (the
  `source_fact_id + conflicting_fact_id + contradiction_type` key in
  `__tests__/contradictionDetector.test.ts:318-398` is the dedup key model
  the contradiction detector uses). The dedup key model for facts will look
  very similar.
- `src/services/researchBrain/types.ts` — `BioprospectingFact` will need new
  optional fields (`fact_hash`, `embedding` reference, `merged_into` pointer,
  `duplicate_of` array, `duplicate_cluster_id`).
- New migration under `supabase/migrations/` — to add an `embedding` column
  on `research_bioprospecting_facts` (or a new
  `research_bioprospecting_fact_embeddings` table) and any new indexes
  (HNSW on embedding, btree on `fact_hash`).
- `src/services/queue/workers/bioprospecting.worker.ts` — the worker would
  gain a third job type (dedup pass) the same way the contradiction job was
  added (shape-based routing on `job.data`).
- `src/chat-agent/tools/research-brain-search.ts` and the
  `searchBioprospectingFacts` code path — if dedup produces
  `merged_into`/`duplicate_of` pointers, search must surface or hide them
  based on a flag.

## Approaches

### 1. Rule-based: normalized compound|species|bioactivity key + hash

Compute `fact_hash = sha256(lowercase(normalize(compound)) + "|" + lowercase(normalize(species)) + "|" + lowercase(normalize(bioactivity)) + "|" + relation_type)` at insert time, add a unique index, and at read time treat same-hash facts from different sources as canonical-record-plus-duplicates.

- Pros: cheap, deterministic, no LLM cost, easy to backfill, replayable. The
  extraction temperature is 0 and the entity vocabulary is small, so this
  already catches most in-source and many cross-source duplicates
  (e.g., `curcumin` vs `Curcuma longa extract` if we add a compound
  alias table; otherwise just exact normalized matches).
- Cons: brittle on paraphrase ("X inhibits Y" vs "X is an inhibitor of Y" =>
  same `bioactivity` after normalize, different `relation_type` => different
  hash, so we still miss them). Won't catch "X has anticancer activity in Y"
  vs "Y shows anticancer effects of X" if species/compound names drift
  between LLM runs.
- Effort: Low.

### 2. Embedding-based: cosine similarity over a `pgvector` column on facts

Add `embedding vector(1536)` (or current model dim) to
`research_bioprospecting_facts`, write a `match_facts` RPC analogous to
`match_documents`, threshold on cosine (`>= 0.92` for merge, `0.80-0.92` for
"related but distinct"). At insert time, query the top-K nearest neighbors
and either reject, merge, or mark as duplicate.

- Pros: handles paraphrase, cross-source overlap, and LLM wording drift.
  Reuses our existing `OpenAIEmbeddingProvider` / `OpenRouterEmbeddingProvider`
  in `src/embeddings/provider.ts`. Plays nicely with future semantic
  retrieval.
- Cons: cost (one embedding per fact, plus a KNN query per insert in the hot
  path), non-deterministic across model versions, threshold tuning needs a
  labeled eval set, and the 1536-dim column bloats row size. Backfill needs
  to embed every existing fact. False positives are dangerous — silently
  merging distinct facts erodes the evidence trail, which is a hard
  violation of the "evidence-grounded claims" mandate in `CLAUDE.md`.
- Effort: Medium-High.

### 3. LLM-based: ask the LLM to dedup after extraction

After `llmFactsForChunkBatch` returns, call a second LLM pass with the
"candidates" list and ask it to mark duplicates. Same idea as the existing
`runLLMDetection` for contradictions (`contradictionLlM.ts`).

- Pros: highest precision on paraphrase and rephrasing. Lowest false-positive
  risk. Reuses the existing LLM plumbing in `llm.ts` and
  `resolveResearchBrainLLM`.
- Cons: doubles (or worse) LLM cost per source. Slows the extraction worker
  materially. Hard to backfill because we'd need to re-run on the original
  chunks. Idempotency across reruns is tricky — the LLM may not agree with
  itself run-to-run, and we already trust the LLM to extract facts, so
  asking it to police itself is a known-weak pattern.
- Effort: Medium.

### 4. Hybrid: rule-based prefilter + LLM verification (recommended)

Two-stage: compute the `fact_hash` from option 1 and use it as a **hard**
merge key (uniqueness enforced by index). Then, for facts that didn't
collide on the hash but might still be paraphrases, run an embedding
similarity check (option 2) only on the *candidates* flagged by a relaxed
rule (same `species_taxon_id` + same `genus_taxon_id` + similar compound
prefix + similar bioactivity). LLM (option 3) is reserved for the small
remaining gray zone, gated by a confidence threshold.

- Pros: cheap in the common case (hash handles exact and trivial-typo
  duplicates), principled escalation (we only call the LLM on a small set),
  and deterministic backfill (hashes are reproducible). Embedding adds
  paraphrase coverage without paying the cost on every insert.
- Cons: more moving parts, three code paths to test. Still needs the
  pgvector column from option 2 if we want paraphrase coverage.
- Effort: Medium.

## Recommendation

**Option 4 (hybrid)**, sequenced as: (a) ship rule-based hash dedup first as
PR1 (it alone eliminates the bulk of duplicates — most in-source duplicates
from the heuristic fallback and most cross-source duplicates on exact
normalized names), (b) add an embedding column and a `match_facts` RPC as
PR2 to catch paraphrases, (c) only if the precision/recall isn't good enough
on the labeled set, add an LLM verification pass for the gray zone as PR3.

This mirrors how `bioprospecting-contradiction-detection` was split (3 PRs,
infrastructure -> engine -> worker integration) and keeps each PR reviewable
under the 400-line budget from `sdd-phase-common.md` section E.

The single most important design decision is what to do when two facts
merge. **We MUST NOT delete the loser row.** CLAUDE.md is explicit that
"every discovery MUST link to supporting evidence" and the
contradiction-detection design already chose the "edges, not deletion" model
(we keep both facts and write a contradiction edge between them). The same
choice applies here: keep both rows, add a `duplicate_of UUID[]` (or a
sibling `research_bioprospecting_fact_duplicates` edge table to stay
consistent with `research_edges`), and let `searchBioprospectingFacts`
filter or surface duplicates per a `includeDuplicates` flag.

## Risks

- **Silent merge breaks the evidence trail.** The hard rule: any dedup
  action must keep both rows and only add an edge/pointer. Do not delete.
- **False positives from the hash.** A compound normalizer that's too
  aggressive (e.g., stripping "extract", "fraction", "derivative") will
  collapse distinct molecular entities. The `taxonomy.ts` precedent is to
  keep normalization conservative and put aliases in a sibling table, not
  mutate the input.
- **Embedding model drift.** If we add an embedding column and later swap
  the model, the cosine thresholds become invalid. Either version-pin the
  model in the migration, or store the model name alongside the embedding.
- **Backfill is O(N) facts.** The `measurements.ts` backfill already caps at
  500 per run; a dedup backfill will need the same cap and likely a
  resume/cursor pattern, otherwise the job dies mid-corpus and we have a
  half-deduped state.
- **Search results reorder.** If `searchBioprospectingFacts` filters out
  duplicates by default, users will see fewer results. The UI/API must make
  it obvious when it has done so.
- **Compounds are the hardest entity to normalize.** We have no compound
  authority analogous to WoRMS for species. Building one is a project of
  its own; for v1, normalize conservatively (lowercase, diacritics, whitespace,
  common suffixes like "extract", "fraction") and add a `compound_aliases`
  table only when we have data to populate it.
- **Review status interaction.** A `verified` fact must never be silently
  merged into a `needs_review` one. The merge policy must respect review
  status and prefer the more-reviewed record as canonical.

## Open Questions

1. **What's the actual duplicate rate?** We need a quick analysis (one-off
   query) to count how many of the existing facts would be flagged by the
   hash-only approach before we commit to the embedding column. If the hash
   alone covers >80%, the embedding column is a v2.
2. **Compound aliases** — do we have any? A grep on existing facts will tell
   us whether `curcumin` vs `Curcuma longa extract` is a real problem in
   the current corpus or hypothetical.
3. **Should dedup be opt-in per source?** The trust_tier split
   (`internal` vs `external`) suggests "external" sources may be noisier
   and benefit from stricter dedup. A per-source `dedup_enabled` flag is
   cheap to add and easy to default safely.
4. **Where does dedup live in the job DAG?** Options: (a) inline in the
   extraction worker before insert, (b) separate dedup worker queued after
   extraction, (c) backfill-only. (a) is the only one that prevents
   duplicates from ever being inserted; (b) is more flexible; (c) is the
   minimum viable version. Recommend (a) for in-source and a backfill for
   cross-source, since (b) is what `bioprospecting-contradiction-detection`
   already does for a similar problem and is a known-good pattern.
5. **Review-status precedence** — when merging a verified fact with an
   unreviewed one, the merge should bias toward the verified one. We need
   a written precedence rule before the algorithm can be deterministic.

## Estimated Complexity

**Medium.** A single-developer implementation across three PRs:

- PR1 (rule-based hash + in-source dedup at extract time + backfill script):
  ~200-300 LOC, 1 day.
- PR2 (pgvector column + `match_facts` RPC + embedding generation hook +
  cross-source dedup pass): ~300-400 LOC, 1-2 days.
- PR3 (optional LLM gray-zone verifier, gated on the labeled eval showing
  we need it): ~200 LOC, 1 day.

The risk is not complexity but scope creep — it's tempting to also add a
compound authority and a UI for reviewing duplicates, both of which are
separate projects. Keep the scope to "detect and link duplicates" and
resist the urge to expand it in v1.

## Ready for Proposal

Yes. The user has a clear ask, the code paths are well-understood, the
schema changes are minimal (one new column or sibling table, one new
index), and there is an obvious sequenced PR plan that respects the 400-line
review budget. Recommend the orchestrator move to `sdd-propose` with a
scope limited to PR1 (rule-based hash dedup) so the user can decide whether
to fund PR2/3 based on the deduplication rate PR1 reveals.
