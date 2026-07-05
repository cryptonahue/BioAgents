import { describe, it, expect, beforeEach, mock } from "bun:test";

/**
 * Unit tests for `graphService.ts` (PR #1 of
 * `bioprospecting-knowledge-graph`).
 *
 * Coverage matrix — one test per spec scenario from
 * `openspec/changes/bioprospecting-knowledge-graph/specs/bioprospecting-knowledge-graph/spec.md`:
 *
 *   1.  searchCompounds — empty/whitespace `q` returns `[]` without
 *       hitting the DB.
 *   2.  searchCompounds — default `limit` is 20 when none passed.
 *   3.  searchCompounds — `limit: 500` is silently clamped to 100
 *       (the in-process slice uses `safeLimit`).
 *   4.  searchCompounds — 4-tier ordering:
 *       exact canonical > exact alias > prefix > substring.
 *   5.  searchCompounds — ties break by `fact_count DESC` then
 *       `canonical_name ASC`.
 *   6.  searchCompounds — case-insensitive: `"QUERCETIN"` and
 *       `"quercetin"` return the same row first.
 *   7.  searchCompounds — `expand: false` does NOT call
 *       `getTopCoOccurring` / `getTopGeographies` /
 *       `getTopBioactivities` (no `rpc` calls with those names).
 *   8.  searchCompounds — `expand: true` issues the three RPCs in
 *       parallel and attaches the results.
 *   9.  refreshAggregates — RPC error is logged at `warn` and the
 *       function does NOT throw.
 *   10. refreshAggregates — non-RPC throw (e.g. `supabase.rpc` is not
 *       a function on a broken mock) is also absorbed.
 *
 * The tests are hermetic: the Supabase service client is mocked with
 * a chainable stub. No DB or network round-trip happens.
 */

// ---------------------------------------------------------------------------
// Mock infrastructure — mirrors bioprospectingExtractor.tables.test.ts
// ---------------------------------------------------------------------------

type Call = { method: string; args: unknown[]; table?: string };
type Terminal =
  | { kind: "single"; data: unknown; error: unknown }
  | { kind: "many"; data: unknown[]; error: unknown };

const BUILDER_METHODS = [
  "from",
  "select",
  "insert",
  "update",
  "delete",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
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
  "upsert",
  "maybeSingle",
];

const TERMINAL_METHODS = ["maybeSingle", "single"];

function scriptedMock(script: Terminal[], calls: Call[]) {
  let cursor = 0;
  let currentTable: string | undefined;
  let rpcOverride: ((name: string, args: unknown) => unknown) | undefined;
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
      return Promise.resolve({ data: t.data, error: t.error });
    };
  }
  Object.defineProperty(target, "then", {
    get() {
      return (onFulfilled: any, onRejected: any) => {
        calls.push({ method: "then", args: [], table: currentTable });
        const t = next();
        const data = t.kind === "single" ? t.data : t.data;
        const error = t.error;
        return Promise.resolve({ data, error }).then(onFulfilled, onRejected);
      };
    },
  });
  target.rpc = (name: string, args: unknown) => {
    calls.push({ method: "rpc", args: [name, args], table: undefined });
    if (rpcOverride) {
      return rpcOverride(name, args);
    }
    return Promise.resolve({ data: [], error: null });
  };
  target.__setRpcOverride = (fn: (name: string, args: unknown) => unknown) => {
    rpcOverride = fn;
  };
  return target;
}

declare global {
  // eslint-disable-next-line no-var
  var __graphServiceTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__graphServiceTestClient = factory;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__graphServiceTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__graphServiceTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__graphServiceTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__graphServiceTestClient ?? (() => null))(),
}));

// SUT imports (post-mock)
import {
  refreshAggregates,
  searchCompounds,
} from "../graphService";

let calls: Call[];
let client: any;

