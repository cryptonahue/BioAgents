# Spec: api-cost-guard-rails

## Purpose

Track and cap spend on external API providers (Mistral OCR, PubChem)
that the Research Brain calls during research ingestion, with the same
proven pattern that `llm-cost` already applies to LLM spend. The
capability exposes per-run, per-source, per-day (24h), and per-month
(rolling 30-day) caps, an atomic `record_api_call` RPC that performs
the cap check and increment under a row lock, a single import-point
service module, and inline visibility on the corpus dashboard and
admin drill-down.

When a provider's daily or monthly cap is hit, callers receive a
typed `CostCapExceededError` and a `globalThis` provider-disabled
flag short-circuits subsequent calls until the cap window resets.
A soft WARN is emitted at `COST_ALERT_SOFT_THRESHOLD` (default 0.8)
of the active cap. RPC failures soft-fail (log + continue) so a DB
blip never aborts an extraction.

## Requirements

### Requirement: daily_api_usage Schema

The system MUST create a `daily_api_usage` table that is the
authoritative accumulator of external API spend per `(day, provider)`
pair. All cost math, soft-threshold alerts, and cap checks MUST
read from this table.

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS public.daily_api_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day DATE NOT NULL,
  provider TEXT NOT NULL,
  units NUMERIC(20,6) NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  calls_count INTEGER NOT NULL DEFAULT 0,
  last_cap_warn_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (day, provider)
);

CREATE INDEX IF NOT EXISTS idx_daily_api_usage_provider_day
  ON public.daily_api_usage (provider, day DESC);
