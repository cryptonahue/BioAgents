# Spec: bioprospecting-fact-dedup

## Purpose

Prevent the `research_bioprospecting_facts` table from accumulating
near-identical rows across extraction runs and sources. This capability
combines deterministic identity-key normalization, inline merge at insertion
time, an edge-table lineage model, and filtered search.

The capability preserves full provenance — both canonical and merged rows
continue to exist in the facts table; merge relationships are recorded in a
dedicated edge table. This is a Phase 1 rule-based implementation; a future
embedding-backed tier is anticipated (`match_rule = 'embedding'` is reserved
in the schema but is not emitted by this change).

## Requirements

### Requirement: Bioprospecting Fact Deduplication Capability

The system MUST provide a `bioprospecting-fact-dedup` capability that prevents the
`research_bioprospecting_facts` table from accumulating near-identical rows across
extraction runs and sources. The capability combines deterministic identity-key
normalization, inline merge at insertion time, an edge-table lineage model, and
filtered search.

#### Scenario: Inline merge during extraction

- GIVEN a source with an in-progress extraction that produces N incoming facts
  where K groups (K ≥ 1) share an identity key
- WHEN `replaceBioprospectingFactsForSource` runs
- THEN one canonical row is inserted per group
- AND (K − 1) non-canonical rows per group are still inserted (the source-wipe
  invariant is preserved)
- AND (K − 1) edge rows are inserted into `research_bioprospecting_fact_edges`
  pointing from each merged fact to its canonical fact

#### Scenario: Search filters merged facts by default

- GIVEN a database state where some facts are present in
  `research_bioprospecting_fact_edges.merged_fact_id`
- WHEN a caller invokes `searchBioprospectingFacts` without
  `includeDuplicates: true`
- THEN the result set MUST NOT include any row whose `id` appears in
  `research_bioprospecting_fact_edges.merged_fact_id`
- AND the result count MUST equal the canonical-row count for the same query

#### Scenario: Search exposes duplicates on demand

- GIVEN the same database state as the previous scenario
- WHEN a caller invokes `searchBioprospectingFacts` with
  `includeDuplicates: true`
- THEN the result set MUST include both canonical and merged rows
- AND the result count MUST exceed the canonical-only count by exactly the
  number of merged rows matched by the query

### Requirement: Identity-Key Normalization

The system MUST normalize the fields that contribute to a fact's identity key
using a conservative, deterministic algorithm before grouping or comparing
facts. Normalization is purely a string transform: it does not consult
taxonomy tables, does not collapse suffixes, does not fold plurals, and does
not apply chemistry-aware transforms.

**Normalization rules** (applied in order):

1. Unicode NFKD normalization.
2. Strip all combining diacritics (`\p{Diacritic}`).
3. Replace any non-letter, non-digit run with a single space.
4. Collapse consecutive whitespace to a single space.
5. Trim leading and trailing whitespace.
6. Lowercase.

The function MUST be exported as `normalizeForIdentity(value: string): string`
from `src/services/researchBrain/normalize.ts` and MUST delegate the
NFKD + diacritic + non-alphanumeric steps to the existing
`normalizeForMatch` from `src/services/researchBrain/search.ts` so the two
normalizers share the same primitive behavior; `normalizeForIdentity` adds
the whitespace collapse and lowercase tail.

#### Scenario: Diacritic-bearing names collapse to ASCII

- GIVEN the input `"  Árból  marítimum  "`
- WHEN `normalizeForIdentity` runs
- THEN the result is `"arbol maritimum"`

#### Scenario: Punctuation and casing are not part of the key

- GIVEN inputs `"Quercetin"`, `"  quercetin "`, `"QUERCETIN,"`, and
  `"querce-tin"`
- WHEN `normalizeForIdentity` runs on each
- THEN the first three return the identical string `"quercetin"`
- AND the fourth returns `"querce tin"` (the dash collapses to a space, not a
  removal), so it is NOT identical to the first three
- AND facts with these different keys are NOT merged

#### Scenario: Chemically distinct compounds stay distinct

- GIVEN inputs `"quercetin"` and `"quercetin-3-O-glucoside"`
- WHEN `normalizeForIdentity` runs on each
- THEN the results differ (`"quercetin"` vs
  `"quercetin 3 o glucoside"`)