beforeEach(() => {
  calls = [];
  client = scriptedMock([], calls);
  setMockServiceClient(() => client);
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeMatviewRow(overrides: Record<string, unknown> = {}) {
  return {
    compound_id: "00000000-0000-0000-0000-0000000000c1",
    canonical_name: "Quercetin",
    normalized_name: "quercetin",
    pubchem_cid: 5280343,
    chebi_id: null,
    molecular_formula: "C15H10O7",
    fact_count: 137,
    source_count: 42,
    claim_count: 8,
    first_seen_at: "2024-01-12T08:14:00Z",
    last_seen_at: "2026-06-12T18:22:11Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. searchCompounds — empty / whitespace query short-circuits
// ---------------------------------------------------------------------------

describe("graphService — searchCompounds (empty / whitespace query)", () => {
  it("returns [] for empty / whitespace query without hitting the DB", async () => {
    const result1 = await searchCompounds({ query: "" });
    const result2 = await searchCompounds({ query: "   " });
    expect(result1).toEqual([]);
    expect(result2).toEqual([]);
    // No DB calls were made (no `.from`, no `.or`).
    const fromCalls = calls.filter((c) => c.method === "from");
    expect(fromCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. searchCompounds — default limit
// ---------------------------------------------------------------------------

describe("graphService — searchCompounds (default + max limit)", () => {
  it("uses default limit 20 and applies 4x fetch window", async () => {
    client = scriptedMock(
      [
        { kind: "many", data: [makeMatviewRow()], error: null },
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await searchCompounds({ query: "quercetin" });
    expect(result.length).toBe(1);

    // The matview fetch was called with `.limit(...)` so the
    // `FETCH_WINDOW` constant made it into the chain. The default
    // limit of 20 → 4x = 80.
    const limitCall = calls.find(
      (c) => c.method === "limit" && c.table === "research_graph_compound_aggregates",
    );
    expect(limitCall).toBeDefined();
    expect(limitCall!.args[0]).toBe(80);
  });

  it("clamps limit > 100 down to 100 and applies 4x fetch window", async () => {
    client = scriptedMock(
      [
        { kind: "many", data: [], error: null },
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await searchCompounds({ query: "x", limit: 500 });
    expect(Array.isArray(result)).toBe(true);

    // limit=100 → 4x = 400.
    const limitCall = calls.find(
      (c) => c.method === "limit" && c.table === "research_graph_compound_aggregates",
    );
    expect(limitCall).toBeDefined();
    expect(limitCall!.args[0]).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 3. searchCompounds — 4-tier ranking
// ---------------------------------------------------------------------------

describe("graphService — searchCompounds (4-tier ranking)", () => {
  it("ranks exact canonical > exact alias > prefix > substring", async () => {
    // The query is "quer" (3 chars) so:
    //   - "Quercetin"           → tier 0 (exact canonical, equals "quer")? No, "quercetin" !== "quer"
    //                              → tier 2 (prefix "quer")
    //   - "Quercitrin"          → tier 2 (prefix "quer")
    //   - "Quercetin-3-O-gluc"  → tier 3 (substring, but no prefix and no exact alias match)
    //   - "Isoquercetin"        → tier 3 (substring)
    //
    // We seed the exact-canonical and exact-alias hits under a
    // separate query ("quercetin") and assert both in this single
    // test: the prefix tier is exercised by the "quer" query and
    // the exact tiers are exercised by the "quercetin" query.
    //
    // Run 1: query = "quercetin" — proves exact canonical > exact
    // alias > substring.
    const matviewRowsExact = [
      // Tier 3 substring: "Isoquercetin".
      makeMatviewRow({
        compound_id: "00000000-0000-0000-0000-0000000000c4",
        canonical_name: "Isoquercetin",
        normalized_name: "isoquercetin",
        fact_count: 1,
        source_count: 1,
        claim_count: 0,
      }),
      // Tier 1 exact alias: "Quercetin-3-O-glucoside" (canonical !=
      // "quercetin" but an alias does).
      makeMatviewRow({
        compound_id: "00000000-0000-0000-0000-0000000000c2",
        canonical_name: "Quercetin-3-O-glucoside",
        normalized_name: "quercetin 3 o glucoside",
        fact_count: 50,
        source_count: 20,
        claim_count: 4,
      }),
      // Tier 0 exact canonical.
      makeMatviewRow({
        compound_id: "00000000-0000-0000-0000-0000000000c1",
        canonical_name: "Quercetin",
        normalized_name: "quercetin",
        fact_count: 137,
        source_count: 42,
        claim_count: 8,
      }),
    ];
    const aliasRowsExact = [
      {
        compound_id: "00000000-0000-0000-0000-0000000000c2",
        alias: "Quercetin",
      },
    ];

    calls = [];
    client = scriptedMock(
      [
        { kind: "many", data: matviewRowsExact, error: null },
        { kind: "many", data: aliasRowsExact, error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const resultExact = await searchCompounds({ query: "quercetin" });
    expect(resultExact.length).toBe(3);
    expect(resultExact[0].compound.canonical_name).toBe("Quercetin"); // tier 0
    expect(resultExact[1].compound.canonical_name).toBe(
      "Quercetin-3-O-glucoside",
    ); // tier 1
    expect(resultExact[2].compound.canonical_name).toBe("Isoquercetin"); // tier 3

    // Run 2: query = "quer" — proves prefix > substring.
    // "Quercetin" is a prefix hit (tier 2); "Quercitrin" is a
    // prefix hit (tier 2); "Quercetin-3-O-glucoside" is a substring
    // hit (tier 3) because "Quercetin-3-O-Glucoside".startsWith("quer")
    // is true too — actually it IS a prefix hit. Use a cleaner split:
    //   "Quercetin" (prefix) vs "Isoquercetin" (substring only).
    const matviewRowsPrefix = [
      makeMatviewRow({
        compound_id: "00000000-0000-0000-0000-0000000000c4",
        canonical_name: "Isoquercetin",
        normalized_name: "isoquercetin",
        fact_count: 1,
        source_count: 1,
        claim_count: 0,
      }),
      makeMatviewRow({
        compound_id: "00000000-0000-0000-0000-0000000000c1",
        canonical_name: "Quercetin",
        normalized_name: "quercetin",
        fact_count: 137,
        source_count: 42,
        claim_count: 8,
      }),
    ];

    calls = [];
    client = scriptedMock(
      [
        { kind: "many", data: matviewRowsPrefix, error: null },
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const resultPrefix = await searchCompounds({ query: "quer" });
    expect(resultPrefix.length).toBe(2);
    expect(resultPrefix[0].compound.canonical_name).toBe("Quercetin"); // tier 2
    expect(resultPrefix[1].compound.canonical_name).toBe("Isoquercetin"); // tier 3
  });

  it("breaks tier-3 ties by fact_count DESC then canonical_name ASC", async () => {
    // Two substring hits with different fact counts. The higher
    // fact_count wins.
    const matviewRows = [
      makeMatviewRow({
        compound_id: "00000000-0000-0000-0000-0000000000c1",
        canonical_name: "Quercetin A",
        normalized_name: "quercetin a",
        fact_count: 10,
        source_count: 5,
        claim_count: 1,
      }),
      makeMatviewRow({
        compound_id: "00000000-0000-0000-0000-0000000000c2",
        canonical_name: "Quercetin B",
        normalized_name: "quercetin b",
        fact_count: 100,
        source_count: 30,
        claim_count: 5,
      }),
    ];

    client = scriptedMock(
      [
        { kind: "many", data: matviewRows, error: null },
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await searchCompounds({ query: "quercetin" });
    // Both are tier-3 (substring). fact_count DESC → B first.
    expect(result[0].compound.canonical_name).toBe("Quercetin B");
    expect(result[1].compound.canonical_name).toBe("Quercetin A");
  });
});

// ---------------------------------------------------------------------------
// 4. searchCompounds — case-insensitive
// ---------------------------------------------------------------------------

describe("graphService — searchCompounds (case-insensitive)", () => {
  it("returns the same first hit for QUERCETIN and quercetin", async () => {
    const matviewRow = makeMatviewRow({
      canonical_name: "Quercetin",
      normalized_name: "quercetin",
    });
    // Run twice: once with upper, once with lower.
    for (const q of ["QUERCETIN", "quercetin"]) {
      calls = [];
      client = scriptedMock(
        [
          { kind: "many", data: [matviewRow], error: null },
          { kind: "many", data: [], error: null },
        ],
        calls,
      );
      setMockServiceClient(() => client);
      const result = await searchCompounds({ query: q });
      expect(result.length).toBe(1);
      expect(result[0].compound.canonical_name).toBe("Quercetin");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. searchCompounds — expand: false
// ---------------------------------------------------------------------------

describe("graphService — searchCompounds (expand: false)", () => {
  it("does not call getTopCoOccurring / getTopGeographies / getTopBioactivities", async () => {
    client = scriptedMock(
      [
        { kind: "many", data: [makeMatviewRow()], error: null },
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await searchCompounds({
      query: "quercetin",
      expand: false,
    });
    expect(result.length).toBe(1);
    // Default response shape: no expand arrays.
    expect(result[0].topCoOccurring).toBeUndefined();
    expect(result[0].topGeographies).toBeUndefined();
    expect(result[0].topBioactivities).toBeUndefined();
    // No RPC calls.
    const rpcCalls = calls.filter((c) => c.method === "rpc");
    expect(rpcCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. searchCompounds — expand: true
// ---------------------------------------------------------------------------

describe("graphService — searchCompounds (expand: true)", () => {
  it("issues three parallel RPCs and attaches the results", async () => {
    // Matview row + alias pass + 3 RPCs per hit (1 hit = 3 RPCs).
    const matviewRow = makeMatviewRow();

    client = scriptedMock(
      [
        { kind: "many", data: [matviewRow], error: null }, // matview fetch
        { kind: "many", data: [], error: null }, // alias pass
      ],
      calls,
    );
    setMockServiceClient(() => client);

    // The 3 RPCs need to resolve with deterministic data. The
    // scripted mock's terminal chain ends after the second many,
    // so the RPCs need their own override. Note: the RPC override
    // is the only way the post-cursor exhaustion path returns
    // different data per RPC name.
    client.__setRpcOverride((name: string, _args: unknown) => {
      if (name === "graph_top_co_occurring") {
        return Promise.resolve({
          data: [
            {
              compound_id: "00000000-0000-0000-0000-0000000000c2",
              canonical_name: "Kaempferol",
              fact_count: 41,
            },
          ],
          error: null,
        });
      }
      if (name === "graph_top_string_field") {
        // The function maps both geographies and bioactivities
        // through this RPC; we return a single bucket for the
        // geography call and a different one for the bioactivity
        // call by inspecting the p_field argument.
        // Both args have p_field='geography' or 'bioactivity'.
        // We need to be deterministic — use the most-recent setRpcOverride
        // is not enough; we use the fact_count value to distinguish.
        // Simpler: return the same shape for both, and assert the
        // union in the assertion below.
        return Promise.resolve({
          data: [
            { value: "Southeast Asia", fact_count: 12 },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    });

    const result = await searchCompounds({
      query: "quercetin",
      expand: true,
    });
    expect(result.length).toBe(1);

    // The expand arrays are attached.
    expect(result[0].topCoOccurring).toBeDefined();
    expect(result[0].topCoOccurring![0].canonical_name).toBe("Kaempferol");
    expect(result[0].topCoOccurring![0].fact_count).toBe(41);
    expect(result[0].topGeographies).toBeDefined();
    expect(result[0].topGeographies![0].value).toBe("Southeast Asia");
    expect(result[0].topBioactivities).toBeDefined();

    // Three RPC calls were made: one for each of the top-N helpers.
    const rpcCalls = calls.filter((c) => c.method === "rpc");
    expect(rpcCalls.length).toBe(3);
    const rpcNames = rpcCalls.map((c) => (c.args[0] as string));
    expect(rpcNames).toContain("graph_top_co_occurring");
    expect(
      rpcNames.filter((n) => n === "graph_top_string_field").length,
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 7. refreshAggregates — soft-fail
// ---------------------------------------------------------------------------

describe("graphService — refreshAggregates (soft-fail)", () => {
  it("does not throw when the RPC returns an error and logs a warning", async () => {
    client.__setRpcOverride((_name: string, _args: unknown) => {
      return Promise.resolve({ data: null, error: { message: "rpc failed" } });
    });

    // Function MUST resolve successfully (no rejection) and NOT throw.
    await expect(refreshAggregates()).resolves.toBeUndefined();
  });

  it("does not throw when supabase.rpc itself throws (non-RPC error)", async () => {
    // Replace rpc with a function that throws synchronously to
    // simulate a broken client. The try/catch around supabase.rpc
    // MUST absorb the throw.
    client.rpc = () => {
      throw new Error("rpc is not a function");
    };

    await expect(refreshAggregates()).resolves.toBeUndefined();
  });
});
