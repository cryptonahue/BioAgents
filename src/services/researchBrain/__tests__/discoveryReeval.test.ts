/**
 * Unit tests for `src/services/researchBrain/discoveryReeval.ts` (the
 * v1 re-evaluation service module shipped by PR #2 of
 * `discovery-persistence`).
 *
 * v1 is LLM-free: the verdict (clean / extended / contradicted) is
 * derived from SQL counts only. The tests cover:
 *
 *   Pure helpers (no IO):
 *     1.  normalizeTitleForMatch: NFKD + lowercase + alnum collapse
 *     2.  normalizeTitleForMatch: empty/null is ""
 *     3.  computeVerdict: contradicting pairs > 0 wins over supporting
 *     4.  computeVerdict: only supporting facts -> 'extended'
 *     5.  computeVerdict: nothing -> 'clean'
 *     6.  getDiscoveryReevalConfig: defaults when env unset
 *     7.  getDiscoveryReevalConfig: env override
 *     8.  getDiscoveryReevalConfig: DISCOVERY_REEVAL_ENABLED=false
 *
 *   runReevalPass (mocked DB):
 *     9.  no due rows -> scanned=0
 *    10.  one row, no supporting, no contradicting -> clean
 *    11.  one row, with supporting facts -> extended
 *    12.  one row, with contradicting pair -> contradicted
 *    13.  verdict write failure -> pendingRetained++ and row stays pending
 *
 * The tests are hermetic: the Supabase service client is mocked
 * with a chainable stub (same pattern as discoveryPersistence.test.ts).
 */

import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mock infrastructure — mirrors discoveryPersistence.test.ts
// ---------------------------------------------------------------------------

type Call = { method: string; args: unknown[]; table?: string };
type Terminal =
  | { kind: "single"; data: unknown; error: unknown }
  | { kind: "many"; data: unknown[]; error: unknown }
  | { kind: "count"; count: number; error: unknown };

const BUILDER_METHODS = [
  "from",
  "select",
  "insert",
  "update",
  "delete",
  "eq",
  "neq",
  "in",
  "is",
  "not",
  "or",
  "and",
  "ilike",
  "match",
  "filter",
  "order",
  "limit",
  "range",
  "gt",
  "lt",
  "upsert",
  "maybeSingle",
];

const TERMINAL_METHODS = ["maybeSingle", "single"];

function scriptedMock(script: Terminal[], calls: Call[]) {
  let cursor = 0;
  let currentTable: string | undefined;
  const target: any = {};
  const next = (): Terminal => {
    if (cursor >= script.length) {
      return { kind: "many", data: [], error: null };
    }
    return script[cursor++];
  };
  for (const method of BUILDER_METHODS) {
    target[method] = (...args: unknown[]) => {
      if (method === "from") {
        currentTable = args[0] as string;
      }
      calls.push({ method, args, table: currentTable });
      return target;
    };
  }
  for (const method of TERMINAL_METHODS) {
    target[method] = (...args: unknown[]) => {
      calls.push({ method, args, table: currentTable });
      const t = next();
      if (t.kind === "single") {
        return Promise.resolve({ data: t.data, error: t.error });
      }
      if (t.kind === "count") {
        return Promise.resolve({ count: t.count, error: t.error, data: null });
      }
      return Promise.resolve({ data: t.data, error: t.error });
    };
  }
  Object.defineProperty(target, "then", {
    get() {
      return (onFulfilled: any, onRejected: any) => {
        calls.push({ method: "then", args: [], table: currentTable });
        const t = next();
        if (t.kind === "count") {
          // Supabase returns { count, data, error } when
          // .select(..., { count: "exact", head: true }) is used.
          return Promise.resolve({
            count: t.count,
            data: null,
            error: t.error,
          }).then(onFulfilled, onRejected);
        }
        if (t.kind === "single") {
          return Promise.resolve({ data: t.data, error: t.error }).then(
            onFulfilled,
            onRejected,
          );
        }
        return Promise.resolve({ data: t.data, error: t.error }).then(
          onFulfilled,
          onRejected,
        );
      };
    },
  });
  return target;
}

declare global {
  // eslint-disable-next-line no-var
  var __reevalTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__reevalTestClient = factory;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__reevalTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__reevalTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__reevalTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () => (globalThis.__reevalTestClient ?? (() => null))(),
}));

import {
  runReevalPass,
  computeVerdict,
  normalizeTitleForMatch,
  getDiscoveryReevalConfig,
  type DueDiscovery,
} from "../discoveryReeval";

let calls: Call[];
let client: any;

