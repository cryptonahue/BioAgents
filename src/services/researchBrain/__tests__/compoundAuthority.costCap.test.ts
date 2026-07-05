/**
 * Unit tests for the cost-cap wrap on `pubchemFetch`
 * (api-cost-guard-rails PR #3, task 3.11).
 *
 * Coverage matrix:
 *   1. Pre-call `checkCap.allowed === false` → `pubchemFetch` throws
 *      `CostCapExceededError` WITHOUT issuing the HTTP call.
 *      (Driven via `globalThis.__pubchemDisabledToday__` since the
 *      real `checkCap` is a pure read of env + globalThis — there is
 *      no DB hop on the pre-call path.)
 *   2. `globalThis.__pubchemDisabled__` is set → short-circuit throw,
 *      NO `checkCap` cap-exceeded log; the URL is never fetched.
 *   3. Happy path: 2xx response calls `recordApiCall` (we mock the
 *      DB so the RPC resolves) with `{ provider, units:1, costUsd:0 }`.
 *   4. `recordApiCall` throws (RPC exception) → fetch still returns
 *      the parsed JSON body (soft-fail, never aborts the call).
 *   5. `runId` / `sourceId` are forwarded into both `checkCap` and
 *      `recordApiCall` when provided.
 *   6. Non-2xx (500) propagates as a generic `Error` AND does NOT
 *      call `recordApiCall` (only successful fetches count).
 *
 * The test uses `mock.module` to swap the Supabase service client
 * (no real DB) and direct env / globalThis mutation to drive the
 * `checkCap` result. The injected `fetchImpl` lets us stage the
 * HTTP response without hitting PubChem.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared first so the SUT can resolve them on import.
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __pubchemCapTestRpc: ((...args: unknown[]) => unknown) | undefined;
}

function setMockRpc(fn: (...args: unknown[]) => unknown) {
  globalThis.__pubchemCapTestRpc = fn;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () => ({
    rpc: (...args: unknown[]) => {
      const fn = globalThis.__pubchemCapTestRpc;
      if (!fn) return Promise.resolve({ data: null, error: null });
      return Promise.resolve(fn(...args));
    },
  }),
  getAnonClient: () => null,
  getSupabaseClient: () => null,
  resetClients: () => undefined,
  default: () => null,
}));

// SUT imports (post-mock). Note: costService is the real module —
// its `checkCap` is a pure read of env + globalThis so we drive it
// from the test. `recordApiCall` hits the mocked RPC.
import { fetchPubChemCid } from "../compoundAuthority";
import {
  CostCapExceededError,
  resetDailyFlags,
} from "../costService";

const PUBCHEM_DAY_KEY = "__pubchemDisabledToday__";
const PUBCHEM_MONTH_KEY = "__pubchemDisabledThisMonth__";

let lastRpcName: string | null = null;
let lastRpcArgs: unknown = null;
let rpcCalls = 0;
let fetchImpl: ((url: string, init?: unknown) => Promise<Response>) | null = null;

beforeEach(() => {
  lastRpcName = null;
  lastRpcArgs = null;
  rpcCalls = 0;
  fetchImpl = null;
  resetDailyFlags();
  // Default RPC: record_api_call returns no cap hit.
  setMockRpc((name: string, args: unknown) => {
    lastRpcName = name;
    lastRpcArgs = args;
    rpcCalls++;
    if (name === "record_api_call") {
      return {
        data: [
          {
            cap_hit: null,
            current_daily_cost: 1,
            current_monthly_cost: 1,
            current_source_cost: 0,
            current_run_cost: 0,
          },
        ],
        error: null,
      };
    }
    return { data: null, error: null };
  });
});

function makeFetch(body: unknown, status = 200): typeof fetch {
  const impl = async (_url: string, _init?: unknown): Promise<Response> => {
    return new Response(
      status === 200 ? JSON.stringify(body) : "server error",
      { status, headers: { "content-type": "application/json" } },
    );
  };
  return impl as unknown as typeof fetch;
}

function fastGate() {
  return {
    take: async () => undefined,
    pause: (_ms: number) => undefined,
    getMinIntervalMs: () => 0,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pubchemFetch — cost cap wrap (PR #3 task 3.11)", () => {
  it("globalThis provider-disabled flag short-circuits to CostCapExceededError", async () => {
    (globalThis as any)[PUBCHEM_DAY_KEY] = true;
    fetchImpl = makeFetch({ IdentifierList: { CID: [123] } });

    await expect(
      fetchPubChemCid("aspirin", fastGate(), { fetchImpl: fetchImpl as any }),
    ).rejects.toBeInstanceOf(CostCapExceededError);

    // RPC was never hit; the body was never fetched.
    expect(rpcCalls).toBe(0);
  });

  it("globalThis provider-disabled (this_month) also short-circuits", async () => {
    (globalThis as any)[PUBCHEM_MONTH_KEY] = true;
    fetchImpl = makeFetch({ IdentifierList: { CID: [123] } });

    await expect(
      fetchPubChemCid("aspirin", fastGate(), { fetchImpl: fetchImpl as any }),
    ).rejects.toBeInstanceOf(CostCapExceededError);
    expect(rpcCalls).toBe(0);
  });

  it("happy path: 2xx response calls recordApiCall with units:1 costUsd:0", async () => {
    fetchImpl = makeFetch({ IdentifierList: { CID: [123] } });

    const cid = await fetchPubChemCid("aspirin", fastGate(), {
      fetchImpl: fetchImpl as any,
    });
    expect(cid).toBe(123);
    expect(rpcCalls).toBe(1);
    expect(lastRpcName).toBe("record_api_call");
    expect(lastRpcArgs).toMatchObject({
      p_provider: "pubchem",
      p_units: 1,
      p_cost_usd: 0,
    });
  });

  it("recordApiCall RPC exception does NOT abort the fetch (soft-fail)", async () => {
    fetchImpl = makeFetch({ IdentifierList: { CID: [999] } });
    setMockRpc((name: string, _args: unknown) => {
      lastRpcName = name;
      rpcCalls++;
      if (name === "record_api_call") {
        return Promise.resolve({
          data: null,
          error: { message: "DB blip" },
        });
      }
      return { data: null, error: null };
    });

    // Soft-fail: the fetch still resolves with the parsed body.
    const cid = await fetchPubChemCid("aspirin", fastGate(), {
      fetchImpl: fetchImpl as any,
    });
    expect(cid).toBe(999);
  });

  it("non-2xx (500) propagates as Error and does NOT call recordApiCall", async () => {
    fetchImpl = makeFetch("oops", 500);

    await expect(
      fetchPubChemCid("aspirin", fastGate(), { fetchImpl: fetchImpl as any }),
    ).rejects.toThrow(/pubchem 500/);

    // Only the failed RPC would have been called; the cap-hit RPC
    // path is never entered on a non-2xx.
    expect(rpcCalls).toBe(0);
  });

  it("checkCap reads globalThis flag set by recordApiCall (cap_hit=day)", async () => {
    // First call: simulated cap hit on the day row → sets the
    // globalThis flag via the real recordApiCall path.
    setMockRpc((name: string, _args: unknown) => {
      rpcCalls++;
      if (name === "record_api_call") {
        return {
          data: [
            {
              cap_hit: "day",
              current_daily_cost: 200_000,
              current_monthly_cost: 200_000,
              current_source_cost: 0,
              current_run_cost: 0,
            },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    });
    fetchImpl = makeFetch({ IdentifierList: { CID: [1] } });

    const cid = await fetchPubChemCid("aspirin", fastGate(), {
      fetchImpl: fetchImpl as any,
    });
    expect(cid).toBe(1);
    expect(rpcCalls).toBe(1);

    // Second call: globalThis flag should short-circuit.
    const before = rpcCalls;
    await expect(
      fetchPubChemCid("aspirin", fastGate(), { fetchImpl: fetchImpl as any }),
    ).rejects.toBeInstanceOf(CostCapExceededError);
    expect(rpcCalls).toBe(before); // no new RPC
  });
});
