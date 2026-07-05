# Tasks: cost-guard-rails

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~700-750 LOC + ~400 tests |
| 400-line budget risk | Low (per chained slice) |
| Chained PRs recommended | Yes |
| Suggested split | PR #1 → PR #2 → PR #3 (stacked-to-main) |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Low

### Work Units

| # | Goal | PR | Base |
|---|------|----|------|
| 1 | Schema + costService + llm-cost + env + tests | PR #1 | main |
| 2 | Mistral wrap + runId + local fallback + tests | PR #2 | main (post #1) |
| 3 | PubChem + admin + WebSocket + dashboard + tests | PR #3 | main (post #2) |

## Phase 1: PR #1 — Foundation

- [x] 1.1 Migration `supabase/migrations/20260615000000_add_api_cost_tracking.sql`: CREATE `daily_api_usage(day, provider, units NUMERIC(20,6), cost_usd NUMERIC(10,6), calls_count, last_cap_warn_at, created_at, updated_at, UNIQUE(day,provider))` + INDEX `(provider,day DESC)`; ALTER `research_ingestion_runs` ADD `ext_api_cost NUMERIC(10,6) DEFAULT 0`, `ext_api_calls JSONB DEFAULT '{}'`
- [x] 1.2 Same migration: `CREATE FUNCTION record_api_call(p_run_id UUID, p_source_id UUID, p_provider TEXT, p_units NUMERIC, p_cost_usd NUMERIC, p_metadata JSONB) RETURNS TABLE(cap_hit TEXT, current_daily_cost, current_monthly_cost, current_source_cost, current_run_cost) LANGUAGE plpgsql SECURITY DEFINER` — INSERT-ON-CONFLICT seed, `SELECT … FOR UPDATE`, UPDATE increment, monthly=`SUM(cost_usd) WHERE provider=? AND day>=CURRENT_DATE-INTERVAL '30 days'`, per-source/run from `ext_api_calls` JSONB, idempotent `last_cap_warn_at` at `v_daily*0.8`, cap_hit precedence source>run>day>month>NULL
- [x] 1.3 `src/services/researchBrain/costService.ts`: TDZ-safe `globalThis.__<provider>DisabledToday__`/`__DisabledThisMonth__`; `class CostCapExceededError extends Error {scope:'day'|'month'|'source'|'run'}`; `getCostConfig()` reads env vars with `Number(…)`/`0` fallback
- [x] 1.4 `recordApiCall({runId?,sourceId?,provider,units,costUsd,metadata?})` → `supabase.rpc('record_api_call', …)`; on RPC exception or `error` log `event=cost_rpc_soft_fail` and return `{capHit:null,…}` (NEVER throws); on `cap_hit='day'|'month'` set the `globalThis` flag
- [x] 1.5 `checkCap({provider,estimatedCostUsd,units?,sourceId?,runId?})` read-only: SELECT current daily from `daily_api_usage`, monthly=SUM 30d, per-source/run from `ext_api_calls` JSONB; return `{allowed, wouldHitDaily, wouldHitMonthly, wouldHitPerSource, wouldHitPerRun}`; respect `globalThis` short-circuit; log NOTHING
- [x] 1.6 `isProviderDisabled(provider)`, `getDayUsage(provider,day?)`, `getMonthUsage(provider)` (for PR #3 admin), `resetDailyFlags()` test helper
- [x] 1.7 Extend `llm-cost.ts` `calculateCost` → return `{costUsd, units}` (BREAKING — update callers); `provider==='mistral-ocr'` → `{costUsd: units*(MISTRAL_OCR_COST_PER_PAGE_USD env||0.05), units}`; `provider==='pubchem'` → `{costUsd:0, units}`; LLM pricing unchanged
- [x] 1.8 `.env.example` "External API Cost Guard Rails": `MISTRAL_OCR_DAILY_COST_CAP_USD=50`, `MISTRAL_OCR_MONTHLY_COST_CAP_USD=1000`, `MISTRAL_OCR_PER_SOURCE_COST_CAP_USD=2`, `MISTRAL_OCR_COST_GUARD=true`, `PUBCHEM_DAILY_REQUEST_CAP=200000`, `PUBCHEM_COST_GUARD=true`, `COST_ALERT_HARD_BLOCK=true`, `COST_ALERT_SOFT_THRESHOLD=0.8`; preserve `MISTRAL_OCR_ENABLED`/`PUBCHEM_ENABLED`
- [x] 1.9 `documentation/docs/SETUP.md`: "Cost Guard Rails" subsection with cap-scope table
- [x] 1.10 `__tests__/costService.test.ts`: cap math, `globalThis` set/read, RPC soft-fail, env=0 → `allowed=false`, `MISTRAL_OCR_COST_GUARD=false` → `allowed=true` at cap, `resetDailyFlags()`, `calculateCost('mistral-ocr',50)`→2.50, `calculateCost('pubchem',1)`→`{0,1}`
- [x] 1.11 `__tests__/recordApiCall.rpc.test.ts` (gated by `BUN_TEST_DB_URL`): 2 concurrent calls at daily=$49.95+$0.10 → ≥1 returns `capHit:'day'`, row=$50.05 (FOR UPDATE); 1st call crosses 80% sets `last_cap_warn_at`, 2nd at 85% does NOT update

## Phase 2: PR #2 — Mistral + Local Fallback

- [x] 2.1 `mistralOcrProvider.ts`: TDZ-safe `globalThis.__mistralOcrEnabled__ = process.env.MISTRAL_OCR_ENABLED !== 'false'`; export `isMistralEnabled()`; `callOcr` throws `TableExtractionProviderError("MISTRAL_OCR_ENABLED=false")` before HTTP when disabled
- [x] 2.2 `TableExtractionProvider` in `pdfTableExtractor.ts`: `extract(pdf, ctx?:{runId?,sourceId?})`, `extractFigures(pdf, ctx?)`; `LocalTableExtractionProvider` ignores `ctx`
- [x] 2.3 `MistralTableExtractionProvider.extract(pdf, ctx?)`: pre-call `checkCap({provider:'mistral_ocr', estimatedCostUsd: ceil(pdf.byteLength/100_000)*costPerPage, sourceId:ctx?.sourceId, runId:ctx?.runId})`; on `allowed===false` log `event=mistral_cap_precheck,sourceId,runId,scope` and throw `CostCapExceededError({scope})`; after `callOcr` → `recordApiCall({provider:'mistral_ocr', units:pages.length, costUsd:pages.length*costPerPage, sourceId, runId})`; on `capHit!==null` log `event=mistral_disabled_today|this_month`, throw, do NOT return tables
- [x] 2.4 Apply same pre-check + post-record pattern to `extractFigures(pdf, ctx?)` (wrap at public methods, not private `callOcr`)
- [x] 2.5 `extractPDFTables(sourceId, pdf, ctx?)`: pass `ctx` to Mistral calls; try/catch `CostCapExceededError` → log `event=mistral_disabled_*,reason=cost_cap`, persist LOCAL with `extraction_provider='local'`, return `provider:'local'`; respect `globalThis.__mistralOcrDisabled*__` BEFORE `checkCap`
- [x] 2.6 `bioprospectingExtractor.ts`: `extractBioprospectingFactsForSource(sourceId, options?:{chunks?,runId?})`; thread `{runId:options?.runId}` into `ensureTablesForSource(source,{runId})` → `extractPDFTables(source.id, pdf, {runId})`
- [x] 2.7 `bioprospecting.worker.ts:73`: `await extractBioprospectingFactsForSource(sourceId, {runId})`; verify `runContradictionDetection({sourceId, runId})` threads `runId` unchanged
- [x] 2.8 Update `bioprospectingExtractor.tables.test.ts` mock for new `options` shape; add: `extractBioprospectingFactsForSource(S, {runId:R})` threads R; manual one-off without `runId` succeeds
- [x] 2.9 `__tests__/pdfTableExtractor.costCap.test.ts` (mock `costService`): (a) pre-check `wouldHitDaily=true` → local + `mistral_disabled_today` + `provider:'local'`; (b) post-call `capHit='day'` → Mistral discarded, local persisted; (c) `globalThis.__mistralOcrDisabledToday__` set → skips `checkCap`, calls local; (d) `MISTRAL_OCR_ENABLED=false` → `TableExtractionProviderError`, local fallback
- [x] 2.10 `__tests__/mistralOcrProvider.costWrap.test.ts` (mock `costService`): `extract` calls `checkCap` before HTTP, `recordApiCall` after with `units:pages.length`; `extractFigures` same; disabled flag short-circuits HTTP

## Phase 3: PR #3 — PubChem + Admin + WebSocket

- [x] 3.1 `compoundAuthority.ts` `pubchemFetch`: pre-call `checkCap({provider:'pubchem', estimatedCostUsd:0, units:1})` BEFORE `gate.take()`; on `allowed===false` log `event=pubchem_disabled_today,reason=cost_cap` and throw `CostCapExceededError({scope:'day'})`; after 2xx → `recordApiCall({provider:'pubchem', units:1, costUsd:0, runId:opts?.runId, sourceId:opts?.sourceId})` (soft-fail); keep `RateGate`
- [x] 3.2 `compoundAuthority.worker.ts`: call `costService.isProviderDisabled('pubchem')` BEFORE `normalizeBioprospectingCompounds`; on true log `event=pubchem_disabled_today,reason=cost_cap` and return `{scannedFacts:0,…,capHit:'day'}` (extend `CompoundAuthorityJobResult`)
- [x] 3.3 `types.ts`: extend `CompoundAuthorityJobResult` with `capHit?:'day'|'month'`; extend `IngestionProgressNotification` with optional `apiCost?:number`, `apiCallsCount?:number`; add `'run:api_call'` to `IngestionNotificationType`
- [x] 3.4 `notify.ts`: `notifyRunApiCall(runId, apiCost, apiCallsCount)` → `notifyIngestion({type:'run:api_call', runId, apiCost, apiCallsCount})`; extend `notifyIngestionProgress` to accept optional `apiCost?`/`apiCallsCount?`
- [x] 3.5 `costService.ts`: `notifyApiCallDelta(runId, deltaCost, deltaCalls)` — when positive, calls `notifyRunApiCall` and updates in-memory `runApiCostCache`; fire-and-forget; failure logs `event=api_call_notify_failed`
- [x] 3.6 `research-brain.ts` `/ingestion/runs/:id` (line 814): add `extApiCost: parseFloat((run as any).ext_api_cost || '0')` and `extApiCallsCount: Object.values((run as any).ext_api_calls || {}).reduce((s:number,p:any)=>s+(p?.calls||0),0)`; preserve `llmCost`/`llmCallsCount`
- [x] 3.7 Create `src/routes/admin/cost-totals.ts`: `GET /admin/cost-totals?since=24h|7d|30d&provider=mistral_ocr|pubchem|all`; `beforeHandle: authResolver({required:true, role:'admin'})`; query `daily_api_usage` JOIN env caps; response `{rows:[{day,provider,costUsd,units,calls,dailyCap,monthlyCap,pctOfDailyCap,pctOfMonthlyCap,lastCapWarnAt}], capUtilization:{peakDay,averageDay,daysAt80pct,daysAt100pct}}`; export `costTotalsRoute`
- [x] 3.8 Mount in `src/index.ts` next to `adminJobsRoute` (line 390): `app.use(costTotalsRoute);` (prefix `/admin`)
- [x] 3.9 `bioprospectingExtractor.ts` after `ensureTablesForSource`: call `costService.notifyApiCallDelta(runId, …)` (skip when no `runId`)
- [x] 3.10 `bioprospecting.worker.ts` after successful extraction: call `costService.notifyApiCallDelta(runId, …)` to push `ext_api_cost`/`ext_api_calls` to WebSocket
- [x] 3.11 `__tests__/compoundAuthority.costCap.test.ts` (mock `costService`): `pubchemFetch` throws `CostCapExceededError` on `checkCap.allowed===false`; `recordApiCall` after 2xx with `{provider:'pubchem', units:1, costUsd:0}`; RPC exception does NOT abort fetch
- [x] 3.12 `__tests__/compoundAuthority.worker.costCap.test.ts`: mock `isProviderDisabled`→true; worker returns `capHit:'day'` without calling `normalizeBioprospectingCompounds`; `pubchem_disabled_today` log
- [x] 3.13 `__tests__/cost-totals.test.ts` (mock `getServiceClient`): admin caller with 24h rows → `{rows:[…], capUtilization:{…}}` with `pctOfDailyCap`/`pctOfMonthlyCap`; non-admin → 401/403; `daysAt80pct` over 3 days (50/85/100%) → 2
- [x] 3.14 `__tests__/notify.apiCost.test.ts`: `notifyRunApiCall` JSON includes `apiCost`/`apiCallsCount`; `IngestionProgressNotification` accepts new optional fields; `JSON.stringify({…base, apiCost:undefined})` omits the key
- [x] 3.15 `__tests__/research-brain.runsExtApiCost.test.ts`: run with `ext_api_cost=2.50`, `ext_api_calls={mistral_ocr:{calls:5,costUsd:2.50,units:50}}` → `{extApiCost:2.50, extApiCallsCount:5, llmCost:…}`; `llmCost` preserved
- [x] 3.16 `worker.ts`: nightly GC `setInterval(24h)` running `DELETE FROM daily_api_usage WHERE day < CURRENT_DATE - INTERVAL '35 days'`, gated by `COST_GUARD_GC_ENABLED` (default true); log `cost_guard_gc_completed`; failure logs `cost_guard_gc_failed` (NEVER crash worker)

## Phase 4: Cross-Cutting

- [x] 4.1 Add `ext_api_cost`/`ext_api_calls` to `ResearchIngestionRun` TypeScript type in `src/types/`; re-export `recordApiCall`/`checkCap`/`isProviderDisabled` from `src/services/researchBrain/index.ts`
- [x] 4.2 `SETUP.md` Cost Guard Rails: PubChem caps, WebSocket payload field names, admin route URL, nightly GC cadence
- [x] 4.3 `bun test` (all new tests pass); `bun test recordApiCall.rpc.test.ts` against local Postgres (FOR UPDATE); `tsc --noEmit` (no errors from `extract(pdf, ctx?)` signature changes)
- [x] 4.4 Confirm 3-PR diffs each < 400 changed lines: PR #1 ≈ 280; PR #2 ≈ 220; PR #3 ≈ 250
