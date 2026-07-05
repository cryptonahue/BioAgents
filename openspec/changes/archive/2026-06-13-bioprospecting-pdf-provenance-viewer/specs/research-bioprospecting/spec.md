# Delta for research-bioprospecting

This is the first delta to the `research-bioprospecting` capability.
The capability exists in the codebase as
`src/services/researchBrain/bioprospectingExtractor.ts` and is
invoked from the document ingestion worker pool after PDF chunking
completes. This delta adds table-aware extraction: extracted tables
are now visible to the LLM, and facts extracted from table rows are
linked back to the source row via `evidence_table_id`.

The capability is being formally specified in this delta so future
changes can build on stable behavior. The "Baseline" subsection
captures the pre-delta contract; the "ADDED" and "MODIFIED"
subsections capture the new behavior.

## Baseline (Pre-Delta Behavior)

The following describes the pre-delta behavior of the
`research-bioprospecting` capability. Future changes MUST treat
these as the unchanged contract unless an explicit `MODIFIED`
requirement below overrides them.

The capability extracts bioprospecting facts from research PDFs by
feeding chunked text to an LLM and persisting the structured
output. Concretely:

- `extractBioprospectingFactsForSource(sourceId)` is the public
  entry point. It reads `research_evidence_chunks` for the
  source, batches them at `BIOPROSPECTING_BATCH_CHUNKS` (default
  8), and calls
  `llmFactsForChunkBatch(title, doi, batch)` for each batch.
- The LLM is given a prompt instructing it to "Return ONLY a
  valid JSON array" of fact objects, with strict rules about
  quoting the source, supporting measurement fields, and
  preferring organism/molecule/activity/application context.
- Each batch call has a `BIOPROSPECTING_BATCH_TIMEOUT_MS` (default
  120000) and `BIOPROSPECTING_BATCH_RETRIES` (default 1).
- The output JSON is normalized via `normalizeFacts` and the
  canonical selection / inline merge logic in
  `replaceBioprospectingFactsForSource` (defined in the
  `bioprospecting-fact-dedup` capability) handles identity-key
  dedup before persisting.
- Status transitions on `research_sources.extraction_status`:
  `pending_extraction` → `running` → (`completed` | `no_chunks` |
  `failed`).

This baseline MUST be preserved. The delta below augments, does
not replace, the existing flow.

## ADDED Requirements

### Requirement: Tables Prompt Section In Bioprospecting LLM

The system MUST inject cached extracted tables into the
bioprospecting LLM prompt as a distinct `tables:` section,
rendered by the helper
`buildTablesPromptSection(tables: ExtractedTable[]): string`
defined in the `pdf-table-extraction` capability.

**Behavior:**

- `llmFactsForChunkBatch(title, doi, chunks)` MUST load the cached
  tables for the source's `sourceId` from
  `research_evidence_tables` (via
  `loadTablesForSource(sourceId)`).
- If the cache is non-empty, the prompt MUST include the
  `tables:` section (the output of
  `buildTablesPromptSection(tables)`) immediately before the
  `Chunks:` section.
- If the cache is empty (no tables extracted, or the
  `pdf-table-extraction` capability has not yet run for this
  source), the prompt MUST NOT include the `tables:` section
  and MUST continue with the existing `Chunks:` section
  unchanged. The behavior MUST be backwards-compatible with
  sources that have no extracted tables.
- The prompt MUST include the rule "prefer measurements from
  tables over prose" as an explicit instruction (see the
  "Prefer Tables Over Prose" requirement below).

The function `loadTablesForSource(sourceId)` MUST be a thin
read-only wrapper around the existing
`research_evidence_tables` table, exported from
`src/services/researchBrain/tables.ts` (or a sibling module) so
the extractor and the viewer can share the same loader.

#### Scenario: Tables section is injected when cache is non-empty

- GIVEN `sourceId = S` with 2 cached tables in
  `research_evidence_tables`
- WHEN `llmFactsForChunkBatch(title, doi, chunks)` is called
- THEN the prompt includes a `tables:` section with both tables
  rendered by `buildTablesPromptSection`
- AND the `tables:` section precedes the `Chunks:` section

#### Scenario: No tables section when cache is empty

- GIVEN `sourceId = S` with 0 rows in
  `research_evidence_tables`
- WHEN `llmFactsForChunkBatch(title, doi, chunks)` is called
- THEN the prompt does NOT include a `tables:` section
- AND the prompt is otherwise identical to the pre-delta prompt
- AND the LLM call proceeds without errors

#### Scenario: loadTablesForSource reads from the cache only

- GIVEN a populated `research_evidence_tables`
- WHEN `loadTablesForSource(S)` is called
- THEN it returns the rows for S without invoking any extraction
  provider
- AND it does not write to any table

### Requirement: Fact Extraction Populates evidence_table_id

The system MUST populate the new `evidence_table_id` column on
`research_bioprospecting_facts` whenever a fact is extracted from
a specific table row. The link is the user's audit trail from a
fact back to the source table cell.

**Behavior:**

