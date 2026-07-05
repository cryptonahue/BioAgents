# Delta for research-bioprospecting

This is the second delta to the `research-bioprospecting`
capability. The first delta (`pdf-provenance-viewer`) added
table-aware extraction. This delta adds compound authority
attachment: after the LLM extracts facts, each fact is
post-processed by `compoundAuthority` to attach a canonical
compound id and an authority status. The LLM prompt is
**unchanged** — the LLM is NOT told about compound authority,
and the post-processing is a deterministic, synchronous step
that runs after `normalizeFacts` and before
`replaceBioprospectingFactsForSource`.

The "Baseline" subsection restates the unchanged contract. The
"ADDED" and "MODIFIED" subsections capture the new behavior
introduced by `bioprospecting-compound-authority`.

## Baseline (Pre-Delta Behavior)

The following describes the baseline behavior of the
`research-bioprospecting` capability. Future changes MUST
treat these as the unchanged contract unless an explicit
`MODIFIED` requirement below overrides them.

- `extractBioprospectingFactsForSource(sourceId)` reads
  `research_evidence_chunks` for the source, batches them at
  `BIOPROSPECTING_BATCH_CHUNKS` (default 8), and calls
  `llmFactsForChunkBatch(title, doi, batch)` for each batch.
- The LLM prompt is given strict rules about quoting the
  source, supporting measurement fields, preferring
  organism/molecule/activity/application context, and (since
  the first delta) "prefer tables over prose".
- The output JSON is normalized via `normalizeFacts` and the
  canonical selection / inline merge logic in
  `replaceBioprospectingFactsForSource` (defined in the
  `bioprospecting-fact-dedup` capability) handles identity-key
  dedup before persisting.
- The LLM is **not** told about compound authority, canonical
  ids, or PubChem. Compound authority is a post-processing
  concern owned by `bioprospecting-compound-authority`.
- Status transitions on `research_sources.extraction_status`:
  `pending_extraction` → `running` → (`completed` |
  `no_chunks` | `failed`).

## ADDED Requirements

### Requirement: Post-Extraction Compound Authority Attachment

The system MUST call `attachCompoundAuthority(fact)` for
every fact emitted by `llmFactsForChunkBatch` and
`normalizeFacts`, after the normalization step and before
`replaceBioprospectingFactsForSource`. The function is
implemented in
`src/services/researchBrain/compoundAuthority.ts` and is the
single point of entry for compound authority state on a fact.

**Behavior:**

- `attachCompoundAuthority(fact)` MUST call
  `resolveCompoundStatus(fact.compound)` to decide the
  initial status and canonical id (or NULL).
- The function MUST set the four fact columns
  (`compound_canonical_id`, `compound_authority_status`,
  `compound_authority_at`, `compound_authority_error`) on the
  in-memory fact object before it is handed to
  `replaceBioprospectingFactsForSource`. The columns are part
  of the persisted row, not a post-hoc update.
- The function MUST be synchronous and MUST NOT issue any
  network calls. PubChem resolution is the worker's job.
- The function MUST be safe to call on every fact in every
  batch. A single bad input (e.g. a malformed fact) MUST NOT
  abort the batch; the error is logged and the fact is
  persisted with `compound_authority_status = 'pending'`.
- The function MUST be called exactly once per fact. Calling
  it twice on the same fact MUST NOT clobber a `verified`
  status with a `pending` re-resolution.

The attachment runs after `normalizeFacts` and before the
inline merge in `replaceBioprospectingFactsForSource`. The
order is:

1. LLM emits raw fact objects.
2. `normalizeFacts` cleans the JSON, resolves
   `sourceTableRef` → `evidence_table_id`, and normalizes
   measurements.
3. `attachCompoundAuthority(fact)` stamps the four authority
   columns.
4. `replaceBioprospectingFactsForSource` runs the inline
   merge, persisting the fact with all four authority
   columns set.

#### Scenario: Extracted fact with an alias hit is verified

- GIVEN the alias table contains
  `(alias = 'diferuloylmethane', compound_id = C_curcumin)`
- AND the LLM emits a fact F with `compound = 'diferuloylmethane'`
- WHEN `attachCompoundAuthority(F)` runs
- THEN F's `compound_canonical_id = C_curcumin.id`
- AND F's `compound_authority_status = 'verified'`
- AND F's `compound_authority_at = NOW()`
- AND no PubChem call is performed
- AND F is persisted by `replaceBioprospectingFactsForSource`
  with the verified state intact

#### Scenario: Extracted fact with an extract value is skipped

- GIVEN the LLM emits a fact F with `compound = 'Curcuma longa extract'`
- WHEN `attachCompoundAuthority(F)` runs
- THEN F's `compound_canonical_id = NULL`
- AND F's `compound_authority_status = 'skipped'`
- AND F's `compound_authority_error = 'extract_or_mixture'`

#### Scenario: Extracted fact with no alias hit is pending

- GIVEN no alias matches `'obscurenaturalproduct'`
- AND the LLM emits a fact F with that value
- WHEN `attachCompoundAuthority(F)` runs
- THEN F's `compound_canonical_id = NULL`
- AND F's `compound_authority_status = 'pending'`
- AND F's `compound_authority_at = NULL`
- AND the worker will pick it up on the next backfill cycle

#### Scenario: LLM prompt is unchanged

- GIVEN the LLM prompt template before and after this delta
- WHEN `llmFactsForChunkBatch` builds the prompt
- THEN the prompt does NOT mention "canonical", "PubChem",
  "authority", or any compound resolution concept
- AND the existing strict rules (quoting, measurement,
  table-preference) are unchanged

#### Scenario: A bad input does not abort the batch

- GIVEN a fact F whose `compound` field is a non-string (the
  `normalizeFacts` invariant is broken)
- WHEN `attachCompoundAuthority(F)` runs
- THEN the function logs the error with the fact id
- AND the function falls back to
  `compound_authority_status = 'pending'`,
  `compound_canonical_id = NULL`
- AND the batch continues to the next fact

## MODIFIED Requirements

### Requirement: Status Transitions on research_sources.extraction_status (clarification)

The status flow for `research_sources.extraction_status`
(`pending_extraction` → `running` → `completed` | `no_chunks`
| `failed`) is unchanged. The introduction of
`compound_authority_status` on individual facts does NOT
introduce a new `extraction_status` value. A run is
`'completed'` if and only if the LLM extraction and the
inline merge finished, regardless of how many facts ended up
in `pending`, `failed`, or `skipped`.

This is a clarification of the existing requirement, not a
behavior change. Per-fact authority status is independent of
source-level extraction status.

#### Scenario: Run completes even with pending or skipped facts

- GIVEN an extraction run that produces 100 facts
- AND 30 are `'verified'`, 50 are `'pending'`, 20 are
  `'skipped'`
- WHEN the run finishes
- THEN `research_sources.extraction_status = 'completed'`
- AND the 50 `pending` facts are picked up by the backfill
  worker on the next cycle

#### Scenario: Run does not block on PubChem

- GIVEN a fact F in `'pending'` after extraction
- WHEN the extraction run finishes
- THEN the run is `'completed'`
- AND F remains `'pending'` in the database
- AND no PubChem call has been made during the extraction
  (the worker's job)

## REMOVED Requirements

None.

## RENAMED Requirements

None.