- AND the system MUST NOT merge facts with these two keys

### Requirement: Identity Key Construction

The system MUST compute a deterministic identity key for a fact from a
fixed tuple of fields, joined with a stable separator:

- `normalizeForIdentity(species)`
- `normalizeForIdentity(compound)`
- `normalizeForIdentity(bioactivity)`
- `normalizeForIdentity(organism_part)`
- `normalizeForIdentity(geography)`

The function MUST be exported as
`buildIdentityKey(fact: BioprospectingFact): string | null`. If all five
contributing fields are null/empty, the function MUST return `null` and the
fact MUST NOT be eligible for identity-key-based dedup. High-cardinality
fields MUST NOT participate in the key: `result_summary`, `quote`,
`measurement_value`, `measurement_unit`, `measurement_min`, `measurement_max`,
`measurement_direction`, `p_value`, `sample_size`, `timepoint`, `condition`,
and `application_area` are excluded by design.

#### Scenario: Identity key is stable across re-runs

- GIVEN a fact with the same species/compound/bioactivity/organism_part/geography
  values on two separate extractions
- WHEN `buildIdentityKey` is called on each
- THEN the two keys MUST be byte-identical

#### Scenario: All identity fields blank produces null key

- GIVEN a fact with `species`, `compound`, `bioactivity`, `organism_part`, and
  `geography` all null or empty
- WHEN `buildIdentityKey` is called
- THEN the result MUST be `null`
- AND the system MUST NOT attempt to merge the fact on identity key

#### Scenario: High-cardinality fields do not affect the key

- GIVEN two facts with identical species/compound/bioactivity/organism_part/
  geography but different `result_summary`, different `measurement_value`,
  and different `quote`
- WHEN `buildIdentityKey` is called on each
- THEN the two keys MUST be identical
- AND the two facts MUST be eligible to merge

### Requirement: research_bioprospecting_fact_edges Edge Table

The system MUST create a `research_bioprospecting_fact_edges` table that
records merge lineage between facts. The table preserves full provenance
(both rows continue to exist) and follows the same edge-table pattern as the
existing `research_edges` table.

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS public.research_bioprospecting_fact_edges (
  canonical_fact_id UUID NOT NULL REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  merged_fact_id    UUID NOT NULL REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  match_rule        TEXT NOT NULL CHECK (match_rule IN ('identity_key', 'embedding')),
  merged_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (canonical_fact_id, merged_fact_id),
  CHECK (canonical_fact_id <> merged_fact_id)
);
```

**Columns:**

- `canonical_fact_id` — the surviving row returned by canonical selection.
- `merged_fact_id` — the non-canonical row that was collapsed into the
  canonical. MUST be different from `canonical_fact_id` (enforced by CHECK).
- `match_rule` — how the merge was decided. The Phase 1 implementation MUST
  only emit `'identity_key'`. `'embedding'` is reserved for a future
  pgvector-backed tier and MUST NOT be written by this change.
- `merged_at` — server timestamp at edge insertion.

**Indexes:**

```sql
CREATE INDEX IF NOT EXISTS idx_bioprospecting_fact_edges_canonical
  ON public.research_bioprospecting_fact_edges (canonical_fact_id);
CREATE INDEX IF NOT EXISTS idx_bioprospecting_fact_edges_merged
  ON public.research_bioprospecting_fact_edges (merged_fact_id);
