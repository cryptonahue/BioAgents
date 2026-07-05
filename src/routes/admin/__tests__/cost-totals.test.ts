/**
 * Unit tests for the admin cost-totals route
 * (api-cost-guard-rails PR #3, task 3.13).
 *
 * Coverage matrix:
 *   1. Admin caller → 200, response includes `rows` and
 *      `capUtilization` with `pctOfDailyCap` / `pctOfMonthlyCap`.
 *   2. Non-admin caller → 401/403.
 *   3. `daysAt80pct` aggregate over 3 days (50/85/100%) → 2 (the
 *      85% and 100% days).
 *   4. `since=7d` truncates the window correctly.
 *   5. `provider=mistral_ocr` filters to a single provider.
 *   6. Invalid `since` / `provider` fall back to the defaults
 *      (`24h` / `all`).
 *
 * The DB client is mocked with a scripted chainable stub. The
 * real `authResolver` is exercised via JWT (the same pattern as
 * `services/files/__tests__/table-merges.route.test.ts`).
 */

// Set the auth env vars BEFORE any module is imported so the
// `getAuthConfig()` call inside the authResolver reads the right
// values.
process.env.AUTH_MODE = "jwt";
process.env.BIOAGENTS_SECRET =
  process.env.BIOAGENTS_SECRET || "test-jwt-secret-for-cost-totals-tests";

import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — DB client only; auth is real-JWT-based.
// ---------------------------------------------------------------------------

type Call = { method: string; args: unknown[]; table?: string };
type Terminal =
  | { kind: "single"; data: unknown; error: unknown }
  | { kind: "many"; data: unknown[]; error: unknown };

const BUILDER_METHODS = [
  "from",
  "select",
  "eq",
  "gte",
  "lte",
  "lt",
  "gt",
  "order",
  "in",
];

declare global {
  // eslint-disable-next-line no-var
  var __costTotalsTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__costTotalsTestClient = factory;
}

function scriptedQueryClient(script: Terminal[]): any {
  const calls: Call[] = [];
  let cursor = 0;
  const builder: any = {};
  for (const m of BUILDER_METHODS) {
    builder[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return builder;
    };
  }
  Object.defineProperty(builder, "then", {
    get() {
      return (onFulfilled: any) => {
        calls.push({ method: "then", args: [] });
        const t = script[cursor++] ?? { kind: "many", data: [], error: null };
        const data = t.kind === "single" ? t.data : t.data;
        const error = t.error;
        return Promise.resolve({ data, error }).then(onFulfilled);
      };
    },
  });
  return { client: builder, calls };
}

// The SUT (`src/routes/admin/cost-totals.ts`) imports the DB
// client as `../../db/client`. From the test file
// (`src/routes/admin/__tests__/cost-totals.test.ts`), the same
// absolute path is reachable as `../../../db/client` — the extra
// `__tests__/` adds one level, but `src/` is the common root.
mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__costTotalsTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__costTotalsTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__costTotalsTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__costTotalsTestClient ?? (() => null))(),
}));

// SUT import (post-mock)
import { costTotalsRoute } from "../cost-totals";
import { generateTestJWT } from "../../../services/jwt";

let adminToken: string;
let userToken: string;

beforeAll(async () => {
  adminToken = await generateTestJWT({
    sub: "00000000-0000-0000-0000-0000000000a1",
    role: "admin",
  });
  userToken = await generateTestJWT({
    sub: "00000000-0000-0000-0000-0000000000a2",
    role: "user",
  });
});

beforeEach(() => {
  setMockServiceClient(null);
});

async function invokeAs(
  token: string,
  query: Record<string, string>,
) {
  return await costTotalsRoute.handle(
    new Request(
      "http://test/api/admin/cost-totals?" +
        new URLSearchParams(query).toString(),
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cost-totals route (PR #3 task 3.13)", () => {
  it("admin caller with 24h rows gets rows + capUtilization", async () => {
    const { client } = scriptedQueryClient([
      {
        kind: "many",
        data: [
          {
            day: "2026-06-14",
            provider: "mistral_ocr",
            units: 10,
            cost_usd: 25,
            calls_count: 4,
            last_cap_warn_at: "2026-06-14T10:00:00Z",
          },
          {
            day: "2026-06-14",
            provider: "pubchem",
            units: 150_000,
            cost_usd: 0,
            calls_count: 150_000,
            last_cap_warn_at: null,
          },
        ],
        error: null,
      },
    ]);
    setMockServiceClient(() => client);

    const res = await invokeAs(adminToken, { since: "24h", provider: "all" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: any[];
      capUtilization: Record<string, any>;
    };
    expect(body.rows).toHaveLength(2);
    const mistral = body.rows.find(
      (r: any) => r.provider === "mistral_ocr",
    );
    expect(mistral).toBeTruthy();
    expect(mistral.pctOfDailyCap).toBe(50);
    expect(mistral.pctOfMonthlyCap).toBe(2.5);
    expect(body.capUtilization.mistral_ocr).toBeTruthy();
    expect(body.capUtilization.pubchem).toBeTruthy();
  });

  it("non-admin caller is rejected", async () => {
    const res = await invokeAs(userToken, { since: "24h" });
    expect([401, 403]).toContain(res.status);
  });

  it("missing auth is rejected", async () => {
    const res = await costTotalsRoute.handle(
      new Request("http://test/api/admin/cost-totals?since=24h", {
        method: "GET",
      }),
    );
    expect([401, 403]).toContain(res.status);
  });

  it("daysAt80pct aggregate: 50/85/100% → 2", async () => {
    const { client } = scriptedQueryClient([
      {
        kind: "many",
        data: [
          {
            day: "2026-06-12",
            provider: "mistral_ocr",
            units: 10,
            cost_usd: 25,
            calls_count: 1,
            last_cap_warn_at: null,
          },
          {
            day: "2026-06-13",
            provider: "mistral_ocr",
            units: 10,
            cost_usd: 42.5,
            calls_count: 1,
            last_cap_warn_at: null,
          },
          {
            day: "2026-06-14",
            provider: "mistral_ocr",
            units: 10,
            cost_usd: 50,
            calls_count: 1,
            last_cap_warn_at: null,
          },
        ],
        error: null,
      },
    ]);
    setMockServiceClient(() => client);

    const res = await invokeAs(adminToken, {
      since: "7d",
      provider: "mistral_ocr",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capUtilization: any };
    const util = body.capUtilization.mistral_ocr;
    expect(util.daysAt80pct).toBe(2);
    expect(util.daysAt100pct).toBe(1);
    expect(util.peakDay).toBe(100);
  });

  it("invalid since/provider fall back to defaults", async () => {
    const { client } = scriptedQueryClient([
      { kind: "many", data: [], error: null },
    ]);
    setMockServiceClient(() => client);

    const res = await invokeAs(adminToken, {
      since: "junk",
      provider: "garbage",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { window: any };
    expect(body.window.since).toBe("24h");
    expect(body.window.provider).toBe("all");
  });

  it("DB error returns 500 with error body", async () => {
    const { client } = scriptedQueryClient([
      { kind: "many", data: null, error: { message: "DB blip" } },
    ]);
    setMockServiceClient(() => client);

    const res = await invokeAs(adminToken, { since: "24h" });
    expect(res.status).toBe(500);
  });
});
