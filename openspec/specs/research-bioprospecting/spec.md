# Spec: research-bioprospecting

## Purpose

Extract structured bioprospecting facts (organism, molecule, activity,
application) from research PDFs by feeding chunked text — and the
extracted tables produced by the `pdf-table-extraction` capability — to
an LLM and persisting the structured output. The capability is invoked
from the document ingestion worker pool after PDF chunking completes
and is the upstream of the bioprospecting evidence pack, search, and
contradiction detection.

This is the first formally specified version of the capability. The
"Baseline" subsection captures the pre-`pdf-provenance-viewer` change
contract that has been the running behavior of
`src/services/researchBrain/bioprospectingExtractor.ts`. The "ADDED"
and "MODIFIED" subsections capture the table-aware extension landed by
`bioprospecting-pdf-provenance-viewer`. Future changes can build on
this stable baseline + delta.

## Baseline (Pre-`pdf-provenance-viewer` Behavior)

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

## ADDED Requirements (bioprospecting-compound-authority delta)

This section is the delta introduced by the
`bioprospecting-compound-authority` change. The baseline
contract above is preserved unchanged. The delta is additive:
a new `attachCompoundAuthority(fact)` step is called from the
extractor after `normalizeFacts` and before
`replaceBioprospectingFactsForSource`. The LLM prompt is
unchanged — the model is NOT told about compound authority.

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

## ADDED Requirements (cost-guard-rails delta)

This section is the delta introduced by the `cost-guard-rails`
change. The baseline contract and the `bioprospecting-compound-
authority` delta above are preserved unchanged. The delta is
additive: ingest runs gain `extApiCost` / `extApiCallsCount`
visibility; the WebSocket payload gains optional `apiCost` /
`apiCallsCount` fields; a new admin-only `/api/admin/cost-totals`
drill-down returns per-day, per-provider totals; the
`compoundAuthority.worker` gains a pre-tick day-cap check that
aborts cleanly on the daily PubChem cap; and the
`bioprospectingExtractor` threads `runId` through the cost-cap
and visibility layers.

### Requirement: ExtApiCost Visibility On Ingestion Runs

The system MUST expose external API spend for each research
ingestion run via the same surface that exposes LLM spend. The
new visibility is additive: the existing `llmCost` and
`llmCallsCount` fields are unchanged.

**Behavior:**

- `GET /api/research-brain/ingestion/runs/:id` MUST return
  `extApiCost` (number, USD) and `extApiCallsCount` (number)
  in the same response object that already contains `llmCost`.
- The values MUST be computed from the new
  `research_ingestion_runs.ext_api_cost` and a count derived
  from `research_ingestion_runs.ext_api_calls` JSONB
  (sum of `calls` per provider).
- The corpus dashboard's "Runs" table MUST render a column
  `LLM $X / External API $Y` per row, using the two fields.
- The `IngestionProgressNotification` WebSocket payload MUST
  include optional `apiCost` and `apiCallsCount` fields
  (number, USD; number, count). When the run has not yet
  recorded any external API call, both fields are omitted.

#### Scenario: Run response shows extApiCost and extApiCallsCount

- GIVEN run R with `ext_api_cost = 2.50` and
  `ext_api_calls = { "mistral_ocr": { "calls": 5, "costUsd":
  2.50, "units": 50 } }`
- WHEN `GET /api/research-brain/ingestion/runs/:id` is called
  for R
- THEN the response includes
  `extApiCost: 2.50, extApiCallsCount: 5`
- AND the existing `llmCost` field is unchanged

#### Scenario: WebSocket payload carries apiCost and apiCallsCount

- GIVEN run R is currently processing and has accumulated
  $1.20 of Mistral spend across 3 calls
- WHEN the orchestrator emits a `run:{runId}` WebSocket
  notification
- THEN the payload includes
  `apiCost: 1.20, apiCallsCount: 3`

#### Scenario: WebSocket payload omits the fields when no external calls yet

- GIVEN run R has only made LLM calls (no Mistral / PubChem)
- WHEN a `run:{runId}` notification is emitted
- THEN the payload does NOT include `apiCost` or
  `apiCallsCount`
- AND the existing `llmCost` field is still present

#### Scenario: Corpus dashboard renders dual spend

- GIVEN the dashboard's runs table has rows for runs R1, R2,
  R3
- WHEN the dashboard renders
- THEN each row shows `LLM $X / External API $Y` where
  `X = llmCost` and `Y = extApiCost`

### Requirement: Cost-Cap Visibility On Admin Drill-Down

The system MUST expose a new admin-only route at
`GET /api/admin/cost-totals` (mounted at `/admin/cost-totals`)
that returns per-day, per-provider totals with cap utilization.
The route is auth-gated via the existing `authResolver` with
`role: 'admin'`.

**Behavior:**

- The route accepts `since` (`'24h' | '7d' | '30d'`,
  default `'24h'`) and `provider` (`'mistral_ocr' | 'pubchem'
  | 'all'`, default `'all'`) as query parameters.
- The response MUST include for each `(day, provider)` pair:
  `{ day, provider, costUsd, units, calls, dailyCap, monthlyCap,
  pctOfDailyCap, pctOfMonthlyCap, lastCapWarnAt, lastCapHitAt? }`.
- The response MUST include `capUtilization` aggregate fields
  at the provider level (peak day, average day, days at 80%+,
  days at 100%).
