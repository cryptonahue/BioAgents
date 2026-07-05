# Delta for bioprospecting-fact-dedup

This is the first delta to the `bioprospecting-fact-dedup`
capability. The capability exists in the codebase as the inline
merge in `replaceBioprospectingFactsForSource` (see
`src/services/researchBrain/db.ts`) and the
`research_bioprospecting_fact_edges` edge table. This delta
documents the explicit invariant that the 5-tuple
`identity_key` is **unchanged** by the introduction of
`bioprospecting-compound-authority`, and that canonical compound
ids are a parallel signal — not a replacement for the raw-text
dedup key.

The "Baseline" subsection captures the pre-delta contract. The
"ADDED" and "MODIFIED" subsections capture the new behavior
introduced by `bioprospecting-compound-authority`. Future
changes can build on this stable baseline + delta.

## Baseline (Pre-Delta Behavior)

The following describes the pre-delta behavior of the
`bioprospecting-fact-dedup` capability. Future changes MUST
treat these as the unchanged contract unless an explicit
`MODIFIED` requirement below overrides them.

- `replaceBioprospectingFactsForSource` groups incoming facts
  by `identity_key` (the 5-tuple of normalized
  species/compound/bioactivity/organism_part/geography) and
  selects one canonical row per group. Non-canonical siblings
  are still inserted and linked via
  `research_bioprospecting_fact_edges`.
- The 5-tuple is the **sole** inline dedup driver. Canonical
  ids from `research_compounds` are not consulted during
  dedup.
- The `identity_key` column is a stored generated column on
  `research_bioprospecting_facts`. It is byte-stable across
  re-extractions and partial-unique-indexed.
- The backfill script dedupes the existing
  `research_bioprospecting_facts` table on the same 5-tuple
  rule.

## ADDED Requirements

None. The 5-tuple `identity_key` shape is preserved as-is. The
new compound authority columns are a parallel signal (see the
`research-bioprospecting` delta).

## MODIFIED Requirements

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

## REMOVED Requirements

None.

## RENAMED Requirements

None.