```

The composite primary key `(canonical_fact_id, merged_fact_id)` is the
authoritative uniqueness guard; the additional CHECK prevents
self-edges, and the per-column indexes support reverse lookup
("which canonical owns this merged row?" and "which rows are merged into
this canonical?").

#### Scenario: Edge row preserves both facts

- GIVEN a merge between fact A and fact B
- WHEN the edge is inserted
- THEN a row exists in `research_bioprospecting_fact_edges` with
  `(canonical_fact_id, merged_fact_id, match_rule='identity_key', merged_at)`
- AND both fact A and fact B still exist in
  `research_bioprospecting_facts`
- AND no fact is hard-deleted by the dedup logic

#### Scenario: Composite primary key prevents double edges

- GIVEN an existing edge `(canonical_fact_id=A, merged_fact_id=B)`
- WHEN an insert attempt with the same `(canonical_fact_id=A, merged_fact_id=B)`
  is made
- THEN the insert MUST fail with a primary-key violation
- AND the backfill script MUST treat this as "skipped, already merged"

#### Scenario: Self-edges are rejected

- GIVEN any pair where `canonical_fact_id = merged_fact_id`
- WHEN an insert is attempted
- THEN the insert MUST fail with the CHECK constraint violation

### Requirement: Generated identity_key Column on research_bioprospecting_facts

The system MUST add a stored generated column `identity_key` to
`research_bioprospecting_facts` whose value is `buildIdentityKey(fact)`.
The column MUST be nullable so existing rows are back-compat until the
backfill script runs.

**Schema:**

```sql
ALTER TABLE public.research_bioprospecting_facts
  ADD COLUMN identity_key TEXT
  GENERATED ALWAYS AS (
    lower(
      trim(
        btrim(
          coalesce(
            regexp_replace(
              translate(species, 'ÁÉÍÓÚÀÈÌÒÙÂÊÎÔÛÄËÏÖÜÇÑáéíóúàèìòùâêîôûäëïöüçñ',
                        'AEIOUAEIOUAEIOUAEIOUCNaeiouaeiouaeiouaeioucn'),
              '[^a-zA-Z0-9]+', ' ', 'g'
            ),
            ''
          )
          || '|' || coalesce(...)
        )
      )
    )
  ) STORED;
```

The exact generated expression is the database equivalent of
`buildIdentityKey` and MUST use the same conservative normalization
(NFKD-equivalent ASCII-fold, non-alphanumeric → space, collapse whitespace,
lowercase, trim). The column MUST be re-evaluated by the database on every
insert and update of the contributing fields. The system MUST also create
a partial unique index:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_bioprospecting_facts_identity_key_unique
  ON public.research_bioprospecting_facts (identity_key)
  WHERE identity_key IS NOT NULL;
```

#### Scenario: Insert computes identity_key automatically

- GIVEN a row inserted with `species='Aloe vera'`, `compound='quercetin'`,
  `bioactivity='antibacterial'`, `organism_part='leaf'`,
  `geography='Mexico'`
- WHEN the row is read back
- THEN `identity_key` MUST equal
  `normalizeForIdentity('Aloe vera') + '|' + normalizeForIdentity('quercetin') + '|' + normalizeForIdentity('antibacterial') + '|' + normalizeForIdentity('leaf') + '|' + normalizeForIdentity('Mexico')`

#### Scenario: Null fields produce a stable key

- GIVEN a row where four of the five contributing fields are null and
  `species='Aloe vera'`
- WHEN the row is read back
- THEN `identity_key` MUST equal
  `normalizeForIdentity('Aloe vera') + '|null|null|null|null'`
  (or whatever the SQL-side null-joining convention resolves to —
  the exact format is implementation-defined but MUST be stable)

#### Scenario: Partial unique index prevents two canonical rows with the same key

- GIVEN two existing rows with the same `identity_key` and neither appears in
  `research_bioprospecting_fact_edges.merged_fact_id`
- WHEN a third insert attempts the same `identity_key`
- THEN the insert MUST fail with a unique-index violation
- AND the application layer MUST treat this as a dedup collision and either
  insert the row as merged (with an edge) or surface a clear error

### Requirement: Inline Merge in replaceBioprospectingFactsForSource

The system MUST perform an inline merge in
`replaceBioprospectingFactsForSource` after the per-source delete. Inline
merge prevents both within-source duplicates (re-running extraction on a
noisy LLM) and cross-source duplicates (a fact with the same identity key
re-extracted into a different source-wipe cycle).

**Inline merge algorithm:**

1. Compute `identity_key` (TS-side) for every incoming fact via
   `buildIdentityKey`.
2. Group incoming facts by `identity_key` (nulls are singletons, no merge).
3. Within each group, select the canonical row using the precedence rule:
   - A row with `review_status = 'verified'` wins over any non-verified row.
   - If multiple rows are verified, the one with the most recent
     `updated_at` wins; ties break by `source_id` ascending (deterministic).
   - If no row is verified, the most recent `updated_at` wins; ties break by
     `source_id` ascending.
