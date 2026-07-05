/**
 * Unit tests for the `extApiCost` / `extApiCallsCount` exposure on
 * `GET /api/research-brain/ingestion/runs/:id`
 * (api-cost-guard-rails PR #3, task 3.15).
 *
 * Coverage matrix:
 *   1. Run with `ext_api_cost = 2.50` and
 *      `ext_api_calls = { mistral_ocr: { calls: 5, costUsd: 2.50,
 *      units: 50 } }` → response includes
 *      `extApiCost: 2.50, extApiCallsCount: 5` and the existing
 *      `llmCost` field is unchanged.
 *   2. Multiple providers in `ext_api_calls` → counts sum across
 *      providers.
 *   3. Missing / empty `ext_api_calls` / `ext_api_cost` → zeros,
 *      not nulls.
 *
 * The test mocks the Supabase service client and uses a real
 * admin-JWT so the route's `authResolver({ role: 'admin' })` guard
 * passes. Non-admin callers are not in scope here — the auth
 * surface is exercised in
 * `cost-totals.test.ts` and the compound-authority routes test.
 */

process.env.AUTH_MODE = "jwt";
process.env.BIOAGENTS_SECRET =
  process.env.BIOAGENTS_SECRET || "test-jwt-secret-for-ext-api-cost-tests";

import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock infrastructure — same chainable stub as the compound-authority
// route tests. `select("*").eq().single()` is the call shape used
// by the route under test.
// ---------------------------------------------------------------------------

type Terminal =
  | { kind: "single"; data: unknown; error: unknown }
  | { kind: "many"; data: unknown[]; error: unknown };

const BUILDER_METHODS = [
  "from",
  "select",
  "eq",
  "neq",
  "in",
  "gte",
  "lte",
  "order",
  "limit",
];
const TERMINAL_METHODS = ["maybeSingle", "single"];

function scriptedMock(script: Terminal[]) {
  const calls: { method: string; args: unknown[] }[] = [];
  let cursor = 0;
  const target: any = {};
  for (const method of BUILDER_METHODS) {
    target[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return target;
    };
  }
  for (const method of TERMINAL_METHODS) {
    target[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      const t = script[cursor++];
      if (!t) {
        return Promise.resolve({ data: null, error: null });
      }
      const data = t.kind === "single" ? t.data : t.data;
      const error = t.error;
      return Promise.resolve({ data, error });
    };
  }
  Object.defineProperty(target, "then", {
    get() {
      return (onFulfilled: any, onRejected: any) => {
        calls.push({ method: "then", args: [] });
        const t = script[cursor++];
        const data = t?.kind === "single" ? t.data : t?.data;
        const error = t?.error;
        return Promise.resolve({ data, error }).then(onFulfilled, onRejected);
      };
    },
  });
  return { client: target, calls };
}

declare global {
  // eslint-disable-next-line no-var
  var __extApiCostTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__extApiCostTestClient = factory;
}

mock.module("../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__extApiCostTestClient ?? (() => null))(),
  getAnonClient: () => (globalThis.__extApiCostTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__extApiCostTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () => (globalThis.__extApiCostTestClient ?? (() => null))(),
}));

// SUT imports (post-mock).
import { researchBrainRoute } from "../research-brain";
import { generateTestJWT } from "../../services/jwt";

let adminToken: string;

beforeAll(async () => {
  adminToken = await generateTestJWT({
    sub: "00000000-0000-0000-0000-0000000000a1",
    role: "admin",
  });
});

beforeEach(() => {
  setMockServiceClient(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const RUN_ID = "00000000-0000-0000-0000-0000000000r1";

function buildRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    docs_path: "/corpus",
    status: "completed",
    total_files: 5,
    processed_files: 5,
    skipped_files: 0,
    failed_files: 0,
    llm_cost: "0.75",
    llm_calls: [{}, {}, {}], // 3 entries → llmCallsCount = 3
    started_at: "2026-06-14T00:00:00Z",
    finished_at: "2026-06-14T00:30:00Z",
    cancelled_at: null,
    // ext_api_* fields are the PR #3 additions; default to missing
    // so the test can verify the zero-fallback path.
    ext_api_cost: null,
    ext_api_calls: null,
    ...overrides,
  };
}

async function getRun(mockedRun: Record<string, unknown>) {
  const { client } = scriptedMock([
    { kind: "single", data: mockedRun, error: null },
  ]);
  setMockServiceClient(() => client);
  return await researchBrainRoute.handle(
    new Request(`http://test/api/research-brain/ingestion/runs/${RUN_ID}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${adminToken}` },
    }),
  );
}

describe("research-brain ingestion runs/:id — extApiCost surface (PR #3 task 3.15)", () => {
  it("returns extApiCost=2.50 and extApiCallsCount=5 with mistral_ocr entries, llmCost preserved", async () => {
    const res = await getRun(
      buildRun({
        ext_api_cost: "2.50",
        ext_api_calls: {
          mistral_ocr: { calls: 5, costUsd: 2.5, units: 50 },
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      extApiCost: number;
      extApiCallsCount: number;
      llmCost: number;
      llmCallsCount: number;
    };
    expect(body.extApiCost).toBe(2.5);
    expect(body.extApiCallsCount).toBe(5);
    // Existing llmCost/llmCallsCount are unchanged.
    expect(body.llmCost).toBe(0.75);
    expect(body.llmCallsCount).toBe(3);
  });

  it("sums calls across multiple providers (mistral_ocr + pubchem)", async () => {
    const res = await getRun(
      buildRun({
        ext_api_cost: "4.20",
        ext_api_calls: {
          mistral_ocr: { calls: 5, costUsd: 2.5, units: 50 },
          pubchem: { calls: 17, costUsd: 0, units: 17 },
        },
      }),
    );
    const body = (await res.json()) as {
      extApiCost: number;
      extApiCallsCount: number;
    };
    expect(body.extApiCost).toBe(4.2);
    // 5 (mistral) + 17 (pubchem) = 22
    expect(body.extApiCallsCount).toBe(22);
  });

  it("missing ext_api_cost / ext_api_calls fall back to zero (not null)", async () => {
    const res = await getRun(buildRun());
    const body = (await res.json()) as {
      extApiCost: number;
      extApiCallsCount: number;
    };
    expect(body.extApiCost).toBe(0);
    expect(body.extApiCallsCount).toBe(0);
  });
});
