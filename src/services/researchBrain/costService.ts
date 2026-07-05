/**
 * External API Cost Service (api-cost-guard-rails)
 *
 * Single import point for all Research Brain code that needs to:
 *   - pre-check the active cap for a provider (Mistral OCR, PubChem)
 *   - record a call to the authoritative `daily_api_usage` accumulator
 *   - read per-day, per-source, or per-month spend
 *   - check the TDZ-safe `globalThis` provider-disabled flags
 *
 * Atomicity is enforced inside the `record_api_call` Postgres RPC
 * (see `supabase/migrations/20260615000000_add_api_cost_tracking.sql`):
 *   - the (day, provider) row is locked with `SELECT ... FOR UPDATE`
 *     before any cap comparison
 *   - the row is then updated atomically with units / cost_usd /
 *     calls_count increments
 *   - the RPC returns the highest-precedence cap_hit (source > run >
 *     day > month) so the caller can throw `CostCapExceededError`
 *
 * This module never throws on RPC failures — it logs
 * `cost_rpc_soft_fail` and returns a `{ capHit: null, ... }` shape
 * so a DB blip never aborts an extraction. Direct RPC calls from
 * feature code are forbidden by spec; always import from here.
 */

import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";
import { notifyRunApiCall } from "../queue/notify";
// Note: costService.ts → queue/notify.ts → queue/types.ts is a
// dependency chain the build graph tolerates. notify.ts does not
// import from costService, so this stays acyclic.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApiProvider = "mistral_ocr" | "pubchem";

export type CapScope = "day" | "month" | "source" | "run";

export interface RecordApiCallInput {
  runId?: string;
  sourceId?: string;
  provider: ApiProvider;
  units: number;
  costUsd: number;
  metadata?: Record<string, unknown>;
}

export interface CapCheckResult {
  capHit: CapScope | null;
  currentDailyCost: number;
  currentMonthlyCost: number;
  currentSourceCost: number;
  currentRunCost: number;
}

export interface CheckCapInput {
  provider: ApiProvider;
  estimatedCostUsd: number;
  units?: number;
  sourceId?: string;
  runId?: string;
}

export interface CheckCapResult {
  allowed: boolean;
  wouldHitDaily: boolean;
  wouldHitMonthly: boolean;
  wouldHitPerSource: boolean;
  wouldHitPerRun: boolean;
}

export interface DailyTotalRow {
  day: string;
  provider: string;
  units: number;
  costUsd: number;
  calls: number;
}

export interface CostConfig {
  mistralOcrDailyCapUsd: number;
  mistralOcrMonthlyCapUsd: number;
  mistralOcrPerSourceCapUsd: number;
  pubchemDailyRequestCap: number;
  costAlertHardBlock: boolean;
  costAlertSoftThreshold: number;
  mistralOcrEnabled: boolean;
  pubchemEnabled: boolean;
}

/**
 * Thrown when the RPC returns a cap_hit. `scope` is the cap that
 * was crossed: 'day' (daily cap), 'month' (rolling 30d cap),
 * 'source' (per-source cap), or 'run' (per-run cap).
 */
export class CostCapExceededError extends Error {
  readonly scope: CapScope;
  readonly provider: ApiProvider;
  constructor(opts: {
    scope: CapScope;
    provider: ApiProvider;
    message?: string;
  }) {
    super(
      opts.message ??
        `Cost cap exceeded for ${opts.provider} (scope=${opts.scope})`,
    );
    this.name = "CostCapExceededError";
    this.scope = opts.scope;
    this.provider = opts.provider;
  }
}

// ---------------------------------------------------------------------------
// Cost configuration (env-driven, TDZ-safe via globalThis)
// ---------------------------------------------------------------------------
//
// Cap values are read from process.env on every call (matches the
// `getCompoundAuthorityConfig` pattern: the function the worker
// calls re-reads env each time so test mutations and runtime
// overrides take effect). A cached snapshot is also exposed for
// callers that want read-once semantics at module load.

const COST_CONFIG_CACHE_KEY = "__apiCostGuardRailsConfig";

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function readEnvBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return raw.toLowerCase() !== "false" && raw !== "0";
}