4. For each group of size 1, insert that one fact unchanged.
5. For each group of size K ≥ 2:
   - Insert the canonical row first.
   - For each non-canonical sibling, insert the sibling (preserving the
     source-wipe invariant) and then insert an edge row
     `(canonical_fact_id, merged_fact_id, 'identity_key', NOW())`.
6. If the canonical-row insert fails with a unique-index violation (a
   pre-existing row already owns the key), re-route: the existing row is
   treated as canonical and the new row(s) become merged edges into it.

The source-wipe invariant — that re-running extraction on a source removes
that source's prior facts — MUST NOT be weakened. The merge is in addition
to the wipe, not a replacement for it.

#### Scenario: Verified row wins canonical selection

- GIVEN an incoming group of three facts with the same `identity_key`:
  one has `review_status='verified'`, one `'unreviewed'`, one `'needs_review'`
- WHEN the inline merge runs
- THEN the verified fact is inserted as the canonical
- AND the other two are inserted as merged with edges pointing to the
  verified row's `id`

#### Scenario: All-unverified group falls back to most-recent

- GIVEN an incoming group of three facts with the same `identity_key` and
  review_statuses `'unreviewed'`, `'needs_review'`, `'unreviewed'`
- WHEN the inline merge runs
- THEN the canonical is the row with the most recent `updated_at`
- AND ties are broken by `source_id` ascending (lowest UUID wins)
- AND the other two are inserted as merged

#### Scenario: Identity-key nulls do not merge

- GIVEN two facts whose `buildIdentityKey` returns `null` (all five identity
  fields blank)
- WHEN the inline merge runs
- THEN each fact is inserted independently
- AND no edge row is created
- AND no merge is attempted

#### Scenario: Cross-source merge on re-extract

- GIVEN a fact F1 already persisted in `research_bioprospecting_facts` with
  `identity_key = K` and no edge row pointing to it as `merged_fact_id`
- WHEN a new extraction for a different source produces fact F2 with
  `identity_key = K`
- AND `replaceBioprospectingFactsForSource` runs for the new source
- THEN the canonical-row insert for F2 raises a unique-index violation
- AND the system re-routes: F2 is inserted as a row, and an edge
  `(canonical_fact_id=F1.id, merged_fact_id=F2.id, 'identity_key', NOW())`
  is written
- AND the existing F1 row is untouched

#### Scenario: Source-wipe invariant preserved

- GIVEN a source S with two existing facts S1 and S2
- WHEN `replaceBioprospectingFactsForSource` runs with one incoming fact S3
- THEN S1 and S2 are deleted before any insert
- AND the only post-call rows for source S are S3 (and any edge rows whose
  merged_fact_id belongs to facts in OTHER sources)

### Requirement: Backfill Script for Existing Facts

The system MUST provide a one-shot backfill script at
`scripts/backfill-dedupe-bioprospecting-facts.ts` that dedupes the
`research_bioprospecting_facts` table as it exists before this change ships.
The script MUST mirror the shape of
`scripts/normalize-measurements.ts` (CLI flags, batched commits, logged
progress, idempotent).

**Script behavior:**

- CLI flags: `--dry-run` (default), `--apply` (commit), `--limit=N`,
  `--batch-size=N` (default 500).
- Read facts where the migration has not yet populated the merge
  relationship (e.g., facts with no outgoing edge from a "canonical" they
  own) or, more simply, all facts not yet present as `merged_fact_id` in
  the edge table.
- Compute `buildIdentityKey` in-memory for each candidate.
- Group by `identity_key` (skip nulls).
- For each group of size K ≥ 2, apply the same canonical-selection rule
  (verified wins, else most-recent `updated_at`, tiebreak by `source_id`).
- For each non-canonical sibling: in `--apply` mode, insert an edge row
  pointing to the canonical. In `--dry-run` mode, log the proposed edge
  without writing.
- Idempotency: skip any pair where the edge
  `(canonical_fact_id, merged_fact_id)` already exists (primary-key
  violation is treated as success).
- Log stats: `scannedFacts`, `groupsFound`, `edgesProposed`,
  `edgesInserted`, `edgesSkipped`, and up to 10 example group
  summaries (canonical id, merged ids, identity_key, review_statuses).

**Important:** the script is additive. It MUST NOT delete, mutate, or
re-canonicalize any fact row. It only inserts edge rows. Re-running on the
same data MUST produce a stable, identical edge count.

