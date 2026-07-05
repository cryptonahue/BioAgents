import { describe, it, expect, beforeEach, mock } from "bun:test";

/**
 * Unit tests for the `graph_top_co_occurring` SQL RPC caller in
 * `graphService.ts` (PR #1 of `bioprospecting-knowledge-graph`).
 *
 * Coverage matrix:
 *   1. The RPC is called with `{ p_compound_id, p_limit }`.
 *   2. The `limit` default is 5.
 *   3. The `limit` is clamped to `>= 1, <= 100` (negative / 0 / large).
 *   4. Empty `compoundId` returns `[]` WITHOUT calling the RPC.
 *
 * The companion test file `graphService.test.ts` exercises the
 * search-path and `refreshAggregates` soft-fail branches. The CTE
 * helpers are split into a separate file to keep the assertion
 * density per describe block manageable.
 */

// ---------------------------------------------------------------------------
// Mock infrastructure — mirrors the main graphService.test.ts
// ---------------------------------------------------------------------------

type Call = { method: string; args: unknown[]; table?: string };

function rpcMock() {
  const calls: Call[] = [];
  let rpcOverride: ((name: string, args: unknown) => unknown) | undefined;
  const target: any = {};
  target.__setRpcOverride = (fn: (name: string, args: unknown) => unknown) => {
    rpcOverride = fn;
  };
  target.rpc = (name: string, args: unknown) => {
    calls.push({ method: "rpc", args: [name, args], table: undefined });
    if (rpcOverride) return rpcOverride(name, args);
    return Promise.resolve({ data: [], error: null });
  };
  // Stub the from() chain so anything accidental that does not
  // go through RPC still resolves to a no-op.
  for (const method of [
    "from",
    "select",
    "insert",
    "update",
    "delete",
    "eq",
    "neq",
    "in",
    "or",
    "ilike",
    "order",
    "limit",
    "maybeSingle",
    "single",
  ]) {
    target[method] = () => target;
  }
  return { client: target, calls };
}

declare global {
  // eslint-disable-next-line no-var
  var __graphServiceCteTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__graphServiceCteTestClient = factory;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__graphServiceCteTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__graphServiceCteTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__graphServiceCteTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__graphServiceCteTestClient ?? (() => null))(),
}));

// SUT imports (post-mock)
import { getTopCoOccurring } from "../graphService";

let calls: Call[];
let client: any;
let rpcOverride: ((name: string, args: unknown) => unknown) | undefined;

beforeEach(() => {
  const m = rpcMock();
  calls = m.calls;
  client = m.client;
  rpcOverride = undefined;
  client.__setRpcOverride = (fn: (name: string, args: unknown) => unknown) => {
    rpcOverride = fn;
  };
  client.rpc = (name: string, args: unknown) => {
    calls.push({ method: "rpc", args: [name, args], table: undefined });
    if (rpcOverride) return rpcOverride(name, args);
    return Promise.resolve({ data: [], error: null });
  };
  setMockServiceClient(() => client);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const COMPOUND_ID = "00000000-0000-0000-0000-0000000000c1";

describe("graphService — getTopCoOccurring (RPC params + clamps)", () => {
  it("calls the RPC with { p_compound_id, p_limit } and returns rows", async () => {
    client.__setRpcOverride((_name, _args) => {
      return Promise.resolve({
        data: [
          {
            compound_id: "00000000-0000-0000-0000-0000000000c2",
            canonical_name: "Kaempferol",
            fact_count: 41,
          },
          {
            compound_id: "00000000-0000-0000-0000-0000000000c3",
            canonical_name: "Myricetin",
            fact_count: 7,
          },
        ],
        error: null,
      });
    });

    const result = await getTopCoOccurring(COMPOUND_ID, 3);
    expect(result.length).toBe(2);
    expect(result[0].compound_id).toBe(
      "00000000-0000-0000-0000-0000000000c2",
    );
    expect(result[0].canonical_name).toBe("Kaempferol");
    expect(result[0].fact_count).toBe(41);
    expect(result[1].canonical_name).toBe("Myricetin");

    // RPC was called exactly once with the right name + args.
    expect(calls.length).toBe(1);
    expect(calls[0].args[0]).toBe("graph_top_co_occurring");
    const rpcArgs = calls[0].args[1] as Record<string, unknown>;
    expect(rpcArgs.p_compound_id).toBe(COMPOUND_ID);
    expect(rpcArgs.p_limit).toBe(3);
  });

  it("defaults limit to 5 when none is passed", async () => {
    client.__setRpcOverride((_name, args) => {
      const a = args as { p_limit?: number };
      expect(a.p_limit).toBe(5);
      return Promise.resolve({ data: [], error: null });
    });

    await getTopCoOccurring(COMPOUND_ID);
    expect(calls.length).toBe(1);
    const rpcArgs = calls[0].args[1] as Record<string, unknown>;
    expect(rpcArgs.p_limit).toBe(5);
  });

  it("clamps limit to >= 1 and <= 100 (negative, zero, large)", async () => {
    let lastLimit: number | undefined;
    client.__setRpcOverride((_name, args) => {
      const a = args as { p_limit?: number };
      lastLimit = a.p_limit;
      return Promise.resolve({ data: [], error: null });
    });

    await getTopCoOccurring(COMPOUND_ID, -5);
    expect(lastLimit).toBe(1);

    await getTopCoOccurring(COMPOUND_ID, 0);
    expect(lastLimit).toBe(1);

    await getTopCoOccurring(COMPOUND_ID, 9999);
    expect(lastLimit).toBe(100);
  });

  it("returns [] for an empty compoundId without calling the RPC", async () => {
    const result = await getTopCoOccurring("");
    expect(result).toEqual([]);
    expect(calls.length).toBe(0);
  });
});