export function getCostConfig(): CostConfig {
  return {
    mistralOcrDailyCapUsd: readEnvNumber("MISTRAL_OCR_DAILY_COST_CAP_USD", 50),
    mistralOcrMonthlyCapUsd: readEnvNumber(
      "MISTRAL_OCR_MONTHLY_COST_CAP_USD",
      1000,
    ),
    mistralOcrPerSourceCapUsd: readEnvNumber(
      "MISTRAL_OCR_PER_SOURCE_COST_CAP_USD",
      2,
    ),
    pubchemDailyRequestCap: readEnvNumber("PUBCHEM_DAILY_REQUEST_CAP", 200_000),
    costAlertHardBlock: readEnvBool("COST_ALERT_HARD_BLOCK", true),
    costAlertSoftThreshold: readEnvNumber("COST_ALERT_SOFT_THRESHOLD", 0.8),
    mistralOcrEnabled: readEnvBool("MISTRAL_OCR_ENABLED", true),
    pubchemEnabled: readEnvBool("PUBCHEM_ENABLED", true),
  };
}

/** Cached config snapshot — read once at module load per the spec. */
export const COST_CONFIG: CostConfig = (() => {
  const g = globalThis as Record<string, unknown>;
  if (g[COST_CONFIG_CACHE_KEY]) return g[COST_CONFIG_CACHE_KEY] as CostConfig;
  const cfg = getCostConfig();
  g[COST_CONFIG_CACHE_KEY] = cfg;
  return cfg;
})();

// ---------------------------------------------------------------------------
// TDZ-safe provider-disabled flags (mirror pdfTableExtractor.resolveMode)
// ---------------------------------------------------------------------------
//
// Flags are stored on globalThis so Bun workers (which have different
// module-init order than the main process) do not hit TDZ on
// shared module state. The flag is set by `recordApiCall` when the
// RPC returns cap_hit='day' or cap_hit='month', and is read by
// `isProviderDisabled` from the orchestrator / worker before any
// pre-call check.

function flagKey(provider: ApiProvider, scope: "Today" | "ThisMonth"): string {
  return `__${provider}Disabled${scope}__`;
}

export function isProviderDisabled(provider: ApiProvider): boolean {
  const g = globalThis as Record<string, unknown>;
  return (
    Boolean(g[flagKey(provider, "Today")]) ||
    Boolean(g[flagKey(provider, "ThisMonth")])
  );
}

/**
 * Manually set a provider's disabled flag. Test helper for unit
 * tests; also used by the orchestrator when handling a cap hit in
 * the same process.
 */
export function disableProviderToday(
  provider: ApiProvider,
  // reason is currently unused; logged at the call site. Reserved
  // for future structured-logging fields.
  _reason?: string,
): void {
  const g = globalThis as Record<string, unknown>;
  g[flagKey(provider, "Today")] = true;
}

export function disableProviderThisMonth(
  provider: ApiProvider,
  _reason?: string,
): void {
  const g = globalThis as Record<string, unknown>;
  g[flagKey(provider, "ThisMonth")] = true;
}

/**
 * Clear all provider-disabled flags. Test helper — never call in
 * production code. Resets the globalThis state for the four known
 * (provider, scope) combinations.
 */
export function resetDailyFlags(): void {
  const g = globalThis as Record<string, unknown>;
  for (const provider of ["mistral_ocr", "pubchem"] as ApiProvider[]) {
    g[flagKey(provider, "Today")] = false;
    g[flagKey(provider, "ThisMonth")] = false;
  }
}

// ---------------------------------------------------------------------------
// Active cap resolution (per provider)
// ---------------------------------------------------------------------------

interface ActiveCaps {
  daily: number; // 0 = cap disabled
  monthly: number; // 0 = cap disabled
  perSource: number; // 0 = cap disabled
  perRun: number; // 0 = cap disabled
  softThreshold: number; // 0.8 default
}

function getActiveCaps(provider: ApiProvider): ActiveCaps {
  const cfg = getCostConfig();
  if (provider === "mistral_ocr") {
    return {
      daily: cfg.mistralOcrDailyCapUsd,
      monthly: cfg.mistralOcrMonthlyCapUsd,
      perSource: cfg.mistralOcrPerSourceCapUsd,
      // Per-run cap is a future extension; the spec locks it as
      // available via RPC (p_run_id) but not env-driven in v1.
      perRun: 0,
      softThreshold: cfg.costAlertSoftThreshold,
    };
  }
  // pubchem: per-day request cap (units-based, not USD). The
  // RPC returns cost_usd=0 for pubchem calls; the daily cap is
  // enforced against `units` in `checkCap` (pre-call) and
  // `recordApiCall` (post-call). We pass the cap through as the
  // `daily` slot in ActiveCaps and let the caller compare against
  // units.
  return {
    daily: cfg.pubchemDailyRequestCap,
    monthly: 0,
    perSource: 0,
    perRun: 0,
    softThreshold: cfg.costAlertSoftThreshold,
  };
}

