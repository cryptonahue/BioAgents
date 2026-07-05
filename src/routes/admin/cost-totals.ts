/**
 * Admin Cost Totals API
 *
 * `GET /api/admin/cost-totals?since=24h|7d|30d&provider=…`
 *
 * Returns per-(day, provider) totals from `daily_api_usage` joined
 * against the env-driven caps, plus aggregate `capUtilization` fields
 * (peak day, average day, days at 80%+, days at 100%). Read-only.
 *
 * Auth: `authResolver({ required: true, role: 'admin' })`. Non-admin
 * callers receive 401/403 (the resolver enforces role + presence).
 *
 * Feature: `api-cost-guard-rails` (PR #3).
 */

import { Elysia } from "elysia";
import { authResolver } from "../../middleware/authResolver";
import { getServiceClient } from "../../db/client";
import { getCostConfig } from "../../services/researchBrain/costService";
import logger from "../../utils/logger";

const VALID_SINCE = new Set(["24h", "7d", "30d"]);
const VALID_PROVIDERS = new Set(["mistral_ocr", "pubchem", "all"]);

interface DailyApiUsageRow {
  day: string;
  provider: string;
  units: number | string;
  cost_usd: number | string;
  calls_count: number | string;
  last_cap_warn_at: string | null;
}

interface CostTotalsResponseRow {
  day: string;
  provider: string;
  costUsd: number;
  units: number;
  calls: number;
  dailyCap: number;
  monthlyCap: number;
  pctOfDailyCap: number;
  pctOfMonthlyCap: number;
  lastCapWarnAt: string | null;
}

interface CapUtilization {
  peakDay: number;
  averageDay: number;
  daysAt80pct: number;
  daysAt100pct: number;
}

interface CostTotalsResponse {
  rows: CostTotalsResponseRow[];
  capUtilization: {
    mistral_ocr?: CapUtilization;
    pubchem?: CapUtilization;
  };
  window: { since: "24h" | "7d" | "30d"; provider: string; days: number };
  generatedAt: string;
}

/**
 * Days back from today for the `since` parameter. Caps at 30 to
 * match the GC window so a stale client cannot pull more history
 * than the system retains.
 */
function sinceToDays(since: string): number {
  if (since === "7d") return 7;
  if (since === "30d") return 30;
  return 1;
}

/**
 * Map a provider key to its daily / monthly caps. `pubchem` is
 * units-based (request count, not USD); we surface the same number
 * in `dailyCap` and 0 in `monthlyCap` so the JSON shape is uniform.
 */
function capsForProvider(provider: string): { daily: number; monthly: number } {
  const cfg = getCostConfig();
  if (provider === "mistral_ocr") {
    return {
      daily: cfg.mistralOcrDailyCapUsd,
      monthly: cfg.mistralOcrMonthlyCapUsd,
    };
  }
  if (provider === "pubchem") {
    return {
      daily: cfg.pubchemDailyRequestCap,
      monthly: 0,
    };
  }
  return { daily: 0, monthly: 0 };
}

/**
 * Compute cap-utilization aggregates for a single provider over the
 * queried window. Returns zeros when no rows are present.
 */
function computeUtilization(
  rows: CostTotalsResponseRow[],
  dailyCap: number,
): CapUtilization {
  if (rows.length === 0 || dailyCap <= 0) {
    return { peakDay: 0, averageDay: 0, daysAt80pct: 0, daysAt100pct: 0 };
  }
  // For pubchem the cap is units-based; for mistral_ocr the cap is
  // USD-based. `pctOfDailyCap` is already computed upstream, so
  // we can use it directly to bucket the day.
  let peak = 0;
  let totalPct = 0;
  let days80 = 0;
  let days100 = 0;
  for (const row of rows) {
    const pct = row.pctOfDailyCap;
    if (pct > peak) peak = pct;
    totalPct += pct;
    if (pct >= 80) days80++;
    if (pct >= 100) days100++;
  }
  return {
    peakDay: Number(peak.toFixed(2)),
    averageDay: Number((totalPct / rows.length).toFixed(2)),
    daysAt80pct: days80,
    daysAt100pct: days100,
  };
}

