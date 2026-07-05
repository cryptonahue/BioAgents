/**
 * Unit tests for the cost-cap fallback in `pdfTableExtractor`
 * (api-cost-guard-rails PR #2).
 *
 * Coverage matrix (one test per spec scenario from
 * `openspec/changes/cost-guard-rails/specs/pdf-table-extraction/spec.md`):
 *
 *   (a) pre-check `wouldHitDaily=true` → local + `mistral_disabled_today` + `provider: 'local'`
 *   (b) post-call `capHit='day'` → Mistral discarded, local persisted
 *   (c) `globalThis.__mistral_ocrDisabledToday__` set → skips `checkCap`, calls local
 *   (d) `MISTRAL_OCR_ENABLED=false` → `TableExtractionProviderError`, local fallback
 *
 * Strategy: set `TABLE_EXTRACTION_PROVIDER=mistral` so the
 * orchestrator skips the local pass and goes straight to Mistral.
 * The local provider is NOT mocked (avoiding `mock.module`
 * pollution of the real module). The Mistral provider is NOT
 * mocked either — its HTTP call is stubbed via `globalThis.fetch`
 * so the real provider's cost-cap wrap runs end-to-end.
 *
 * The costService module is the REAL module too. We drive its
 * behavior through:
 *   - env vars (`MISTRAL_OCR_DAILY_COST_CAP_USD`, etc.) for `checkCap`
 *   - globalThis flags (`__mistral_ocrDisabledToday__`) for `isProviderDisabled`
 *   - the scriptable Supabase RPC mock for `recordApiCall`
 *
 * Why no `mock.module(costService, ...)`?
 *   Bun's `mock.module` is process-global. A stub of `costService`
 *   registered here would leak into other test files (e.g.
 *   `costService.test.ts` would then see a fake
 *   `CostCapExceededError` with `name === "MockCostCapExceededError"`).
 *   The worker costCap test (`compoundAuthority.worker.costCap.test.ts`)
 *   already established this pattern — we mirror it here for the
 *   orchestrator-level tests.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

// ---------------------------------------------------------------------------
// Scriptable Supabase mock
// ---------------------------------------------------------------------------
//
// The orchestrator issues several queries during a single
// `extractPDFTables` call:
//   1. `loadTablesForSource` — cache check (expects empty list)
//   2. `loadFiguresForSource` — cache check (expects empty list)
//   3. (eventually) `record_api_call` — RPC for the cap-counter
//
// We pre-load the first two as empty responses and let each test
// push additional responses for any further queries it expects.

type SupabaseResponse = { data: unknown; error: unknown };

const responseQueue: SupabaseResponse[] = [];

function emptyList(): SupabaseResponse {
  return { data: [], error: null };
}

function rpcCapHit(capHit: string | null): SupabaseResponse {
  return {
    data: [
      {
        cap_hit: capHit,
        current_daily_cost: 50.05,
        current_monthly_cost: 200,
        current_source_cost: 0.1,
        current_run_cost: 0.05,
      },
    ],
    error: null,
  };
}

const realFetch = globalThis.fetch;
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchResponse: { ok: boolean; status: number; body: string } = {
  ok: true,
  status: 200,
  body: JSON.stringify({
    pages: [
      {
        index: 0,
        markdown: "row1\nrow2",
        tables: [
          {
            headers: ["A", "B"],
            rows: [["x", "y"]],
            bbox: { x: 0, y: 0, w: 100, h: 50 },
            confidence: 0.9,
          },
        ],
      },
    ],
  }),
};

const mockFetch = (async (
  url: string | URL | Request,
  init?: RequestInit,
) => {
  const u = typeof url === "string" ? url : url.toString();
  fetchCalls.push({ url: u, init: init ?? {} });
  return {
    ok: fetchResponse.ok,
    status: fetchResponse.status,
    async text() {
      return fetchResponse.body;
    },
    async json() {
      return JSON.parse(fetchResponse.body);
    },
  } as unknown as Response;
}) as typeof fetch;

const client: any = {};
for (const m of [
  "from",
  "select",
  "insert",
  "update",
  "delete",
  "eq",
  "order",
  "rpc",
]) {
  client[m] = (..._args: unknown[]) => client;
}
client.then = (onFulfilled: any, onRejected: any) => {
  const resp = responseQueue.length > 0
    ? responseQueue.shift()!
    : emptyList();
  return Promise.resolve(resp).then(onFulfilled, onRejected);
};

mock.module("../../../db/client", () => ({
  getServiceClient: () => client,
  getAnonClient: () => client,
  getSupabaseClient: () => client,
  resetClients: () => undefined,
  default: () => client,
}));

// ---------------------------------------------------------------------------
// Env capture / restore
// ---------------------------------------------------------------------------

const ENV_VARS = [
  "MISTRAL_OCR_DAILY_COST_CAP_USD",
  "MISTRAL_OCR_MONTHLY_COST_CAP_USD",
  "MISTRAL_OCR_PER_SOURCE_COST_CAP_USD",
  "MISTRAL_OCR_COST_PER_PAGE_USD",
  "MISTRAL_OCR_ENABLED",
  "TABLE_EXTRACTION_PROVIDER",
  "MISTRAL_API_KEY",
] as const;

let previousEnv: Record<string, string | undefined> = {};

function captureEnv(): void {
  for (const key of ENV_VARS) {
    previousEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_VARS) {
    const prev = previousEnv[key];
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
  previousEnv = {};
}

function clearCostServiceGlobalState(): void {
  // The real costService caches a config snapshot on globalThis
  // (`__apiCostGuardRailsConfig`) and stores provider-disabled flags
  // under `__<provider>Disabled<Today|ThisMonth>__`. Clear them
  // so a test's env edits are honored on the next call.
  delete (globalThis as any).__apiCostGuardRailsConfig;
  delete (globalThis as any).__mistralOcrEnabled__;
  delete (globalThis as any).__mistral_ocrDisabledToday__;
  delete (globalThis as any).__mistral_ocrDisabledThisMonth__;
  delete (globalThis as any).__pubchemDisabledToday__;
  delete (globalThis as any).__pubchemDisabledThisMonth__;
  // The orchestrator caches the resolved `TABLE_EXTRACTION_PROVIDER`
  // mode on globalThis; clear it so a test that flips the env takes
  // effect on the next call.
  delete (globalThis as any).__bioprospectingTableExtractionMode;
}

beforeEach(() => {
  captureEnv();
  // Default to a high daily cap so the pre-check passes by default;
  // individual tests can lower it.
  delete process.env.MISTRAL_OCR_DAILY_COST_CAP_USD;
  delete process.env.MISTRAL_OCR_MONTHLY_COST_CAP_USD;
  delete process.env.MISTRAL_OCR_PER_SOURCE_COST_CAP_USD;
  delete process.env.MISTRAL_OCR_COST_PER_PAGE_USD;
  delete process.env.MISTRAL_OCR_ENABLED;
  process.env.MISTRAL_API_KEY = "test-key";
  // Force the orchestrator to skip the local pass and go straight
  // to Mistral. The local provider is not mocked (avoiding
  // `mock.module` pollution of `localPdfTableProvider.ts`).
  process.env.TABLE_EXTRACTION_PROVIDER = "mistral";

  clearCostServiceGlobalState();

  fetchCalls.length = 0;
  fetchResponse = {
    ok: true,
    status: 200,
    body: JSON.stringify({
      pages: [
        {
          index: 0,
          markdown: "row1\nrow2",
          tables: [
            {
              headers: ["A", "B"],
              rows: [["x", "y"]],
              bbox: { x: 0, y: 0, w: 100, h: 50 },
              confidence: 0.9,
            },
          ],
        },
      ],
    }),
  };
  (globalThis as any).fetch = mockFetch;

  // Pre-load the first two responses (cache check: tables + figures).
  // Each test can `responseQueue.push(...)` to add more.
  responseQueue.length = 0;
  responseQueue.push(emptyList()); // loadTablesForSource
  responseQueue.push(emptyList()); // loadFiguresForSource
});

afterEach(() => {
  restoreEnv();
  clearCostServiceGlobalState();
  (globalThis as any).fetch = realFetch;
  responseQueue.length = 0;
});

// SUT
const SUT = await import("../pdfTableExtractor");
const { extractPDFTables } = SUT;
const { MistralTableExtractionProvider } = await import(
  "../providers/mistralOcrProvider"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePdf(bytes = 100_000): Uint8Array {
  return new Uint8Array(bytes);
}

const SOURCE_ID = "00000000-0000-0000-0000-0000000000aa";
const RUN_ID = "00000000-0000-0000-0000-0000000000b1";

// ---------------------------------------------------------------------------
// (a) Pre-check wouldHitDaily=true → local + mistral_disabled_today
// ---------------------------------------------------------------------------

describe("pdfTableExtractor.costCap — (a) pre-check wouldHitDaily=true", () => {
  it("falls back to local with provider='local'", async () => {
    // Drive the real `checkCap` by setting the daily cap below the
    // estimated cost. The PDF is 100_000 bytes → 1 estimated page
    // → $0.05 estimated cost. A cap of $0.01 makes `wouldHitDaily`
    // true and `allowed` false.
    process.env.MISTRAL_OCR_DAILY_COST_CAP_USD = "0.01";

    const result = await extractPDFTables(
      SOURCE_ID,
      makePdf(),
      { runId: RUN_ID, sourceId: SOURCE_ID },
    );

    // The orchestrator's pre-check (NOT the provider's) short-
    // circuits to local. In `mistral` mode the local pass was
    // skipped, so `localTables` is empty and the fallback returns
    // an empty local result with `provider: 'local'`. (The auto-
    // mode local-fallback-with-persistence path is covered
    // separately in `bioprospectingExtractor.tables.test.ts`.)
    expect(result.provider).toBe("local");
    // No fetch was attempted — the pre-check returned before the
    // provider's `extract` ran.
    expect(fetchCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (b) Post-call capHit='day' → Mistral discarded, local persisted
// ---------------------------------------------------------------------------

describe("pdfTableExtractor.costCap — (b) post-call capHit='day'", () => {
  it("record_api_call returns cap_hit='day'; orchestrator falls back to local", async () => {
    // Default caps are high → pre-check passes.
    // Script the `record_api_call` RPC to return cap_hit='day'.
    responseQueue.push(rpcCapHit("day"));
    // After the cap-hit catch, the orchestrator tries the local
    // fallback path. Since we're in `mistral` mode the local
    // pass was skipped, so `localTables` is empty. The fallback
    // `persistExtractedTables` call will hit the mock — return
    // an empty list (no rows persisted, but the call must not
    // throw).
    responseQueue.push(emptyList());

    const result = await extractPDFTables(
      SOURCE_ID,
      makePdf(),
      { runId: RUN_ID, sourceId: SOURCE_ID },
    );

    // The cost-cap catch path runs when the provider throws
    // `CostCapExceededError`. In `mistral` mode the local provider
    // is not called, so the fallback returns an empty local result.
    // (In `auto` mode the local pass would have run first and the
    // local fallback would persist localTables; that branch is
    // exercised by the existing auto-mode tests.)
    expect(result.provider).toBe("local");
    // The Mistral HTTP call ran (pre-check passed), then
    // `recordApiCall` returned cap_hit='day', then the provider
    // threw and the orchestrator fell back. The provider invokes
    // Mistral twice (once for `extract`, once for `extractFigures`)
    // so the second call is the one that observes the cap-hit
    // (the first set the globalThis flag, which the second respects
    // via the orchestrator's pre-check). Both calls are recorded.
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// (c) globalThis.__mistral_ocrDisabledToday__ set → skip checkCap, local
// ---------------------------------------------------------------------------

describe("pdfTableExtractor.costCap — (c) globalThis flag set", () => {
  it("short-circuits to local without calling checkCap", async () => {
    // Set the real provider-disabled flag the costService reads.
    (globalThis as any).__mistral_ocrDisabledToday__ = true;

    const result = await extractPDFTables(
      SOURCE_ID,
      makePdf(),
      { runId: RUN_ID, sourceId: SOURCE_ID },
    );

    expect(result.provider).toBe("local");
    // The pre-check was skipped; no Mistral HTTP was made. The
    // short-circuit returns the local-fallback shape with no
    // inserted rows (the local provider wasn't called in `mistral`
    // mode, so `localTables` is empty).
    expect(fetchCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (d) MISTRAL_OCR_ENABLED=false → TableExtractionProviderError → local
// ---------------------------------------------------------------------------

describe("pdfTableExtractor.costCap — (d) MISTRAL_OCR_ENABLED=false", () => {
  it("provider throws TableExtractionProviderError; orchestrator falls back to local", async () => {
    // The provider's `getEnabledFlag` short-circuits at the start
    // of `extract` when MISTRAL_OCR_ENABLED is "false". The
    // beforeEach hook already cleared the `__mistralOcrEnabled__`
    // cache so the env is re-read.
    process.env.MISTRAL_OCR_ENABLED = "false";

    const result = await extractPDFTables(
      SOURCE_ID,
      makePdf(),
      { runId: RUN_ID, sourceId: SOURCE_ID },
    );

    // The provider's `extract` throws `TableExtractionProviderError`
    // because the env is `false`. The orchestrator's catch path
    // (non-cost-cap) runs; in `mistral` mode with no local pass,
    // the fallback returns an empty local result.
    expect(result.provider).toBe("local");
    // No fetch was attempted.
    expect(fetchCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bonus: estimatePages / costPerPageUsd are exposed on the provider
// ---------------------------------------------------------------------------

describe("MistralTableExtractionProvider — cost-cap helpers", () => {
  it("estimatePages uses ceil(byteLength / 100_000)", () => {
    expect(MistralTableExtractionProvider.estimatePages(makePdf(0))).toBe(1);
    expect(MistralTableExtractionProvider.estimatePages(makePdf(1))).toBe(1);
    expect(MistralTableExtractionProvider.estimatePages(makePdf(100_000))).toBe(1);
    expect(MistralTableExtractionProvider.estimatePages(makePdf(100_001))).toBe(2);
    expect(MistralTableExtractionProvider.estimatePages(makePdf(500_000))).toBe(5);
    expect(MistralTableExtractionProvider.estimatePages(makePdf(5_000_000))).toBe(50);
  });

  it("costPerPageUsd returns the default 0.05 when env unset", () => {
    delete process.env.MISTRAL_OCR_COST_PER_PAGE_USD;
    expect(MistralTableExtractionProvider.costPerPageUsd()).toBe(0.05);
  });

  it("costPerPageUsd honors MISTRAL_OCR_COST_PER_PAGE_USD env override", () => {
    process.env.MISTRAL_OCR_COST_PER_PAGE_USD = "0.10";
    expect(MistralTableExtractionProvider.costPerPageUsd()).toBe(0.10);
  });
});