- The LLM prompt MUST instruct the model to emit a
  `sourceTableRef` field on each fact object with the shape
  `{ page: number, tableIndex: number, rowIndex: number }` when
  the fact was extracted from a specific row of a table listed
  in the `tables:` section. For facts extracted from prose (not
  a table row), `sourceTableRef` MUST be omitted.
- `normalizeFacts` MUST resolve the `sourceTableRef` to an
  `evidence_table_id` by looking up
  `research_evidence_tables` for the matching
  `(source_id, page, tableIndex)` tuple and assigning the
  resulting `id` to the fact's `evidence_table_id`.
- If no matching row exists in `research_evidence_tables`
  (the `pdf-table-extraction` capability has not run, or the
  LLM hallucinates a tuple), the `sourceTableRef` is dropped
  and `evidence_table_id` stays `null`. The fact is still
  persisted — the LLM's claim is not rejected for a missing
  table link.
- The inline merge in
  `replaceBioprospectingFactsForSource` MUST preserve
  `evidence_table_id` end-to-end: the persisted row's
  `evidence_table_id` matches the input fact's
  `evidence_table_id` (canonical or merged).

#### Scenario: Fact extracted from a table row links back

- GIVEN a cached table T on page 4, table_index 0
- AND a batch of chunks that includes the table's row 2
  ("Dose 24h, IC50 5.4 μg/mL")
- WHEN the LLM emits a fact with
  `sourceTableRef: { page: 4, tableIndex: 0, rowIndex: 2 }`
- THEN `normalizeFacts` resolves the ref to
  `evidence_table_id = T.id`
- AND the persisted fact in `research_bioprospecting_facts`
  has `evidence_table_id = T.id`

#### Scenario: Fact extracted from prose has no link

- GIVEN a fact whose supporting evidence is a paragraph of
  prose, not a table row
- WHEN the LLM emits a fact without `sourceTableRef`
- THEN the persisted fact has `evidence_table_id = NULL`
- AND the fact is still persisted (the link is optional)

#### Scenario: Hallucinated table ref is dropped silently

- GIVEN the LLM emits
  `sourceTableRef: { page: 99, tableIndex: 99, rowIndex: 99 }`
- AND no row in `research_evidence_tables` matches
- WHEN `normalizeFacts` runs
- THEN `evidence_table_id` is `null`
- AND the fact is persisted
- AND a debug log is emitted at `bioprospecting_table_ref_missing`
  with the offending ref

#### Scenario: Merge preserves evidence_table_id

- GIVEN two incoming facts F1 and F2 with the same identity_key,
  where F1 has `evidence_table_id = T1` and F2 has
  `evidence_table_id = T2`
- WHEN the inline merge runs and selects F1 as canonical
- THEN the canonical row's `evidence_table_id = T1`
- AND the merged row's `evidence_table_id = T2`
- AND the merge is unaffected by the table link (identity-key
  rules still apply)

### Requirement: Prefer Tables Over Prose Prompt Instruction

The system MUST include the rule "prefer measurements from tables
over prose" in the bioprospecting LLM prompt. The rule is the
behavioral contract that makes table-aware extraction actually
useful — without it, the LLM is free to ignore the
`tables:` section and rely on chunk text alone.

**Behavior:**

- The rule MUST appear in the prompt's "Strict rules" section,
  immediately after the existing `resultSummary` and
  `measurementValue` rules, so the LLM sees it in the same
  numbered list as the other extraction rules.
- The rule MUST be phrased to cover both the value AND the unit
  of a measurement: "When a fact's measurement value, unit, or
  direction appears in BOTH a table row and prose, prefer the
  table row's value over the prose."
- The rule MUST NOT change when the cache is empty (see the
  "Tables Prompt Section" requirement: an empty cache omits the
  `tables:` section, so the rule has nothing to point at). In
  that case, the rule is harmless no-op text in the prompt.

#### Scenario: Rule is present in the prompt

- GIVEN a populated table cache
- WHEN `llmFactsForChunkBatch` builds the prompt
- THEN the prompt's "Strict rules" section includes the line
  `When a fact's measurement value, unit, or direction appears
  in BOTH a table row and prose, prefer the table row's value
  over the prose.`

#### Scenario: Rule is a no-op when cache is empty

- GIVEN an empty table cache for the source
- WHEN the prompt is built
- THEN the rule is still emitted (the prompt template is the
  same regardless of cache state)
- AND no `tables:` section is included
- AND the LLM proceeds without errors

#### Scenario: LLM emits different values for prose vs table

- GIVEN a fact for which a table row says `IC50 = 5.4 μg/mL`
  and an adjacent paragraph says `IC50 ≈ 5 μg/mL`
- WHEN the LLM follows the "prefer tables over prose" rule
- THEN the persisted fact has `measurementValue = 5.4`,
  `measurementUnit = "μg/mL"`
- AND the fact's `evidence_table_id` is set to the table's id

## MODIFIED Requirements

None. The pre-delta contract (`extractBioprospectingFactsForSource`,
`llmFactsForChunkBatch`, batch retries, status transitions, inline
merge) is preserved. The delta is additive: new table injection,
new column population, and a new prompt rule. No existing behavior
is changed.

## REMOVED Requirements

None.