```

**Column semantics:**

- `day` — UTC date of the usage window. All cost math uses UTC
  midnight boundaries.
- `provider` — one of `'mistral_ocr' | 'pubchem'`. New providers
  extend this enum at the cap-env-var level, not the schema level.
- `units` — provider-defined unit count (Mistral: pages; PubChem:
  requests). Cumulative per `(day, provider)`.
- `cost_usd` — cumulative USD spend per `(day, provider)`. Stored
  as `NUMERIC(10,6)` to keep sub-cent precision for cap checks.
- `calls_count` — cumulative call count per `(day, provider)`.
- `last_cap_warn_at` — timestamp of the most recent soft-threshold
  WARN emission. The RPC uses this column to make the soft-WARN
  idempotent: once a day/provider has been warned at 80%, the
  column is updated and subsequent calls in the same day do NOT
  re-emit the WARN.

#### Scenario: First call of the day inserts a new row

- GIVEN no row exists in `daily_api_usage` for `(day=2026-06-14,
  provider='mistral_ocr')`
- WHEN `record_api_call(...)` runs with `provider='mistral_ocr'`
- THEN a new row exists with `units=...`, `cost_usd=...`,
  `calls_count=1`

#### Scenario: Subsequent call of the same day increments the row

- GIVEN a row exists for `(day=2026-06-14, provider='mistral_ocr')`
  with `cost_usd=12.50` and `calls_count=5`
- WHEN `record_api_call(...)` adds `cost_usd=0.50`, `units=3`
- THEN the same row has `cost_usd=13.00` and `calls_count=6`

#### Scenario: Cap warn is idempotent within a day

- GIVEN a row at `cost_usd=40.00` with `last_cap_warn_at` set
  earlier today
- WHEN the next call brings the total to `42.00` (still above 80%
  of the $50 daily cap)
- THEN the RPC does NOT emit a new `cost_alert_soft_hit` log
- AND `last_cap_warn_at` is NOT updated again

### Requirement: record_api_call RPC

The system MUST expose a Postgres RPC `record_api_call(run_id,
source_id, provider, units, cost_usd, metadata)` that performs the
cap check and the increment atomically. The RPC MUST lock the
`(day, provider)` row with `SELECT ... FOR UPDATE` before
comparing against the active caps, so concurrent workers cannot
race past a cap.

**RPC contract:**

```sql
record_api_call(
  p_run_id UUID,
  p_source_id UUID,
  p_provider TEXT,
  p_units NUMERIC,
  p_cost_usd NUMERIC,
  p_metadata JSONB
) RETURNS TABLE (
  cap_hit TEXT,             -- NULL | 'day' | 'month' | 'source' | 'run'
  current_daily_cost NUMERIC,
  current_monthly_cost NUMERIC,
  current_source_cost NUMERIC,
  current_run_cost NUMERIC
)
```

**Behavior:**

- The RPC MUST look up the cap values from the environment (or a
  `provider_caps` table) inside the function body, not as RPC
  parameters, so callers cannot bypass the cap by passing wrong
  values.
- The RPC MUST upsert the `(day, provider)` row inside the same
  transaction as the cap check, so a soft-WARN at 80% and a
  hard cap at 100% are mutually consistent.
- Monthly cost is computed as the rolling 30-day sum of
  `cost_usd` for the provider: `SELECT SUM(cost_usd) FROM
  daily_api_usage WHERE provider = p_provider AND day >=
  CURRENT_DATE - INTERVAL '30 days'`.
- Per-source cost is computed by joining `metadata->>'source_id'`
  to the `ext_api_calls` JSONB on `research_ingestion_runs`.
- Per-run cost is computed by joining on `metadata->>'run_id'`.
- When any cap is hit, the RPC MUST still record the call (best-
  effort visibility) and return the matching `cap_hit` value. The
  caller is responsible for throwing `CostCapExceededError` based
  on the returned value.
- The RPC MUST be the only writer of `daily_api_usage`.

#### Scenario: RPC increments and returns no cap hit

- GIVEN daily cost is $12, monthly cost is $300, per-source
  cost is $0.50
- WHEN `record_api_call` adds a $0.10 call
- THEN it returns `cap_hit = NULL` and the incremented
  `current_daily_cost = 12.10`

#### Scenario: RPC returns day cap hit at 100%

- GIVEN `MISTRAL_OCR_DAILY_COST_CAP_USD=50` and daily cost is
  $49.95
- WHEN `record_api_call` adds a $0.10 call
- THEN it returns `cap_hit = 'day'`
- AND the row is still updated to `cost_usd = 50.05`
- AND the caller throws `CostCapExceededError`

#### Scenario: Concurrent calls cannot race past the day cap

- GIVEN two workers call `record_api_call` concurrently for the
  same `(day, provider='mistral_ocr')` when daily cost is $49.95
- WHEN both calls add $0.10
- THEN the row lock serializes them
- AND the first call returns `cap_hit = 'day'`
- AND the second call returns `cap_hit = 'day'` (or NULL if the
  cap is checked post-increment and over-shoots by design)
- AND the cumulative `cost_usd` is exactly the sum of both calls
  (no double-count, no lost update)

#### Scenario: RPC soft-fails on DB blip

- GIVEN the Postgres connection is unavailable
- WHEN the caller invokes `record_api_call`
- THEN the caller catches the error, logs `cost_rpc_soft_fail`
  with the provider, and does NOT throw
- AND the caller's extraction continues

### Requirement: costService Single Import Point

The system MUST expose a single service module at
`src/services/researchBrain/costService.ts` that wraps the
`record_api_call` RPC and provides the read-side helpers for
dashboards and the orchestrator. All Research Brain code that
needs to record, check, or read external API spend MUST import
from this module — direct RPC calls from feature code are
forbidden.

**Public API:**

```typescript
// Recording
recordApiCall(input: {
  runId?: string;
  sourceId?: string;
  provider: 'mistral_ocr' | 'pubchem';
  units: number;
  costUsd: number;
  metadata?: Record<string, unknown>;
}): Promise<CapCheckResult>

// Pre-call check
checkCap(input: {
  provider: 'mistral_ocr' | 'pubchem';
  estimatedCostUsd: number;
  sourceId?: string;
  runId?: string;
}): Promise<{
  allowed: boolean;
  wouldHitDaily: boolean;
  wouldHitMonthly: boolean;
  wouldHitPerSource: boolean;
  wouldHitPerRun: boolean;
}>

// Read-side
getDailyTotals(since: '24h' | '7d' | '30d'): Promise<DailyTotal[]>
getPerSourceTotals(sourceId: string): Promise<{ totalUsd: number; callCount: number }>
getCurrentSpend(input: { provider: string; dayOrMonth: 'day' | 'month' }): Promise<number>

