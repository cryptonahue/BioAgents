# Design: cost-guard-rails

## Technical Approach

Extend the existing `record_llm_call` atomic RPC pattern (`llm-cost.ts` + migration `20260609000000_add_llm_cost_calls.sql`) to Mistral OCR + PubChem. New `daily_api_usage` table locked per `(day, provider)` by a single `record_api_call` RPC. `costService.ts` is the only import point; Mistral + PubChem wrap call sites with `checkCap` + `recordApiCall`. Orchestrator catches `CostCapExceededError` and falls back to `local`. Day-cap hits set a `globalThis` flag that short-circuits until UTC midnight. Surface spend via `runs/:id` + WebSocket payload, with a new admin drill-down.

## Architecture Decisions

| Decision | Choice | Tradeoff |
|----------|--------|----------|
| RPC lock granularity | `SELECT … FOR UPDATE` on `(day, provider)` row | Per-source lock = contention; advisory = extra RTT; no lock = races past cap. |
| Per-source cap storage | In-RPC from `ext_api_calls` JSONB; no separate table | Separate table doubles writers + 2nd lock; per-source is debug-only. |
| GC mechanism | Nightly Bun cron on **worker** process | `pg_cron` = platform-dep; startup = misses long-running; read-time = couples costs. |
| Pre vs post call | Pre: `ceil(pdf.byteLength/100_000)*costPerPage` → `checkCap`. Post: `pages.length` → `recordApiCall` (authoritative). | Over-count is safe direction. |
| `runId` threading | `extractBioprospectingFactsForSource(sourceId, { runId? })`; worker passes `runId`. PubChem has no `runId` — per-run cap skipped. | Backwards-compat. `bioprospecting.worker.ts:73` already has `runId` in scope. |
| `callOcr` twice per PDF | Wrap at public `extract` (line 86) + `extractFigures` (line 155), not private `callOcr`. | Each call counts; single-call refactor deferred (spec lock). |
| TDZ-safe env + flags | Read env at call time; `globalThis.__<provider>Disabled__` on `cap_hit='day'\|'month'`. | Mirrors `pdfTableExtractor.resolveMode:152` + `compoundAuthority.getCompoundAuthorityConfig:909`. |
| Per-source cap shape | `MISTRAL_OCR_PER_SOURCE_COST_CAP_USD=2`; per-(provider, source) in JSONB. | Per-source = early-warning for bad PDFs; per-day = global stop. |

## Data Flow

`Mistral.extract(pdf, ctx={runId,sourceId})` → `checkCap(estimatedCost)` (RPC read-only) → `callOcr(pdf)` → `recordApiCall({units:pages.length, costUsd:actual})` (RPC `FOR UPDATE` + upsert + return `cap_hit`) → if `cap_hit`: throw `CostCapExceededError({scope})`. Orchestrator catch: `day|month` → set `globalThis.__<provider>Disabled__=true` → `local.extract(pdf)` → persist `extraction_provider='local'`, log `event=mistral_disabled_today`. PubChem worker: pre-tick `isProviderDisabled`? → abort with `summary.capHit='day'`; else `checkCap` → `fetch` → `recordApiCall({units:1, costUsd:0})`.

## File Changes

**New (4):** migration `20260615000000_add_api_cost_tracking.sql` (table + RPC + GC + indexes); `costService.ts` (single import point: `recordApiCall`, `checkCap`, `getDayUsage`, `getMonthUsage`, `getSourceUsage`, `isProviderDisabled`, `globalThis` flags, `getCostConfig()`); `routes/admin/cost-totals.ts` (`GET /api/admin/cost-totals?since=…&provider=…`; `authResolver({required:true, role:'admin'})`); `__tests__/costService.test.ts` (cap math, FOR UPDATE serialization, soft-WARN idempotency, RPC soft-fail, env=0).

**Modified (12):** `llm-cost.ts` (`calculateCost` for `mistral-ocr`+`pubchem`); `pdfTableExtractor.ts` (signature + `ctx`; orchestrator catches `CostCapExceededError` → local); `mistralOcrProvider.ts` (wrap both `extract` methods); `bioprospectingExtractor.ts` (`runId?` param); `compoundAuthority.ts` (wrap `pubchemFetch` ~line 1081); `bioprospecting.worker.ts` (pass `{runId}` at line 73); `compoundAuthority.worker.ts` (pre-tick `isProviderDisabled`); `notify.ts`+`types.ts` (`notifyRunApiCall` + `apiCost?`/`apiCallsCount?` on `IngestionProgressNotification`); `research-brain.ts` (`/ingestion/runs/:id` returns `extApiCost`+`extApiCallsCount` at line 814); `researchBrain/index.ts` (re-export); `worker.ts` (nightly GC cron); `.env.example` + `SETUP.md` (6 new env vars).

## Interfaces / Contracts