#### Scenario: Dry-run reports stats without writing

- GIVEN a populated `research_bioprospecting_facts` table
- WHEN the backfill script runs with `--dry-run`
- THEN it scans facts, groups by identity key, and reports the
  proposed edge count
- AND it MUST NOT insert any edge row
- AND exit code is 0

#### Scenario: Apply inserts edges idempotently

- GIVEN a populated `research_bioprospecting_facts` table with M
  near-duplicate groups
- WHEN the backfill script runs with `--apply`
- THEN M edge rows are inserted (one per non-canonical sibling)
- AND a second run with `--apply` reports `edgesInserted: 0` and
  `edgesSkipped: M` (idempotent)
- AND the edge count after the second run equals the edge count after the
  first

#### Scenario: Backfill leaves facts untouched

- GIVEN any fact row in `research_bioprospecting_facts`
- WHEN the backfill script runs (dry-run or apply)
- THEN no fact row is updated, deleted, or re-canonicalized
- AND the script is safe to re-run any number of times

### Requirement: Search Behavior with includeDuplicates Flag

The system MUST extend the `BioprospectingFactSearchParams` type with an
optional `includeDuplicates?: boolean` field, defaulting to `false`. The
flag controls whether `searchBioprospectingFacts` returns rows that are
listed as `merged_fact_id` in `research_bioprospecting_fact_edges`.

**Default behavior (flag absent or `false`):** every result row MUST be
filtered through a `WHERE id NOT IN (SELECT merged_fact_id FROM
research_bioprospecting_fact_edges)` predicate. The filter is applied at
the SQL layer (not in JS post-fetch) to keep result counts consistent with
`limit`.

**Flag set to `true`:** the filter is omitted. Both canonical and merged
rows are returned. The function MUST still respect all other
`BioprospectingFactSearchParams` filters (source, review status,
measurement, query string).

The JSDoc on `searchBioprospectingFacts` MUST document the default and
warn callers that the merged-row filter is on by default. This is the
only behavioral change to the search path; ranking, dedup of equal
results, and source filtering are untouched.

#### Scenario: Default search omits merged rows

- GIVEN a query that matches both a canonical fact C and a merged fact M
  (where M appears in `research_bioprospecting_fact_edges.merged_fact_id`)
- WHEN `searchBioprospectingFacts` runs with default params
- THEN the result set contains C
- AND the result set does NOT contain M
- AND the result count for the same query with `includeDuplicates: true`
  exceeds the default count by exactly 1 (for this scenario)

#### Scenario: includeDuplicates: true returns both

- GIVEN the same setup as the previous scenario
- WHEN `searchBioprospectingFacts` runs with `includeDuplicates: true`
- THEN the result set contains both C and M
- AND the result set count is exactly the default count plus 1 (in this
  scenario) or the merged-row count matched by the query (in general)

#### Scenario: Other filters still apply

- GIVEN `params: { query: "quercetin", reviewStatus: "verified", includeDuplicates: true }`
- WHEN the search runs
- THEN the result set contains only verified facts that match "quercetin"
- AND unverified merged facts matching the query are excluded by the
  review-status filter, not by the merge filter

### Requirement: read-only Lineage Helpers

The system MUST provide read-only helpers that surface dedup lineage
without writing:

- `findMergedFactIds(factIds: string[]): Promise<Set<string>>` — returns the
  set of input fact IDs that appear as `merged_fact_id` in the edge table.
- `getDuplicateGroup(factId: string): Promise<{ canonical: BioprospectingFact; merged: BioprospectingFact[] } | null>` — given any fact id
  (canonical or merged), returns the group it belongs to. Returns `null`
  if the fact is not in any edge and is not referenced as a canonical
  by any edge.

These helpers MUST be exported from `src/services/researchBrain/db.ts`
alongside `searchBioprospectingFacts`. They are read-only: no insert,
update, or delete. They MUST NOT mutate `research_bioprospecting_facts` or
`research_bioprospecting_fact_edges`.

#### Scenario: findMergedFactIds returns the correct subset

- GIVEN a fact set `{A, B, C, D}` where `B` and `D` are `merged_fact_id`
  in the edge table