// Provider-disabled flags
isProviderDisabled(provider: 'mistral_ocr' | 'pubchem'): Promise<boolean>
```

**Behavior:**

- `recordApiCall` MUST wrap the RPC. On RPC exception, it MUST
  log a WARN with `cost_rpc_soft_fail` and return
  `{ cap_hit: null, ... }` — it MUST NOT throw.
- `checkCap` MUST be a read-only projection: it MUST NOT write to
  `daily_api_usage` and MUST NOT emit soft-WARN logs. It exists
  so the orchestrator can decide whether to call the provider at
  all when an estimated cost is large.
- `getDailyTotals(since='24h' | '7d' | '30d')` MUST aggregate
  from `daily_api_usage` (NOT compute monthly via `INTERVAL
  '30 days'` here — `getCurrentSpend` is the canonical monthly
  read).
- `isProviderDisabled(provider)` MUST return the value of a
  TDZ-safe `globalThis.__<provider>Disabled__` flag, which the
  RPC failure path also sets when `cap_hit='day'` or
  `cap_hit='month'`.
- The module MUST NOT use any module-level mutable variables
  (TDZ in Bun workers); all cached flags live on `globalThis`.

#### Scenario: checkCap returns false on monthly cap exceeded

- GIVEN monthly cost is $999.50 and
  `MISTRAL_OCR_MONTHLY_COST_CAP_USD=1000`
- WHEN `checkCap({ provider: 'mistral_ocr', estimatedCostUsd: 1.00 })`
- THEN it returns `{ allowed: false, wouldHitMonthly: true, ... }`

#### Scenario: recordApiCall soft-fails on RPC exception

- GIVEN the Supabase client throws a network error
- WHEN `recordApiCall({ provider: 'mistral_ocr', costUsd: 0.10 })`
- THEN the call resolves with `{ cap_hit: null, ... }`
- AND a WARN is logged with `event=cost_rpc_soft_fail`

#### Scenario: Direct RPC call from feature code is not allowed

- GIVEN the linting / review convention in `openspec/config.yaml`
- WHEN a new call to `record_api_call` is added outside
  `costService.ts`
- THEN the PR is rejected

### Requirement: research_ingestion_runs Extension

The system MUST extend `research_ingestion_runs` with two new
columns for inline visibility:

```sql
ALTER TABLE public.research_ingestion_runs
  ADD COLUMN IF NOT EXISTS ext_api_cost NUMERIC(10,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ext_api_calls JSONB NOT NULL DEFAULT '{}'::jsonb;
```

**Column semantics:**

- `ext_api_cost` — cumulative external API spend for this run in
  USD. The `costService.recordApiCall` path MUST update this on
  every successful call.
- `ext_api_calls` — JSONB object keyed by provider, holding
  `{ units, costUsd, calls }` per provider. The `pdf-table-
  extraction` orchestrator and the `compoundAuthority.worker`
  both write to this column on the same path that increments
  `ext_api_cost`.

Both columns are additive. Existing rows have `ext_api_cost = 0`
and `ext_api_calls = {}`. No migration of historical data is
required.

#### Scenario: run column is incremented on each call

- GIVEN run R with `ext_api_cost = 0` and `ext_api_calls = {}`
- WHEN `costService.recordApiCall` runs with
  `provider='mistral_ocr', costUsd=0.10`
- THEN R's `ext_api_cost = 0.10`
- AND R's `ext_api_calls = { "mistral_ocr": { "units": 1, "costUsd": 0.10, "calls": 1 } }`

#### Scenario: existing rows are not migrated

- GIVEN the migration runs against a populated
  `research_ingestion_runs`
- THEN all existing rows have `ext_api_cost = 0` and
  `ext_api_calls = {}`

### Requirement: Cap Configuration And Env Vars

The system MUST read cap values from environment variables and
expose them as documented in `.env.example`. The cap reader MUST
live in `costService.ts` (or a sibling config module it imports)
and MUST fail closed: when an env var is missing, the
corresponding cap defaults to 0 and any call to that provider
returns `cap_hit='day'` immediately.

**Env vars (defaults in parentheses):**

| Variable | Default | Provider | Cap scope |
| --- | --- | --- | --- |
| `MISTRAL_OCR_DAILY_COST_CAP_USD` | `50` | mistral_ocr | per UTC day |
| `MISTRAL_OCR_MONTHLY_COST_CAP_USD` | `1000` | mistral_ocr | rolling 30d |
| `MISTRAL_OCR_PER_SOURCE_COST_CAP_USD` | `2` | mistral_ocr | per `source_id` |
| `PUBCHEM_DAILY_REQUEST_CAP` | `200000` | pubchem | per UTC day (units) |
| `COST_ALERT_HARD_BLOCK` | `true` | all | toggle for hard block |
| `COST_ALERT_SOFT_THRESHOLD` | `0.8` | all | fraction of cap that triggers WARN |
| `MISTRAL_OCR_ENABLED` | `true` | mistral_ocr | global kill-switch |
| `PUBCHEM_ENABLED` | `true` | pubchem | global kill-switch |

**Behavior:**

- `MISTRAL_OCR_ENABLED=false` MUST short-circuit at module init
  time inside the Mistral provider, not inside `costService` —
  the same TDZ-safe pattern as `TABLE_MERGE_ENABLED`.
- When `COST_ALERT_HARD_BLOCK=false`, the RPC still returns
  `cap_hit = 'day' | 'month' | ...` but the caller MUST NOT
  throw — it MUST log `cost_alert_hard_block_disabled` and
  continue. This is the override for soft-cap operation.

#### Scenario: Missing cap env var defaults to zero

- GIVEN `MISTRAL_OCR_DAILY_COST_CAP_USD` is unset
- WHEN `costService.checkCap({ provider: 'mistral_ocr', ... })`
- THEN the daily cap is `0`
- AND `checkCap.allowed` is `false` for any positive cost

#### Scenario: MISTRAL_OCR_ENABLED=false short-circuits the provider

- GIVEN `MISTRAL_OCR_ENABLED=false`
- WHEN the Mistral provider's `callOcr` runs
- THEN it throws `TableExtractionProviderError` with a clear
  "MISTRAL_OCR_ENABLED=false" message BEFORE calling
  `costService`

#### Scenario: COST_ALERT_HARD_BLOCK=false allows over-cap calls

- GIVEN daily cap is $50 and current daily cost is $60
- AND `COST_ALERT_HARD_BLOCK=false`
- WHEN `recordApiCall` returns `cap_hit='day'`
- THEN the caller logs `cost_alert_hard_block_disabled`
- AND does NOT throw

### Requirement: Soft-Threshold WARN

The system MUST emit a single WARN per `(day, provider)` when
the cumulative cost crosses `COST_ALERT_SOFT_THRESHOLD` (default
0.8) of the active cap. The WARN is gated by
`daily_api_usage.last_cap_warn_at` so a long-running day does
not spam the logs.

**Behavior:**

- The RPC MUST update `last_cap_warn_at = NOW()` exactly when
  it crosses the threshold, regardless of whether `COST_ALERT_
  HARD_BLOCK` is true.
- The WARN MUST be structured: `event=cost_alert_soft_hit`,
  `provider`, `current_daily_cost`, `daily_cap`,
  `current_monthly_cost`, `monthly_cap`,
  `threshold=COST_ALERT_SOFT_THRESHOLD`.
- No email / webhook / Discord delivery in v1 (YAGNI per
  proposal's locked Q2).

#### Scenario: First crossing of 80% emits a WARN

- GIVEN `MISTRAL_OCR_DAILY_COST_CAP_USD=50` and daily cost is
  $30
- WHEN the next call brings daily cost to $40.50 (81%)
- THEN `last_cap_warn_at` is updated to NOW()
- AND a WARN is logged with `event=cost_alert_soft_hit`

#### Scenario: Subsequent call above 80% does not re-emit WARN

- GIVEN `last_cap_warn_at` was set on a prior call today
- WHEN another call brings daily cost from $42 to $45
- THEN `last_cap_warn_at` is NOT updated
- AND no new WARN is logged

### Requirement: Pre-Call Page Estimate

The system MUST estimate the page count of a PDF before calling
the Mistral provider, using a safe over-count formula:
`Math.ceil(pdf.byteLength / 100_000)`. The estimate feeds
`costService.checkCap.estimatedCostUsd` so the orchestrator can
decline to call Mistral when the estimate already exceeds the
per-source cap.

**Behavior:**

- The estimate is intentionally a safe over-count: ~1 page per
  100KB is conservative for research PDFs that are mostly
  text. The over-count ensures the cap is hit BEFORE the actual
  spend, not after.
- The post-call reconciliation (see the modified
  `pdf-table-extraction` spec) records the actual `pages.length`
  on `research_ingestion_runs.ext_api_calls.mistral_ocr.units`.

#### Scenario: 5 MB PDF estimates 50 pages

- GIVEN a 5_000_000-byte PDF
- WHEN the page estimator runs
- THEN the estimate is `Math.ceil(5_000_000 / 100_000) = 50`

#### Scenario: Estimate exceeds per-source cap and call is skipped

- GIVEN `MISTRAL_OCR_PER_SOURCE_COST_CAP_USD=2` and per-page
  cost is `$0.05` (so cap is 40 pages)
- AND a 5 MB PDF estimates 50 pages (cost $2.50)
- WHEN `checkCap` runs
- THEN `wouldHitPerSource = true`
- AND the orchestrator skips the Mistral call and falls back to
  the local provider

### Requirement: Failure Mode Matrix

The system MUST implement the locked failure-mode matrix from
the proposal's "Failure-mode matrix (locked)" table. The
contract below is the executable spec for that table.

**Behavior:**

- **Per-run cap** — `recordApiCall` returns
  `cap_hit='run'`. Caller throws
  `CostCapExceededError({ scope: 'run' })`.
  `pdfTableExtractor` catches, falls back to `local`, logs
  `mistral_cap_run_exceeded`. Run continues for other sources.
- **Per-source cap** — Same as per-run. Log includes
  `sourceId`. Run NOT aborted.
- **Per-day cap** — `recordApiCall` returns `cap_hit='day'`.
  Caller throws. `pdfTableExtractor` falls back to `local`,
  sets `globalThis.__mistralOcrDisabledToday__ = true`, logs
  `mistral_disabled_today` (WARN). Subsequent calls in the
  same process short-circuit to `local` until the day rolls
  over.
- **Per-month cap (rolling 30d)** — `cap_hit='month'`. Caller
  throws. `pdfTableExtractor` falls back to `local`, sets
  `globalThis.__mistralOcrDisabledThisMonth__ = true`, logs
  `mistral_disabled_this_month` (ERROR). Subsequent calls
  short-circuit.
- **`MISTRAL_OCR_ENABLED=false`** — Mistral provider throws
  BEFORE the RPC is called. `pdfTableExtractor` falls back to
  `local`.
- **RPC failure (DB blip)** — `recordApiCall` catches, logs
  `cost_rpc_soft_fail`, returns `{ cap_hit: null, ... }`.
  Caller continues as if the cap was not hit. NO abort.

#### Scenario: Per-day cap → local fallback + global flag

- GIVEN daily Mistral cost is $50.00 (cap)
- WHEN `pdfTableExtractor` processes source S
- THEN the Mistral call throws
- AND the orchestrator retries with the local provider
- AND `globalThis.__mistralOcrDisabledToday__` is `true`
- AND the next source in the same run uses the local provider
  without calling Mistral

#### Scenario: RPC failure does not abort extraction

- GIVEN the Supabase client throws a network error inside
  `recordApiCall`
- WHEN `pdfTableExtractor` processes source S
- THEN the extraction continues with the actual Mistral call
- AND a WARN is logged with `event=cost_rpc_soft_fail`

### Requirement: Garbage Collection

The system MUST garbage-collect `daily_api_usage` rows older
than 35 days on a daily schedule. The job is a single
`DELETE FROM daily_api_usage WHERE day < CURRENT_DATE - INTERVAL
'35 days'` statement.

**Behavior:**

- The 35-day window preserves two full 30-day cap windows plus a
  5-day buffer for clock skew.
- The job MAY run via a Postgres scheduled job (`pg_cron`) or
  via a Bun cron tick — the choice is implementation, not
  spec-level. The behavior (rows older than 35 days deleted
  nightly) is the contract.
- The GC MUST run on a schedule, not on read; reads MUST work
  for any day in the last 35 days.

#### Scenario: 36-day-old row is deleted by GC

- GIVEN a row with `day = '2026-05-09'` exists
- AND the current date is `2026-06-14`
- WHEN the GC job runs
- THEN the row is deleted

#### Scenario: 30-day-old row is preserved

- GIVEN a row with `day = '2026-05-15'` exists
- AND the current date is `2026-06-14`
- WHEN the GC job runs
- THEN the row is preserved (still inside the 35-day window)

### Requirement: LLM Cost Calculator Extension

The system MUST extend `src/services/researchBrain/llm-cost.ts`
`calculateCost` to recognize two new provider keys:
`mistral-ocr` and `pubchem`. The `mistral-ocr` entry MUST be
priced per page (default `$0.05` per page when no override is
configured). The `pubchem` entry MUST always return `costUsd =
0` but MUST increment a `units` counter so the cap check can
compare against `PUBCHEM_DAILY_REQUEST_CAP`.

**Behavior:**

- The extension is additive. Existing provider pricing is
  unchanged.
- The unit returned for `pubchem` is `1` per call; the cap
  check uses `units` (request count), not `costUsd`.

#### Scenario: mistral-ocr pricing

- GIVEN `MISTRAL_OCR_COST_PER_PAGE_USD=0.05` (or default $0.05)
- WHEN `calculateCost` is called with
  `{ provider: 'mistral-ocr', units: 50 }`
- THEN it returns `{ costUsd: 2.50, units: 50 }`

#### Scenario: pubchem is free but tracked

- GIVEN the default `pubchem` pricing
- WHEN `calculateCost` is called with
  `{ provider: 'pubchem', units: 1 }`
- THEN it returns `{ costUsd: 0, units: 1 }`
- AND the cap check uses `units` (request count) against
  `PUBCHEM_DAILY_REQUEST_CAP`