// ---------------------------------------------------------------------------
// RPC: record_api_call
// ---------------------------------------------------------------------------

const EMPTY_RESULT: CapCheckResult = {
  capHit: null,
  currentDailyCost: 0,
  currentMonthlyCost: 0,
  currentSourceCost: 0,
  currentRunCost: 0,
};

function normalizeRpcRow(row: unknown): CapCheckResult {
  if (row == null || typeof row !== "object") return { ...EMPTY_RESULT };
  const r = row as Record<string, unknown>;
  const capHitRaw = r.cap_hit ?? r.capHit;
  const capHit =
    capHitRaw === "day" ||
    capHitRaw === "month" ||
    capHitRaw === "source" ||
    capHitRaw === "run"
      ? (capHitRaw as CapScope)
      : null;
  return {
    capHit,
    currentDailyCost: Number(r.current_daily_cost ?? 0),
    currentMonthlyCost: Number(r.current_monthly_cost ?? 0),
    currentSourceCost: Number(r.current_source_cost ?? 0),
    currentRunCost: Number(r.current_run_cost ?? 0),
  };
}

/**
 * Record an external API call to the `daily_api_usage` accumulator
 * via the `record_api_call` RPC. Soft-fails on RPC exception
 * (returns `{ capHit: null, ... }` and logs `cost_rpc_soft_fail`).
 * NEVER throws.
 *
 * On `cap_hit='day'` or `cap_hit='month'`, sets the corresponding
 * `globalThis` provider-disabled flag so subsequent calls in the
 * same process short-circuit.
 */
export async function recordApiCall(
  input: RecordApiCallInput,
): Promise<CapCheckResult> {
  try {
    const caps = getActiveCaps(input.provider);
    const supabase = getServiceClient();
    const { data, error } = await supabase.rpc("record_api_call", {
      p_run_id: input.runId ?? null,
      p_source_id: input.sourceId ?? null,
      p_provider: input.provider,
      p_units: input.units,
      p_cost_usd: input.costUsd,
      p_metadata: input.metadata ?? {},
    });

    if (error) {
      logger.warn(
        {
          err: error,
          event: "cost_rpc_soft_fail",
          provider: input.provider,
        },
        "record_api_call returned an error; soft-failing",
      );
      return { ...EMPTY_RESULT };
    }

    const result = normalizeRpcRow(Array.isArray(data) ? data[0] : data);

    // Set the process-local provider-disabled flag if a cap was hit.
    if (result.capHit === "day") {
      disableProviderToday(input.provider, "rpc day cap hit");
    } else if (result.capHit === "month") {
      disableProviderThisMonth(input.provider, "rpc month cap hit");
    }

    // Soft-threshold WARN is a debug aid for callers; the RPC
    // already updates `last_cap_warn_at` server-side, so we do
    // not need to log here unless the caller asks.
    void caps;

    return result;
  } catch (err) {
    logger.warn(
      {
        err,
        event: "cost_rpc_soft_fail",
        provider: input.provider,
      },
      "record_api_call threw; soft-failing",
    );
    return { ...EMPTY_RESULT };
  }
}

// ---------------------------------------------------------------------------
// Read-side: checkCap (read-only pre-call projection)
// ---------------------------------------------------------------------------