- WHEN `findMergedFactIds([A, B, C, D])` is called
- THEN the result is `{B, D}`

#### Scenario: getDuplicateGroup resolves from either side

- GIVEN an edge `(canonical_fact_id=C, merged_fact_id=M)`
- WHEN `getDuplicateGroup(C.id)` is called
- THEN the result is `{ canonical: C, merged: [M] }`
- AND when `getDuplicateGroup(M.id)` is called
- THEN the result is the same `{ canonical: C, merged: [M] }`

#### Scenario: getDuplicateGroup returns null for standalone facts

- GIVEN a fact F that is neither a `canonical_fact_id` nor a
  `merged_fact_id` in any edge
- WHEN `getDuplicateGroup(F.id)` is called
- THEN the result is `null`

### Requirement: Type Updates for Dedup Lineage

The system MUST extend the `BioprospectingFact` TypeScript type and add
a sibling `BioprospectingFactEdge` type. The new fields are read-only
metadata surfaced to callers (populated by joins in the search and
helper code, not persisted on `research_bioprospecting_facts` itself).

**New type:**

```typescript
export type BioprospectingFactEdge = {
  canonical_fact_id: string;
  merged_fact_id: string;
  match_rule: "identity_key" | "embedding";
  merged_at: string;
};
```

**Extended `BioprospectingFact`:**

```typescript
export type BioprospectingFact = {
  // ... existing fields ...
  identity_key?: string | null;
  merged_into_fact_id?: string | null;  // present iff this row is merged
};
```

- `identity_key` is the database-generated column; it is exposed for
  debugging and future callers but the source of truth remains the
  database.
- `merged_into_fact_id` is populated only when the row is a merged
  sibling; for canonical and standalone facts it is `null` or undefined.
  This is the inverse of `research_bioprospecting_fact_edges.merged_fact_id`:
  if `merged_into_fact_id` is set, the row is non-canonical and
  MUST be hidden by the default search.

The existing `BioprospectingFact` shape MUST stay backwards compatible:
adding optional fields MUST NOT break existing callers.

#### Scenario: merged fact carries a merged_into_fact_id

- GIVEN a fact row F whose `id` appears in
  `research_bioprospecting_fact_edges.merged_fact_id`
- WHEN the row is loaded via the search or lineage helpers
- THEN `F.merged_into_fact_id` is set to the matching `canonical_fact_id`

#### Scenario: canonical fact has no merged_into_fact_id

- GIVEN a fact row C that is a `canonical_fact_id` for some edge but is
  itself not a `merged_fact_id` anywhere
- WHEN C is loaded
- THEN `C.merged_into_fact_id` is `null` or undefined

## ADDED Requirements (bioprospecting-compound-authority delta)

This section is the delta introduced by the
`bioprospecting-compound-authority` change. The baseline contract
above is preserved unchanged. The delta is purely clarifications:
the 5-tuple `identity_key` is the sole inline dedup driver, and
the new `compound_canonical_id` / `compound_authority_status`
columns are a parallel signal that MUST NOT affect merge decisions.

### Requirement: Bioprospecting Fact Deduplication Capability (clarification)

The `bioprospecting-fact-dedup` capability MUST continue to
deduplicate on the 5-tuple `identity_key` (normalized
species/compound/bioactivity/organism_part/geography) and
MUST NOT use `compound_canonical_id` as a dedup input. The
canonical id is a parallel signal surfaced for UI display and
admin views, not a driver of inline merge.

This is a clarification of the existing requirement, not a
behavior change. It is documented here so the
`bioprospecting-compound-authority` change does not implicitly
introduce canonical-id-based dedup.

#### Scenario: Two facts with the same raw text but different canonical ids are still merged

- GIVEN two facts F1 and F2 with the same 5-tuple
  `identity_key = K`
- AND F1's `compound_canonical_id` resolves to C_curcumin via
  the alias table
- AND F2's `compound_canonical_id` is NULL (alias miss,
  pending)
- WHEN `replaceBioprospectingFactsForSource` runs
- THEN F1 and F2 are grouped by K
- AND one is selected as canonical (verified wins, else
  most-recent)
- AND the other is inserted as merged with an edge
- AND the merge decision is unaffected by the difference in
  `compound_canonical_id`

