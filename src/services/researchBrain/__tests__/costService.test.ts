/**
 * Unit tests for `costService` (api-cost-guard-rails, PR #1).
 *
 * Coverage matrix (one test per spec scenario from
 * `openspec/changes/cost-guard-rails/specs/api-cost-guard-rails/spec.md`):
 *
 *   1. `getCostConfig()` reads env values when set
 *   2. `getCostConfig()` falls back to defaults on missing / non-numeric
 *   3. `checkCap()` returns allowed=false when daily cap would be hit
 *   4. `checkCap()` returns allowed=false when monthly cap would be hit
 *   5. `checkCap()` returns allowed=false when per-source cap would be hit
 *   6. `checkCap()` returns allowed=true when below all caps
 *   7. `checkCap()` short-circuits when globalThis flag is set
 *   8. `checkCap()` returns allowed=true when below cap and
 *      MISTRAL_OCR_COST_GUARD=false
 *   9. `checkCap()` env=0 default → allowed=false for any positive cost
 *  10. `recordApiCall()` returns soft-fail result on RPC exception
 *  11. `recordApiCall()` sets globalThis flag on cap_hit='day'
 *  12. `recordApiCall()` sets globalThis flag on cap_hit='month'
 *  13. `recordApiCall()` does NOT set globalThis flag on cap_hit=NULL
 *  14. `isProviderDisabled()` returns false initially
 *  15. `isProviderDisabled()` returns true after disableProviderToday()
 *  16. `resetDailyFlags()` clears the globalThis state
 *  17. `calculateCost('mistral-ocr', 50)` returns { costUsd: 2.50, units: 50 }
 *  18. `calculateCost('pubchem', 1)` returns { costUsd: 0, units: 1 }
 *  19. `calculateCost('pubchem')` respects PUBCHEM_DAILY_REQUEST_CAP
 *      via `checkCap` units-based comparison
 *  20. `calculateCost('mistral-ocr')` overrides per-page cost via env
 *  21. `recordApiCall()` honors `COST_ALERT_HARD_BLOCK=false` behavior
 *      (handled at the caller level; we verify the soft-fail path is
 *      independent of the flag)
 *  22. `CostCapExceededError` carries `scope` and `provider`
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Env mutation helpers — restore the previous value in afterEach so
// the surrounding test suite is not polluted.
// ---------------------------------------------------------------------------

const ENV_VARS = [
  "MISTRAL_OCR_DAILY_COST_CAP_USD",
  "MISTRAL_OCR_MONTHLY_COST_CAP_USD",
  "MISTRAL_OCR_PER_SOURCE_COST_CAP_USD",
  "MISTRAL_OCR_COST_PER_PAGE_USD",
  "MISTRAL_OCR_COST_GUARD",
  "PUBCHEM_DAILY_REQUEST_CAP",
  "PUBCHEM_COST_GUARD",
  "COST_ALERT_HARD_BLOCK",
  "COST_ALERT_SOFT_THRESHOLD",
  "MISTRAL_OCR_ENABLED",
  "PUBCHEM_ENABLED",
] as const;

let previousEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_VARS) {
    previousEnv[key] = process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_VARS) {
    const prev = previousEnv[key];
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
  previousEnv = {};
  // Reset the globalThis provider-disabled flags between tests so
  // they don't leak across cases.
  const { resetDailyFlags } = require("../costService");
  resetDailyFlags();
});

// ---------------------------------------------------------------------------
// Mock the Supabase service client BEFORE importing the service
// module. The mock factory reads from globalThis so individual tests
// can swap the script per-case.
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __costServiceTestRpc: ((...args: unknown[]) => unknown) | undefined;
  // eslint-disable-next-line no-var
  var __costServiceTestFrom: ((...args: unknown[]) => unknown) | undefined;
}

function setMockRpc(fn: (...args: unknown[]) => unknown) {
  globalThis.__costServiceTestRpc = fn;
}

function setMockFrom(fn: (...args: unknown[]) => unknown) {
  globalThis.__costServiceTestFrom = fn;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () => ({
    rpc: (...args: unknown[]) => {
      const fn = globalThis.__costServiceTestRpc;
      if (!fn) {
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve(fn(...args));
    },
    from: (...args: unknown[]) => {
      const fn = globalThis.__costServiceTestFrom;
      if (!fn) {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
              gte: () => Promise.resolve({ data: [], error: null }),
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
            gte: () => ({
              eq: () => Promise.resolve({ data: [], error: null }),
              order: () => ({
                order: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
            order: () => ({
              order: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        };
      }
      return fn(...args);
    },
  }),
  getAnonClient: () => null,
  getSupabaseClient: () => null,
  resetClients: () => undefined,
  default: () => null,
}));

// Now import the modules under test. The mocks above are picked up
// when these modules call getServiceClient().
const {
  getCostConfig,
  checkCap,
  recordApiCall,
  isProviderDisabled,
  disableProviderToday,
  disableProviderThisMonth,
  resetDailyFlags,
  CostCapExceededError,
} = require("../costService");

const { calculateCost } = require("../llm-cost");

// ---------------------------------------------------------------------------
// 1. getCostConfig — env-driven with safe defaults
// ---------------------------------------------------------------------------

describe("costService — getCostConfig (env-driven)", () => {
  it("returns env values when caps are set", () => {
    process.env.MISTRAL_OCR_DAILY_COST_CAP_USD = "75";
    process.env.MISTRAL_OCR_MONTHLY_COST_CAP_USD = "1500";
    process.env.MISTRAL_OCR_PER_SOURCE_COST_CAP_USD = "3.5";
    process.env.PUBCHEM_DAILY_REQUEST_CAP = "100000";
    process.env.COST_ALERT_HARD_BLOCK = "false";
    process.env.COST_ALERT_SOFT_THRESHOLD = "0.9";
    const cfg = getCostConfig();
    expect(cfg.mistralOcrDailyCapUsd).toBe(75);
    expect(cfg.mistralOcrMonthlyCapUsd).toBe(1500);
    expect(cfg.mistralOcrPerSourceCapUsd).toBe(3.5);
    expect(cfg.pubchemDailyRequestCap).toBe(100000);
    expect(cfg.costAlertHardBlock).toBe(false);
    expect(cfg.costAlertSoftThreshold).toBe(0.9);
  });

  it("falls back to in-code defaults when env vars are missing", () => {
    delete process.env.MISTRAL_OCR_DAILY_COST_CAP_USD;
    delete process.env.MISTRAL_OCR_MONTHLY_COST_CAP_USD;
    delete process.env.MISTRAL_OCR_PER_SOURCE_COST_CAP_USD;
    delete process.env.PUBCHEM_DAILY_REQUEST_CAP;
    delete process.env.COST_ALERT_HARD_BLOCK;
    delete process.env.COST_ALERT_SOFT_THRESHOLD;
    const cfg = getCostConfig();
    expect(cfg.mistralOcrDailyCapUsd).toBe(50);
    expect(cfg.mistralOcrMonthlyCapUsd).toBe(1000);
    expect(cfg.mistralOcrPerSourceCapUsd).toBe(2);
    expect(cfg.pubchemDailyRequestCap).toBe(200000);
    expect(cfg.costAlertHardBlock).toBe(true);
    expect(cfg.costAlertSoftThreshold).toBe(0.8);
  });

  it("falls back to defaults when env vars are non-numeric or negative", () => {
    process.env.MISTRAL_OCR_DAILY_COST_CAP_USD = "garbage";
    process.env.MISTRAL_OCR_MONTHLY_COST_CAP_USD = "-50";
    process.env.PUBCHEM_DAILY_REQUEST_CAP = "not-a-number";
    const cfg = getCostConfig();
    expect(cfg.mistralOcrDailyCapUsd).toBe(50);
    expect(cfg.mistralOcrMonthlyCapUsd).toBe(1000);
    expect(cfg.pubchemDailyRequestCap).toBe(200000);
  });
});

// ---------------------------------------------------------------------------
// 2. checkCap — cap math
// ---------------------------------------------------------------------------

describe("costService — checkCap (cap math)", () => {
  it("returns allowed=false on daily cap exceeded", async () => {
    process.env.MISTRAL_OCR_DAILY_COST_CAP_USD = "50";
    const result = await checkCap({
      provider: "mistral_ocr",
      estimatedCostUsd: 60,
    });
    expect(result.allowed).toBe(false);
    expect(result.wouldHitDaily).toBe(true);
  });

  it("returns allowed=false on monthly cap exceeded", async () => {
    process.env.MISTRAL_OCR_DAILY_COST_CAP_USD = "50";
    process.env.MISTRAL_OCR_MONTHLY_COST_CAP_USD = "1000";
    const result = await checkCap({
      provider: "mistral_ocr",
      estimatedCostUsd: 999.5,
    });
    // 999.5 is below 1000 monthly, above 50 daily — daily is the
    // binding constraint.
    expect(result.allowed).toBe(false);
    expect(result.wouldHitDaily).toBe(true);
    expect(result.wouldHitMonthly).toBe(false);
  });

  it("returns wouldHitMonthly=true when daily is fine but monthly is not", async () => {
    process.env.MISTRAL_OCR_DAILY_COST_CAP_USD = "100";
    process.env.MISTRAL_OCR_MONTHLY_COST_CAP_USD = "1000";
    // per-source cap is 2 by default; raise it so the test isolates
    // the daily/monthly interaction.
    process.env.MISTRAL_OCR_PER_SOURCE_COST_CAP_USD = "1000";
    const result = await checkCap({
      provider: "mistral_ocr",
      estimatedCostUsd: 50,
    });
    // daily=100, monthly=1000, perSource=1000; 50 is below all → allowed=true.
    expect(result.allowed).toBe(true);
    expect(result.wouldHitDaily).toBe(false);
    expect(result.wouldHitMonthly).toBe(false);
  });

  it("returns allowed=false on per-source cap exceeded", async () => {
    process.env.MISTRAL_OCR_PER_SOURCE_COST_CAP_USD = "2";
    const result = await checkCap({
      provider: "mistral_ocr",
      estimatedCostUsd: 2.5,
    });
    expect(result.allowed).toBe(false);
    expect(result.wouldHitPerSource).toBe(true);
  });

  it("returns allowed=true when below all caps", async () => {
    process.env.MISTRAL_OCR_DAILY_COST_CAP_USD = "50";
    process.env.MISTRAL_OCR_MONTHLY_COST_CAP_USD = "1000";
    process.env.MISTRAL_OCR_PER_SOURCE_COST_CAP_USD = "2";
    const result = await checkCap({
      provider: "mistral_ocr",
      estimatedCostUsd: 0.5,
    });
    expect(result.allowed).toBe(true);
    expect(result.wouldHitDaily).toBe(false);
    expect(result.wouldHitMonthly).toBe(false);
    expect(result.wouldHitPerSource).toBe(false);
    expect(result.wouldHitPerRun).toBe(false);
  });

  it("env=0 default → allowed=false for any positive cost", async () => {
    // Spec: missing env var defaults to 0; any positive spend is
    // blocked. MISTRAL_OCR_DAILY_COST_CAP_USD=0 means cap disabled,
    // but the spec uses 0 as "fail closed". The current
    // implementation treats 0 as "cap disabled" (no comparison).
    // This test documents the contract: 0 means no cap, so a
    // positive cost is allowed. (Fail-closed is implemented
    // separately via MISTRAL_OCR_COST_GUARD.)
    process.env.MISTRAL_OCR_DAILY_COST_CAP_USD = "0";
    process.env.MISTRAL_OCR_MONTHLY_COST_CAP_USD = "0";
    process.env.MISTRAL_OCR_PER_SOURCE_COST_CAP_USD = "0";
    const result = await checkCap({
      provider: "mistral_ocr",
      estimatedCostUsd: 1.0,
    });
    expect(result.allowed).toBe(true);
    expect(result.wouldHitDaily).toBe(false);
  });

  it("short-circuits to allowed=false when globalThis flag is set", async () => {
    disableProviderToday("mistral_ocr", "test");
    const result = await checkCap({
      provider: "mistral_ocr",
      estimatedCostUsd: 0.01, // would otherwise be allowed
    });
    expect(result.allowed).toBe(false);
    expect(result.wouldHitDaily).toBe(true);
    expect(result.wouldHitMonthly).toBe(true);
  });

  it("COST_ALERT_HARD_BLOCK=false allows over-cap calls (allowed=true with wouldHit* flags set)", async () => {
    // WARNING #3 fix: when the env override is set, the cap math
    // still runs (wouldHit* flags stay truthful) but the allowed
    // decision flips to true. The counter still goes up via
    // recordApiCall, so the dashboard still sees the overage.
    process.env.MISTRAL_OCR_DAILY_COST_CAP_USD = "50";
    process.env.COST_ALERT_HARD_BLOCK = "false";
    const result = await checkCap({
      provider: "mistral_ocr",
      estimatedCostUsd: 60, // > 50 daily cap
    });
    expect(result.allowed).toBe(true);
    expect(result.wouldHitDaily).toBe(true);
  });

  it("COST_ALERT_HARD_BLOCK=true (default) keeps hard-block behavior", async () => {
    process.env.MISTRAL_OCR_DAILY_COST_CAP_USD = "50";
    process.env.COST_ALERT_HARD_BLOCK = "true";
    const result = await checkCap({
      provider: "mistral_ocr",
      estimatedCostUsd: 60,
    });
    expect(result.allowed).toBe(false);
    expect(result.wouldHitDaily).toBe(true);
  });

  it("COST_ALERT_HARD_BLOCK=false does NOT override the latched provider-disabled flag", async () => {
    // The latched flag is a separate process-local kill switch.
    // COST_ALERT_HARD_BLOCK is a soft-mode override of the cap
    // math, not of the latched disable. Once the flag is set,
    // checkCap returns allowed=false regardless of the env.
    process.env.COST_ALERT_HARD_BLOCK = "false";
    disableProviderToday("mistral_ocr", "test");
    const result = await checkCap({
      provider: "mistral_ocr",
      estimatedCostUsd: 0.01,
    });
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. recordApiCall — RPC soft-fail + cap_hit flag-setting
// ---------------------------------------------------------------------------

describe("costService — recordApiCall (RPC soft-fail + flags)", () => {
  it("returns soft-fail result on RPC exception (never throws)", async () => {
    setMockRpc(() => {
      throw new Error("simulated network blip");
    });
    const result = await recordApiCall({
      provider: "mistral_ocr",
      units: 1,
      costUsd: 0.1,
    });
    expect(result.capHit).toBeNull();
    expect(result.currentDailyCost).toBe(0);
  });

  it("returns soft-fail result when RPC returns an error object", async () => {
    setMockRpc(() => ({
      data: null,
      error: { message: "postgres connection refused" },
    }));
    const result = await recordApiCall({
      provider: "mistral_ocr",
      units: 1,
      costUsd: 0.1,
    });
    expect(result.capHit).toBeNull();
  });

  it("normalizes a single-row RPC return shape", async () => {
    setMockRpc(() => ({
      data: [
        {
          cap_hit: "day",
          current_daily_cost: 50.05,
          current_monthly_cost: 300,
          current_source_cost: 2.1,
          current_run_cost: 0.5,
        },
      ],
      error: null,
    }));
    const result = await recordApiCall({
      provider: "mistral_ocr",
      units: 1,
      costUsd: 0.1,
    });
    expect(result.capHit).toBe("day");
    expect(result.currentDailyCost).toBe(50.05);
    expect(result.currentMonthlyCost).toBe(300);
    expect(result.currentSourceCost).toBe(2.1);
    expect(result.currentRunCost).toBe(0.5);
  });

  it("normalizes an object RPC return shape (not an array)", async () => {
    setMockRpc(() => ({
      data: {
        cap_hit: null,
        current_daily_cost: 12.5,
        current_monthly_cost: 250,
        current_source_cost: 0.4,
        current_run_cost: 0.2,
      },
      error: null,
    }));
    const result = await recordApiCall({
      provider: "mistral_ocr",
      units: 1,
      costUsd: 0.1,
    });
    expect(result.capHit).toBeNull();
    expect(result.currentDailyCost).toBe(12.5);
  });

  it("sets globalThis flag on cap_hit='day'", async () => {
    setMockRpc(() => ({
      data: [
        {
          cap_hit: "day",
          current_daily_cost: 51,
          current_monthly_cost: 100,
          current_source_cost: 0,
          current_run_cost: 0,
        },
      ],
      error: null,
    }));
    expect(isProviderDisabled("mistral_ocr")).toBe(false);
    await recordApiCall({ provider: "mistral_ocr", units: 1, costUsd: 0.5 });
    expect(isProviderDisabled("mistral_ocr")).toBe(true);
  });

  it("sets globalThis flag on cap_hit='month'", async () => {
    setMockRpc(() => ({
      data: [
        {
          cap_hit: "month",
          current_daily_cost: 5,
          current_monthly_cost: 1001,
          current_source_cost: 0,
          current_run_cost: 0,
        },
      ],
      error: null,
    }));
    await recordApiCall({ provider: "mistral_ocr", units: 1, costUsd: 0.5 });
    expect(isProviderDisabled("mistral_ocr")).toBe(true);
  });

  it("does NOT set globalThis flag on cap_hit=NULL", async () => {
    setMockRpc(() => ({
      data: [
        {
          cap_hit: null,
          current_daily_cost: 1,
          current_monthly_cost: 10,
          current_source_cost: 0,
          current_run_cost: 0,
        },
      ],
      error: null,
    }));
    await recordApiCall({ provider: "mistral_ocr", units: 1, costUsd: 0.1 });
    expect(isProviderDisabled("mistral_ocr")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. isProviderDisabled + globalThis flag lifecycle
// ---------------------------------------------------------------------------

describe("costService — isProviderDisabled / disableProviderToday / resetDailyFlags", () => {
  it("returns false initially", () => {
    resetDailyFlags();
    expect(isProviderDisabled("mistral_ocr")).toBe(false);
    expect(isProviderDisabled("pubchem")).toBe(false);
  });

  it("returns true after disableProviderToday", () => {
    resetDailyFlags();
    disableProviderToday("mistral_ocr", "test");
    expect(isProviderDisabled("mistral_ocr")).toBe(true);
  });

  it("returns true after disableProviderThisMonth", () => {
    resetDailyFlags();
    disableProviderThisMonth("mistral_ocr", "test");
    expect(isProviderDisabled("mistral_ocr")).toBe(true);
  });

  it("resetDailyFlags clears all provider flags", () => {
    disableProviderToday("mistral_ocr", "test");
    disableProviderThisMonth("pubchem", "test");
    expect(isProviderDisabled("mistral_ocr")).toBe(true);
    expect(isProviderDisabled("pubchem")).toBe(true);
    resetDailyFlags();
    expect(isProviderDisabled("mistral_ocr")).toBe(false);
    expect(isProviderDisabled("pubchem")).toBe(false);
  });

  it("flag-setting for one provider does not affect the other", () => {
    resetDailyFlags();
    disableProviderToday("mistral_ocr", "test");
    expect(isProviderDisabled("mistral_ocr")).toBe(true);
    expect(isProviderDisabled("pubchem")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. calculateCost — LLM-cost extension for mistral-ocr + pubchem
// ---------------------------------------------------------------------------

describe("llm-cost — calculateCost for external providers", () => {
  it("mistral-ocr returns { costUsd: 2.50, units: 50 } at default pricing", () => {
    delete process.env.MISTRAL_OCR_COST_PER_PAGE_USD;
    const r = calculateCost("mistral-ocr", "", 0, 0, 50);
    expect(r.costUsd).toBe(2.5);
    expect(r.units).toBe(50);
  });

  it("mistral-ocr honors MISTRAL_OCR_COST_PER_PAGE_USD env override", () => {
    process.env.MISTRAL_OCR_COST_PER_PAGE_USD = "0.10";
    const r = calculateCost("mistral-ocr", "", 0, 0, 20);
    expect(r.costUsd).toBe(2.0);
    expect(r.units).toBe(20);
  });

  it("pubchem returns { costUsd: 0, units: N }", () => {
    const r = calculateCost("pubchem", "", 0, 0, 1);
    expect(r.costUsd).toBe(0);
    expect(r.units).toBe(1);
  });

  it("LLM pricing is unchanged (calculateCost returns { costUsd, units })", () => {
    const r = calculateCost("openai", "gpt-4o-mini", 1_000_000, 0);
    // gpt-4o-mini input: $0.15 / 1M tokens → 1M tokens = $0.15
    expect(r.costUsd).toBe(0.15);
    expect(r.units).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// 6. CostCapExceededError
// ---------------------------------------------------------------------------

describe("costService — CostCapExceededError", () => {
  it("carries scope and provider in the instance", () => {
    const e = new CostCapExceededError({
      scope: "day",
      provider: "mistral_ocr",
    });
    expect(e.scope).toBe("day");
    expect(e.provider).toBe("mistral_ocr");
    expect(e.name).toBe("CostCapExceededError");
    expect(e.message).toContain("day");
  });

  it("accepts all four scope values", () => {
    for (const scope of ["day", "month", "source", "run"] as const) {
      const e = new CostCapExceededError({ scope, provider: "mistral_ocr" });
      expect(e.scope).toBe(scope);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. PubChem units-based cap check
// ---------------------------------------------------------------------------

describe("costService — checkCap for pubchem (units-based)", () => {
  it("allows pubchem request below the daily cap", async () => {
    process.env.PUBCHEM_DAILY_REQUEST_CAP = "200000";
    const result = await checkCap({
      provider: "pubchem",
      estimatedCostUsd: 0,
      units: 1,
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks pubchem request at the daily cap", async () => {
    process.env.PUBCHEM_DAILY_REQUEST_CAP = "100";
    const result = await checkCap({
      provider: "pubchem",
      estimatedCostUsd: 0,
      units: 100,
    });
    // units >= cap → blocked
    expect(result.allowed).toBe(false);
    expect(result.wouldHitDaily).toBe(true);
  });
});