/**
 * Pre-call cap projection. Computes whether the proposed call
 * would cross any active cap, without writing to
 * `daily_api_usage`. Returns the result synchronously when the
 * cap=0 short-circuit applies and asynchronously otherwise.
 *
 * Respects the globalThis provider-disabled flags: if a flag is
 * set, the result is `{ allowed: false, ...all true }`.
 *
 * For pubchem, the `estimatedCostUsd` is ignored — the cap is
 * units-based (PUBCHEM_DAILY_REQUEST_CAP) and we compare against
 * `units` (default 1 for a single call).
 *
 * Hard-block override (WARNING #3 fix):
 *   When `COST_ALERT_HARD_BLOCK=false` AND the cap math says we
 *   would hit, `checkCap` returns `allowed: true` (with the
 *   individual `wouldHit*` flags still set to true so the caller
 *   knows the cap was crossed). The RPC still increments the
 *   counters and the dashboard still shows the overage — only the
 *   hard-block decision is suppressed. A
 *   `cost_alert_hard_block_disabled` log event is emitted so
 *   operators can see when the override is in effect.
 *
 * The provider-disabled flag (`globalThis.__<provider>Disabled__`)
 * is a separate, process-local latching mechanism set by a
 * previous RPC call returning `cap_hit='day'|'month'`. It is NOT
 * affected by `COST_ALERT_HARD_BLOCK` — that flag exists so a
 *   day-cap hit in one process propagates the disable to the rest
 *   of the process. The env override is a "soft mode" override of
 *   the cap MATH, not of the latched flag.
 */
export async function checkCap(input: CheckCapInput): Promise<CheckCapResult> {
  const caps = getActiveCaps(input.provider);

  // Short-circuit when the provider is already disabled for the
  // day or month. The latched flag is a process-local kill switch;
  // COST_ALERT_HARD_BLOCK does NOT override it.
  if (isProviderDisabled(input.provider)) {
    return {
      allowed: false,
      wouldHitDaily: true,
      wouldHitMonthly: true,
      wouldHitPerSource: false,
      wouldHitPerRun: false,
    };
  }

  const wouldHitDaily =
    caps.daily > 0 &&
    (input.provider === "pubchem"
      ? (input.units ?? 1) >= caps.daily
      : input.estimatedCostUsd >= caps.daily);
  const wouldHitMonthly =
    caps.monthly > 0 && input.estimatedCostUsd >= caps.monthly;
  const wouldHitPerSource =
    caps.perSource > 0 && input.estimatedCostUsd >= caps.perSource;
  const wouldHitPerRun =
    caps.perRun > 0 && input.estimatedCostUsd >= caps.perRun;

  const wouldHitAny =
    wouldHitDaily || wouldHitMonthly || wouldHitPerSource || wouldHitPerRun;

  // Hard-block override: when COST_ALERT_HARD_BLOCK=false, the cap
  // math still runs (so the wouldHit* flags stay truthful) but the
  // allowed decision is always true. The counter still goes up
  // (recordApiCall is called regardless) so the dashboard still
  // surfaces the overage. A structured log event is emitted here so
  // operators can audit when the override is in effect.
  if (wouldHitAny) {
    const cfg = getCostConfig();
    if (!cfg.costAlertHardBlock) {
      logger.warn(
        {
          event: "cost_alert_hard_block_disabled",
          provider: input.provider,
          estimatedCostUsd: input.estimatedCostUsd,
          units: input.units,
          wouldHitDaily,
          wouldHitMonthly,
          wouldHitPerSource,
          wouldHitPerRun,
          softThreshold: cfg.costAlertSoftThreshold,
        },
        "COST_ALERT_HARD_BLOCK=false: cap hit ignored; allowing call",
      );
      return {
        allowed: true,
        wouldHitDaily,
        wouldHitMonthly,
        wouldHitPerSource,
        wouldHitPerRun,
      };
    }
  }

  return {
    allowed: !wouldHitAny,
    wouldHitDaily,
    wouldHitMonthly,
    wouldHitPerSource,
    wouldHitPerRun,
  };
}

// ---------------------------------------------------------------------------
// Read-side: aggregate queries
// ---------------------------------------------------------------------------

/**
 * Aggregate per-(day, provider) totals for the requested window.
 * Returns rows in (day DESC, provider ASC) order. `since` is
 * interpreted as a calendar-day window (24h, 7d, 30d). Reads only;
 * does NOT compute monthly via INTERVAL — that is the canonical
 * read of `getCurrentSpend({ dayOrMonth: 'month' })`.
 */