- The route MUST read from `daily_api_usage` only. No writes.
- The route MUST be mounted under `/admin/cost-totals` (the
  SPA serves a "Cost Totals" tab from the same path).

#### Scenario: Admin fetches 24h totals for Mistral

- GIVEN the caller has the `admin` role
- AND `daily_api_usage` has rows for `provider='mistral_ocr'`
  in the last 24 hours
- WHEN `GET /api/admin/cost-totals?since=24h&provider=mistral_ocr`
- THEN the response returns one entry per `(day, provider)` in
  the window
- AND each entry includes `pctOfDailyCap` and `pctOfMonthlyCap`

#### Scenario: Non-admin caller is rejected

- GIVEN the caller does NOT have the `admin` role
- WHEN the same route is hit
- THEN the response is `401` or `403`
- AND no cost data is leaked

#### Scenario: DaysAt80pct aggregate

- GIVEN three days of Mistral usage with spend at 50%, 85%, and
  100% of the daily cap
- WHEN the admin fetches 7d totals
- THEN the response includes `daysAt80pct: 2` (the 85% and 100%
  days)

### Requirement: Pubchem Worker Day-Cap Check

The `compoundAuthority.worker.ts` MUST call
`costService.isProviderDisabled('pubchem')` before each PubChem
fetch. When the per-day request cap is hit, the worker MUST
abort the current pass cleanly and persist the
`summary.capHit='day'` flag on the run summary so the
operator can see why facts were not resolved this cycle.

**Behavior:**

- The worker MUST call
  `costService.checkCap({ provider: 'pubchem',
  estimatedCostUsd: 0, units: 1 })` before every
  `pubchemFetch` call.
- When `checkCap.allowed === false`, the worker MUST abort the
  pass and log `event=pubchem_disabled_today, reason=cost_cap`
  (WARN).
- The run summary MUST include `capHit: 'day'`. The next
  scheduler tick re-picks the same `pending` facts and tries
  again — the cap will reset at UTC midnight.
- The worker MUST call
  `costService.recordApiCall({ provider: 'pubchem', units: 1,
  costUsd: 0 })` after a successful PubChem response. The
  increment is what the next `checkCap` consults.

#### Scenario: Worker aborts cleanly on day cap

- GIVEN `PUBCHEM_DAILY_REQUEST_CAP=200000` and current daily
  request count is 200000
- WHEN the worker picks the next batch of `pending` facts
- THEN `checkCap.allowed === false`
- AND the worker logs
  `event=pubchem_disabled_today, reason=cost_cap`
- AND the run summary is persisted with `capHit: 'day'`
- AND no PubChem API call is made

#### Scenario: Worker increments after a successful fetch

- GIVEN a successful PubChem fetch returns compound C
- WHEN the worker records the resolution
- THEN `costService.recordApiCall({ provider: 'pubchem',
  units: 1, costUsd: 0 })` is called
- AND `research_ingestion_runs.ext_api_cost` for the active
  run (if any) is updated
- AND `ext_api_calls.pubchem.calls` is incremented

#### Scenario: Cap resets at UTC midnight

- GIVEN a `capHit: 'day'` was recorded at 23:55 UTC
- WHEN the next worker tick runs at 00:01 UTC the next day
- THEN `checkCap` consults the NEW day's row (which starts at
  0) and returns `allowed=true`
- AND the worker resumes normal PubChem resolution

### Requirement: RunId Threading Through The Bioprospecting Extractor

The `bioprospectingExtractor` MUST thread `runId` and
`sourceId` through `ensureTablesForSource` → `extractPDFTables`
→ the active provider's `extract` call, so the cost-cap and
visibility layers in `api-cost-guard-rails` and
`pdf-table-extraction` can attribute spend to the correct
run and source.

**Behavior:**

- `extractBioprospectingFactsForSource(sourceId)` MUST accept
  an optional `runId` parameter. When the worker calls it
  with a `runId`, that `runId` MUST be propagated through
  every downstream call that participates in cost tracking.
- The `bioprospecting.worker.ts` MUST pass its own
  `runId` (from the queue job payload) into the extractor
  call. Previously this was missing.
- The provider's `extract(pdf, ctx)` method receives the
  same `ctx = { runId, sourceId }` (see the modified
  `pdf-table-extraction` spec).
- When `runId` is missing (e.g., a manual one-off script),
  the cost-cap layer MUST still work; it simply records
  `null` for the per-run cap check.

#### Scenario: Worker threads runId into the extractor

- GIVEN a queue job with `runId = R` and `sourceId = S`
- WHEN the worker calls
  `extractBioprospectingFactsForSource(S, { runId: R })`
- THEN every downstream call
  (`extractPDFTables(S, pdf, { runId: R })`,
  `provider.extract(pdf, { runId: R, sourceId: S })`)
  carries the same `runId`
- AND `costService.recordApiCall` is called with
  `runId: R, sourceId: S`

#### Scenario: Manual one-off without runId still tracks cost

- GIVEN a developer runs the extractor manually with no
  `runId`
- WHEN the extractor calls `costService.recordApiCall`
- THEN the per-source and per-day caps still apply
- AND the per-run cap is skipped (it requires a `runId`)
- AND the daily totals in `daily_api_usage` are still
  incremented

## REMOVED Requirements

None.