/**
 * Admin Cost Totals Route
 *
 * Mounted at `/api/admin/cost-totals` (the Elysia `app` mounts it
 * under the `/admin` prefix; see `src/index.ts`).
 */
export const costTotalsRoute = new Elysia().get(
  "/api/admin/cost-totals",
  async ({ query, set }) => {
    const sinceRaw = (query.since as string) || "24h";
    const providerRaw = (query.provider as string) || "all";

    // Defensive validation. Elysia's query parser is permissive
    // (anything string-y makes it through) so we re-validate.
    const since = VALID_SINCE.has(sinceRaw)
      ? (sinceRaw as "24h" | "7d" | "30d")
      : "24h";
    const provider = VALID_PROVIDERS.has(providerRaw) ? providerRaw : "all";
    const days = sinceToDays(since);

    try {
      const supabase = getServiceClient();
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

      let q = supabase
        .from("daily_api_usage")
        .select("day, provider, units, cost_usd, calls_count, last_cap_warn_at")
        .gte("day", cutoff)
        .order("day", { ascending: false })
        .order("provider", { ascending: true });
      if (provider !== "all") {
        q = q.eq("provider", provider);
      }

      const { data, error } = await q;
      if (error) {
        logger.warn(
          { err: error, event: "cost_totals_query_failed" },
          "cost-totals query failed",
        );
        set.status = 500;
        return { error: "Failed to query daily_api_usage" };
      }

      const rawRows = (data ?? []) as DailyApiUsageRow[];

      // Compute the per-(day, provider) rows with cap utilization
      // columns. `pctOfMonthlyCap` is the daily cost vs the rolling
      // monthly cap — a per-day ratio so the dashboard can spot a
      // single-day spike.
      const rows: CostTotalsResponseRow[] = rawRows.map((row) => {
        const caps = capsForProvider(row.provider);
        const costUsd = Number(row.cost_usd ?? 0);
        // For pubchem, the daily cap is a request count; we
        // surface the unit-count vs cap as `pctOfDailyCap` so
        // admins see the same number shape across providers.
        const ratioBase = row.provider === "pubchem"
          ? Number(row.units ?? 0)
          : costUsd;
        return {
          day: String(row.day),
          provider: String(row.provider),
          costUsd,
          units: Number(row.units ?? 0),
          calls: Number(row.calls_count ?? 0),
          dailyCap: caps.daily,
          monthlyCap: caps.monthly,
          pctOfDailyCap: caps.daily > 0
            ? Number(((ratioBase / caps.daily) * 100).toFixed(2))
            : 0,
          pctOfMonthlyCap: caps.monthly > 0
            ? Number(((costUsd / caps.monthly) * 100).toFixed(2))
            : 0,
          lastCapWarnAt: row.last_cap_warn_at ?? null,
        };
      });

      // Aggregate utilization per provider over the window.
      const capUtilization: CostTotalsResponse["capUtilization"] = {};
      const providerList = provider === "all"
        ? Array.from(new Set(rows.map((r) => r.provider)))
        : [provider];
      for (const p of providerList) {
        const subset = rows.filter((r) => r.provider === p);
        const caps = capsForProvider(p);
        capUtilization[p as "mistral_ocr" | "pubchem"] = computeUtilization(
          subset,
          caps.daily,
        );
      }

      const response: CostTotalsResponse = {
        rows,
        capUtilization,
        window: { since, provider, days },
        generatedAt: new Date().toISOString(),
      };

      logger.info(
        {
          since,
          provider,
          days,
          rowCount: rows.length,
        },
        "admin_cost_totals_fetched",
      );
      return response;
    } catch (err) {
      logger.error(
        { err, event: "cost_totals_query_failed" },
        "cost-totals query threw",
      );
      set.status = 500;
      return { error: "Failed to query daily_api_usage" };
    }
  },
  { beforeHandle: authResolver({ required: true, role: "admin" }) },
);