```typescript
// costService.ts
export class CostCapExceededError extends Error {
  readonly scope: "day" | "month" | "source" | "run";
}
export type CapCheckResult = {
  capHit: "day"|"month"|"source"|"run"|null;
  currentDailyCost: number; currentMonthlyCost: number;
  currentSourceCost: number; currentRunCost: number;
};
export function recordApiCall(input: { runId?: string; sourceId?: string;
  provider: "mistral_ocr" | "pubchem"; units: number; costUsd: number;
  metadata?: Record<string, unknown>;
}): Promise<CapCheckResult>;
export function checkCap(input: { provider: "mistral_ocr"|"pubchem";
  estimatedCostUsd: number; units?: number; sourceId?: string; runId?: string;
}): Promise<{ allowed: boolean; wouldHitDaily: boolean; wouldHitMonthly: boolean;
  wouldHitPerSource: boolean; wouldHitPerRun: boolean; }>;
export function isProviderDisabled(p: "mistral_ocr" | "pubchem"): boolean;
interface IngestionProgressNotification { /* existing */ apiCost?: number; apiCallsCount?: number; }
```

```sql
CREATE FUNCTION record_api_call(p_run_id UUID, p_source_id UUID, p_provider TEXT,
  p_units NUMERIC, p_cost_usd NUMERIC, p_metadata JSONB)
RETURNS TABLE(cap_hit TEXT, current_daily_cost NUMERIC, current_monthly_cost NUMERIC,
              current_source_cost NUMERIC, current_run_cost NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_daily NUMERIC := current_setting('app.mistral_ocr_daily_cap', true)::NUMERIC;
  v_monthly NUMERIC := current_setting('app.mistral_ocr_monthly_cap', true)::NUMERIC;
  v_source NUMERIC := current_setting('app.mistral_ocr_per_source_cap', true)::NUMERIC;
  v_day DATE := CURRENT_DATE; v_new_daily NUMERIC; v_new_monthly NUMERIC; v_hit TEXT;
BEGIN
  INSERT INTO daily_api_usage (day, provider) VALUES (v_day, p_provider) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM daily_api_usage WHERE day = v_day AND provider = p_provider FOR UPDATE;
  UPDATE daily_api_usage SET units = units + p_units, cost_usd = cost_usd + p_cost_usd,
    calls_count = calls_count + 1,
    last_cap_warn_at = CASE WHEN cost_usd + p_cost_usd >= v_daily * 0.8
      AND (last_cap_warn_at IS NULL OR last_cap_warn_at::date < v_day) THEN NOW() ELSE last_cap_warn_at END
    WHERE day = v_day AND provider = p_provider;
  SELECT cost_usd + p_cost_usd INTO v_new_daily FROM daily_api_usage WHERE day = v_day AND provider = p_provider;
  SELECT COALESCE(SUM(cost_usd),0) INTO v_new_monthly FROM daily_api_usage
    WHERE provider = p_provider AND day >= v_day - INTERVAL '30 days';
  v_hit := CASE
    WHEN v_source > 0 AND current_source_cost() + p_cost_usd > v_source THEN 'source'
    WHEN p_run_id IS NOT NULL AND current_run_cost() + p_cost_usd > run_cap() THEN 'run'
    WHEN v_daily > 0 AND v_new_daily > v_daily THEN 'day'
    WHEN v_monthly > 0 AND v_new_monthly > v_monthly THEN 'month' ELSE NULL END;
  RETURN QUERY SELECT v_hit, v_new_daily, v_new_monthly, current_source_cost(), current_run_cost();
END $$;
```

## Testing Strategy

Unit: `checkCap` cap math, `calculateCost` for `mistral-ocr`+`pubchem`, `globalThis` flags, env=0 default, RPC soft-fail → `{cap_hit:null}`, `extractBioprospectingFactsForSource({runId})` threads to provider `extract(pdf, ctx)`. Integration: `record_api_call` 2 concurrent calls serialize (2nd returns `cap_hit='day'`), orchestrator daily cap → local fallback, `compoundAuthority.worker` aborts on `isProviderDisabled=true`. `bun test` + mocked `getServiceClient`; Postgres local for the RPC concurrency test.

## Migration / Rollout

3 chained PRs, each < 400 LOC (proposal §"PR split"):

1. **PR #1** — Migration + `costService.ts` + env vars + cap/race/soft-WARN unit tests. ~280 LOC. No runtime impact.
2. **PR #2** — Mistral wrap: thread `runId`/`sourceId` through `bioprospectingExtractor → pdfTableExtractor` + local fallback + integration tests. ~220 LOC. Feature-flagged behind `MISTRAL_OCR_COST_GUARD=true`.
3. **PR #3** — PubChem wrap + worker day-cap + `/admin/cost-totals` + WebSocket `apiCost` + dashboard inline. ~250 LOC. Admin route additive.

Rollback: PR #1 = drop migration. PR #2 = flip `MISTRAL_OCR_COST_GUARD=false`. PR #3 = delete admin route file (WebSocket field is optional).

## Open Questions

None. All locked decisions in proposal §"Resolved decisions (locked)" + spec requirements are addressable with the patterns above.