export async function getDailyTotals(
  since: "24h" | "7d" | "30d",
  provider?: ApiProvider,
): Promise<DailyTotalRow[]> {
  try {
    const supabase = getServiceClient();
    let q = supabase
      .from("daily_api_usage")
      .select("day, provider, units, cost_usd, calls_count")
      .order("day", { ascending: false })
      .order("provider", { ascending: true });
    if (provider) q = q.eq("provider", provider);
    // `since` is in days; we cap at 30 to match the GC window.
    const days = since === "24h" ? 1 : since === "7d" ? 7 : 30;
    // Supabase PostgREST expects an ISO date for `>=` on DATE
    // columns. We use a UTC cutoff computed from `days` ago.
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    q = q.gte("day", cutoff);
    const { data, error } = await q;
    if (error) {
      logger.warn(
        { err: error, event: "cost_query_soft_fail" },
        "getDailyTotals returned an error; returning empty list",
      );
      return [];
    }
    return (data ?? []).map((row) => ({
      day: String(row.day),
      provider: String(row.provider),
      units: Number(row.units ?? 0),
      costUsd: Number(row.cost_usd ?? 0),
      calls: Number(row.calls_count ?? 0),
    }));
  } catch (err) {
    logger.warn(
      { err, event: "cost_query_soft_fail" },
      "getDailyTotals threw; returning empty list",
    );
    return [];
  }
}

/**
 * Total cost and call count for a single source. Reads from the
 * `ext_api_calls` JSONB on `research_ingestion_runs`.
 */
export async function getPerSourceTotals(
  sourceId: string,
): Promise<{ totalUsd: number; callCount: number }> {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("research_ingestion_runs")
      .select("ext_api_calls")
      .eq("source_id", sourceId);
    if (error) {
      logger.warn(
        { err: error, event: "cost_query_soft_fail" },
        "getPerSourceTotals returned an error; returning zeros",
      );
      return { totalUsd: 0, callCount: 0 };
    }
    let totalUsd = 0;
    let callCount = 0;
    for (const row of data ?? []) {
      const calls = (
        row as {
          ext_api_calls?: Record<string, { costUsd?: number; calls?: number }>;
        }
      ).ext_api_calls;
      if (!calls) continue;
      for (const entry of Object.values(calls)) {
        totalUsd += Number(entry.costUsd ?? 0);
        callCount += Number(entry.calls ?? 0);
      }
    }
    return { totalUsd, callCount };
  } catch (err) {
    logger.warn(
      { err, event: "cost_query_soft_fail" },
      "getPerSourceTotals threw; returning zeros",
    );
    return { totalUsd: 0, callCount: 0 };
  }
}

/**
 * Canonical read for a single provider's spend in the current day
 * or rolling 30-day window. `day` reads the (today, provider) row;
 * `month` sums the last 30 days of rows for the provider.
 */
export async function getCurrentSpend(input: {
  provider: ApiProvider;
  dayOrMonth: "day" | "month";
}): Promise<number> {
  try {
    const supabase = getServiceClient();
    if (input.dayOrMonth === "day") {
      const { data, error } = await supabase
        .from("daily_api_usage")
        .select("cost_usd")
        .eq("provider", input.provider)
        .eq("day", new Date().toISOString().slice(0, 10))
        .maybeSingle();
      if (error) return 0;
      return Number((data as { cost_usd?: number } | null)?.cost_usd ?? 0);
    }
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const { data, error } = await supabase
      .from("daily_api_usage")
      .select("cost_usd")
      .eq("provider", input.provider)
      .gte("day", cutoff);
    if (error) return 0;
    return (data ?? []).reduce(
      (sum: number, row) =>
        sum + Number((row as { cost_usd?: number }).cost_usd ?? 0),
      0,
    );
  } catch {
    return 0;
  }
}

/**
 * Read the cumulative units + cost for the (today, provider) row.
 * Used by the admin route (PR #3) to surface cap utilization.
 */
export async function getDayUsage(
  provider: ApiProvider,
  day?: string,
): Promise<{ units: number; costUsd: number; calls: number }> {
  try {
    const supabase = getServiceClient();
    const dayIso = day ?? new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from("daily_api_usage")
      .select("units, cost_usd, calls_count")
      .eq("provider", provider)
      .eq("day", dayIso)
      .maybeSingle();
    if (error || !data) return { units: 0, costUsd: 0, calls: 0 };
    return {
      units: Number((data as { units?: number }).units ?? 0),
      costUsd: Number((data as { cost_usd?: number }).cost_usd ?? 0),
      calls: Number((data as { calls_count?: number }).calls_count ?? 0),
    };
  } catch {
    return { units: 0, costUsd: 0, calls: 0 };
  }
}