beforeEach(() => {
  calls = [];
  client = scriptedMock([], calls);
  setMockServiceClient(() => client);
  delete process.env.DISCOVERY_REEVAL_ENABLED;
  delete process.env.DISCOVERY_REEVAL_INTERVAL_HOURS;
  delete process.env.DISCOVERY_REEVAL_BATCH_SIZE;
});

afterEach(() => {
  delete process.env.DISCOVERY_REEVAL_ENABLED;
  delete process.env.DISCOVERY_REEVAL_INTERVAL_HOURS;
  delete process.env.DISCOVERY_REEVAL_BATCH_SIZE;
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("normalizeTitleForMatch — pure", () => {
  it("applies NFKD + lowercase + alnum collapse", () => {
    expect(
      normalizeTitleForMatch("Anthoteibinene J — inhibits C. albicans"),
    ).toBe("anthoteibinene j inhibits c albicans");
  });

  it("returns empty for null / undefined / empty", () => {
    expect(normalizeTitleForMatch(null)).toBe("");
    expect(normalizeTitleForMatch(undefined)).toBe("");
    expect(normalizeTitleForMatch("")).toBe("");
    expect(normalizeTitleForMatch("   ")).toBe("");
  });
});

describe("computeVerdict — pure priority", () => {
  it("contradicting > 0 wins over supporting > 0", () => {
    expect(
      computeVerdict({ supportingFacts: 5, contradictingPairs: 1 }),
    ).toEqual({
      verdict: "contradicted",
      notes: "1 contradicting fact pair(s) detected since the last check",
    });
  });

  it("supporting > 0 with no contradicting -> extended", () => {
    expect(
      computeVerdict({ supportingFacts: 3, contradictingPairs: 0 }),
    ).toEqual({
      verdict: "extended",
      notes: "3 new supporting fact(s) added since the last check",
    });
  });

  it("nothing -> clean", () => {
    expect(
      computeVerdict({ supportingFacts: 0, contradictingPairs: 0 }),
    ).toEqual({
      verdict: "clean",
      notes: "no new evidence in the re-check window",
    });
  });
});

describe("getDiscoveryReevalConfig — env-driven", () => {
  it("uses defaults when env is unset", () => {
    const cfg = getDiscoveryReevalConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.intervalHours).toBe(24);
    expect(cfg.batchSize).toBe(100);
  });

  it("honors env overrides", () => {
    process.env.DISCOVERY_REEVAL_INTERVAL_HOURS = "6";
    process.env.DISCOVERY_REEVAL_BATCH_SIZE = "50";
    const cfg = getDiscoveryReevalConfig();
    expect(cfg.intervalHours).toBe(6);
    expect(cfg.batchSize).toBe(50);
  });

  it("DISCOVERY_REEVAL_ENABLED=false flips enabled", () => {
    process.env.DISCOVERY_REEVAL_ENABLED = "false";
    expect(getDiscoveryReevalConfig().enabled).toBe(false);
  });

  it("invalid env values fall back to defaults", () => {
    process.env.DISCOVERY_REEVAL_INTERVAL_HOURS = "not-a-number";
    process.env.DISCOVERY_REEVAL_BATCH_SIZE = "0";
    const cfg = getDiscoveryReevalConfig();
    expect(cfg.intervalHours).toBe(24);
    expect(cfg.batchSize).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// runReevalPass
// ---------------------------------------------------------------------------

/**
 * Build a discovery row for use in the mock script.
 */
function makeDiscovery(overrides: Partial<DueDiscovery> = {}): DueDiscovery {
  return {
    id: overrides.id ?? "d1",
    discovery_group_id: overrides.discovery_group_id ?? "g1",
    conversation_id: overrides.conversation_id ?? "c1",
    title: overrides.title ?? "Anthoteibinene J inhibits Candida albicans",
    claim: overrides.claim ?? "IC50 7.7-9.1 ug/mL",
    created_at: overrides.created_at ?? "2026-06-15T00:00:00Z",
    last_checked_at: overrides.last_checked_at ?? null,
  };
}

describe("runReevalPass — no due rows", () => {
  it("returns scanned=0 when no rows are due", async () => {
    // The first query is the UPDATE that returns ids; the second
    // is the SELECT for those ids. Both can be empty.
    client = scriptedMock(
      [
        { kind: "many", data: [], error: null }, // UPDATE returns []
        { kind: "many", data: [], error: null }, // SELECT returns []
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const summary = await runReevalPass();
    expect(summary.scanned).toBe(0);
    expect(summary.clean).toBe(0);
    expect(summary.extended).toBe(0);
    expect(summary.contradicted).toBe(0);
  });
});

describe("runReevalPass — clean verdict", () => {
  it("writes clean when no supporting facts and no contradicting pairs", async () => {
    const discovery = makeDiscovery();
    client = scriptedMock(
      [
        // UPDATE claim: returns the id we just stamped
        { kind: "many", data: [{ id: discovery.id }], error: null },
        // SELECT for the claim details
        { kind: "many", data: [discovery], error: null },
        // countSupportingFacts -> ilike count on compound
        { kind: "count", count: 0, error: null },
        // countContradictingPairs (Promise.all of two counts)
        { kind: "count", count: 0, error: null },
        { kind: "count", count: 0, error: null },
        // writeVerdict UPDATE on the discovery row
        { kind: "many", data: [], error: null },
        // writeVerdict INSERT into audit
        { kind: "single", data: { id: "audit-1" }, error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const summary = await runReevalPass();
    expect(summary.scanned).toBe(1);
    expect(summary.clean).toBe(1);
    expect(summary.extended).toBe(0);
    expect(summary.contradicted).toBe(0);
  });
});

describe("runReevalPass — extended verdict", () => {
  it("writes extended when supporting facts > 0 and no contradicting", async () => {
    const discovery = makeDiscovery();
    client = scriptedMock(
      [
        { kind: "many", data: [{ id: discovery.id }], error: null },
        { kind: "many", data: [discovery], error: null },
        { kind: "count", count: 3, error: null }, // supporting
        { kind: "count", count: 0, error: null }, // contradicting source
        { kind: "count", count: 0, error: null }, // contradicting conflicting
        { kind: "many", data: [], error: null }, // writeVerdict UPDATE
        { kind: "single", data: { id: "audit-1" }, error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const summary = await runReevalPass();
    expect(summary.extended).toBe(1);
  });
});

describe("runReevalPass — contradicted verdict", () => {
  it("writes contradicted when a contradicting pair is found", async () => {
    const discovery = makeDiscovery();
    client = scriptedMock(
      [
        { kind: "many", data: [{ id: discovery.id }], error: null },
        { kind: "many", data: [discovery], error: null },
        { kind: "count", count: 0, error: null },  // supporting
        { kind: "count", count: 1, error: null },  // contradicting source
        { kind: "count", count: 0, error: null },  // contradicting conflicting
        { kind: "many", data: [], error: null },    // writeVerdict UPDATE
        { kind: "single", data: { id: "audit-1" }, error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const summary = await runReevalPass();
    expect(summary.contradicted).toBe(1);
  });

  it("contradicting wins even when supporting > 0", async () => {
    const discovery = makeDiscovery();
    client = scriptedMock(
      [
        { kind: "many", data: [{ id: discovery.id }], error: null },
        { kind: "many", data: [discovery], error: null },
        { kind: "count", count: 5, error: null }, // supporting (ignored)
        { kind: "count", count: 1, error: null }, // contradicting
        { kind: "count", count: 0, error: null },
        { kind: "many", data: [], error: null },
        { kind: "single", data: { id: "audit-1" }, error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const summary = await runReevalPass();
    expect(summary.contradicted).toBe(1);
    expect(summary.extended).toBe(0);
  });
});

describe("runReevalPass — write failure self-heals", () => {
  it("keeps the row in pending when writeVerdict returns false", async () => {
    const discovery = makeDiscovery();
    // writeVerdict UPDATE returns an error -> writeVerdict returns
    // false -> row stays in pending -> pendingRetained++.
    client = scriptedMock(
      [
        { kind: "many", data: [{ id: discovery.id }], error: null },
        { kind: "many", data: [discovery], error: null },
        { kind: "count", count: 0, error: null },
        { kind: "count", count: 0, error: null },
        { kind: "count", count: 0, error: null },
        { kind: "many", data: [], error: { message: "DB write boom" } },
        // No audit insert because the UPDATE errored before it.
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const summary = await runReevalPass();
    expect(summary.scanned).toBe(1);
    expect(summary.clean).toBe(0);
    expect(summary.pendingRetained).toBe(1);
  });
});

describe("runReevalPass — env disabled", () => {
  it("returns the empty summary when DISCOVERY_REEVAL_ENABLED=false", async () => {
    process.env.DISCOVERY_REEVAL_ENABLED = "false";
    // No script needed — the function returns before any DB call.
    client = scriptedMock([], calls);
    setMockServiceClient(() => client);

    const summary = await runReevalPass();
    expect(summary.scanned).toBe(0);
    expect(summary.elapsed).toBe(0);
  });
});
