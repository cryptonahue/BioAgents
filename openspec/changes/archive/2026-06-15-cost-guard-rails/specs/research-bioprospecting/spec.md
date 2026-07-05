# Delta for research-bioprospecting

## ADDED Requirements

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

## MODIFIED Requirements

None. The pre-delta contract (`extractBioprospectingFactsForSource`,
`llmFactsForChunkBatch`, batch retries, status transitions, inline
merge, `attachCompoundAuthority`) is preserved. The delta is
additive: a new `runId` parameter (optional, backwards compatible),
new `extApiCost` / `extApiCallsCount` fields on the run response
and WebSocket payload, a new admin drill-down route, and a new
PubChem worker day-cap check.

## REMOVED Requirements

None.