/**
 * Read the rolling 30-day sum of cost for a provider. Used by the
 * admin route (PR #3) for monthly cap utilization.
 */
export async function getMonthUsage(
  provider: ApiProvider,
): Promise<{ costUsd: number }> {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("daily_api_usage")
      .select("cost_usd")
      .eq("provider", provider)
      .gte("day", cutoff);
    if (error) return { costUsd: 0 };
    const costUsd = (data ?? []).reduce(
      (sum: number, row) =>
        sum + Number((row as { cost_usd?: number }).cost_usd ?? 0),
      0,
    );
    return { costUsd };
  } catch {
    return { costUsd: 0 };
  }
}

// ---------------------------------------------------------------------------
// In-memory run spend cache + WebSocket delta
// ---------------------------------------------------------------------------
//
// The dashboard's "Runs" table shows `ext_api_cost` and
// `ext_api_calls_count` for the active run. These are read from the
// `research_ingestion_runs` row by the HTTP route, but a fresh read
// per WebSocket event is wasteful. We keep a process-local cache
// keyed by `runId` so the bioprospecting worker (and any other
// caller) can `notifyApiCallDelta` and the dashboard UI updates in
// near-real-time without hitting Postgres.
//
// The cache lives on `globalThis` to be TDZ-safe in Bun workers.

interface RunApiSpendSnapshot {
  apiCost: number;
  apiCallsCount: number;
}

const RUN_API_SPEND_CACHE_KEY = "__apiCostGuardRailsRunSpendCache";

function getRunApiSpendCache(): Map<string, RunApiSpendSnapshot> {
  const g = globalThis as Record<string, unknown>;
  let cache = g[RUN_API_SPEND_CACHE_KEY] as
    | Map<string, RunApiSpendSnapshot>
    | undefined;
  if (!cache) {
    cache = new Map();
    g[RUN_API_SPEND_CACHE_KEY] = cache;
  }
  return cache;
}

/**
 * Clear the in-memory run-spend cache. Test helper — never call in
 * production code. Resets every cached `runId` snapshot.
 */
export function resetRunApiSpendCache(): void {
  getRunApiSpendCache().clear();
}

/**
 * Record a delta to the run's external-API spend and emit a
 * `run:api_call` WebSocket notification. Used by the bioprospecting
 * extractor / worker after a `recordApiCall` returns the post-call
 * counter for the active run.
 *
 * Behavior:
 *  - `runId` is REQUIRED: a no-op (return early) when undefined so
 *    manual one-off scripts (no runId) don't crash.
 *  - Negative deltas (e.g., a rollback) update the cache but do NOT
 *    fire a notification — the dashboard's HTTP read pulls the
 *    authoritative value from `research_ingestion_runs`.
 *  - The notification is fire-and-forget. A publish failure logs
 *    `api_call_notify_failed` and does NOT throw.
 *
 * The caller is responsible for clamping the delta to the post-call
 * counter (so a call that was rolled back does not over-count). The
 * most common pattern is to pass the `currentSpend` from the RPC
 * return value minus the previous snapshot.
 */
export function notifyApiCallDelta(
  runId: string | undefined,
  deltaCost: number,
  deltaCalls: number,
): void {
  if (!runId) return;
  const cache = getRunApiSpendCache();
  const prior = cache.get(runId) ?? { apiCost: 0, apiCallsCount: 0 };
  const next: RunApiSpendSnapshot = {
    apiCost: Math.max(
      0,
      prior.apiCost + (Number.isFinite(deltaCost) ? deltaCost : 0),
    ),
    apiCallsCount: Math.max(
      0,
      prior.apiCallsCount + (Number.isFinite(deltaCalls) ? deltaCalls : 0),
    ),
  };
  cache.set(runId, next);

  // Only notify on positive deltas — a rollback should be
  // observable via the next HTTP read.
  if (deltaCost <= 0 && deltaCalls <= 0) return;

  void notifyRunApiCall(runId, next.apiCost, next.apiCallsCount).catch(
    (err) => {
      logger.warn(
        {
          err,
          event: "api_call_notify_failed",
          runId,
          apiCost: next.apiCost,
          apiCallsCount: next.apiCallsCount,
        },
        "notifyRunApiCall failed; non-fatal",
      );
    },
  );
}