#### Scenario: Two facts with different raw text but the same canonical id are NOT merged

- GIVEN F1 with `compound = 'curcumin'` and
  `compound_canonical_id = C_curcumin`
- AND F2 with `compound = 'diferuloylmethane'` and
  `compound_canonical_id = C_curcumin`
- AND the 5-tuple of F1 differs from the 5-tuple of F2 in at
  least one non-compound field
- WHEN `replaceBioprospectingFactsForSource` runs
- THEN F1 and F2 are NOT grouped together
- AND no edge row is inserted between them
- AND both are persisted as separate canonical rows

### Requirement: Compound Authority Status Attached on Insertion (clarification)

The `replaceBioprospectingFactsForSource` function MUST
populate the four new compound authority columns on every
inserted fact. The status is decided by
`resolveCompoundStatus(fact.compound)` and is one of:

- `'pending'` — no alias match, value does not match
  `looksLikeExtract`. The worker will retry.
- `'verified'` — alias-table hit. The canonical id is
  stamped synchronously.
- `'skipped'` — `looksLikeExtract` is true. No canonical id.
- `'failed'` — SHOULD NOT appear in fresh inserts. Reserved
  for the backfill worker's exhaustion case.

The `compound_authority_at` column is set to `NOW()` for
`'verified'` and `'skipped'` rows, and to `NULL` for fresh
`'pending'` rows (the worker fills it on the first retry).

This is a clarification: the column population is required by
the new compound authority capability, and it happens inside
the existing insert path, not as a separate post-pass.

#### Scenario: Fresh extraction sets pending status

- GIVEN a fact F with `compound = 'obscurenaturalproduct'`
  that is not in the alias table and does not match the
  extract predicate
- WHEN `replaceBioprospectingFactsForSource` persists F
- THEN `compound_canonical_id = NULL`
- AND `compound_authority_status = 'pending'`
- AND `compound_authority_at = NULL`

#### Scenario: Fresh extraction with alias hit sets verified

- GIVEN the alias table contains
  `(alias = 'diferuloylmethane', compound_id = C_curcumin)`
- AND a fact F with `compound = 'diferuloylmethane'`
- WHEN `replaceBioprospectingFactsForSource` persists F
- THEN `compound_canonical_id = C_curcumin.id`
- AND `compound_authority_status = 'verified'`
- AND `compound_authority_at = NOW()`

#### Scenario: Fresh extraction of an extract sets skipped

- GIVEN a fact F with `compound = 'Curcuma longa extract'`
- WHEN `replaceBioprospectingFactsForSource` persists F
- THEN `compound_canonical_id = NULL`
- AND `compound_authority_status = 'skipped'`
- AND `compound_authority_error = 'extract_or_mixture'`

### Requirement: Strong Dedup Tier Deferred to v2 (out-of-scope)

The Phase 1 implementation MUST NOT introduce a
`match_rule = 'canonical_id'` edge variant. The
`research_bioprospecting_fact_edges.match_rule` column is
already constrained to `('identity_key', 'embedding')` and the
Phase 1 code MUST NOT relax that constraint. A future change
MUST add a third value `'canonical_id'` (or a separate edge
table) to support a "strong dedup" tier that merges facts by
canonical compound id rather than raw text.

This is a non-goal recorded for the next change: v2 strong
dedup is expected to:

- merge facts that share a canonical id but have different
  raw `compound` text (e.g. "curcumin" and "diferuloylmethane"
  both resolving to C_curcumin),
- re-rank the merge precedence (canonical id wins over raw
  5-tuple when both disagree),
- preserve the existing edge table by either extending the
  `match_rule` enum or introducing a new edge table.

#### Scenario: v1 code does not emit canonical_id edges

- GIVEN the v1 code
- WHEN an inline merge runs
- THEN every edge row has `match_rule = 'identity_key'`
- AND no edge row has `match_rule = 'canonical_id'`
- AND the CHECK constraint is unchanged

#### Scenario: v1 schema does not relax the match_rule enum

- GIVEN the v1 migration
- WHEN the migration runs
- THEN the `match_rule` CHECK constraint is
  `CHECK (match_rule IN ('identity_key', 'embedding'))`
- AND a future migration to add `'canonical_id'` is required
  before the v2 dedup tier can emit such edges
