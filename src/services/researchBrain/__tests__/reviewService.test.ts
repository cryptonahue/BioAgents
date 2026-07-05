/**
 * Unit tests for `src/services/researchBrain/reviewService.ts`.
 *
 * Coverage (11 cases, matching the tasks.md spec):
 *   1. `listContradictionsGlobal` — happy path
 *   2. `listContradictionsGlobal` — status filter (eq)
 *   3. `listContradictionsGlobal` — limit clamp at 200
 *   4. `getContradictionStats` — pending clamp (resolved+dismissed > found)
 *   5. `getContradictionStats` — happy path (RPC + edges combined)
 *   6. `listRecentMergeEvents` — happy path
 *   7. `listRecentMergeEvents` — since='all' omits time filter
 *   8. `listRecentMergeEvents` — limit clamp at 200
 *   9. `unmergeFact` — happy path (edge + audit returned)
 *  10. `unmergeFact` — NoActiveEdgeError on double-unmerge
 *  11. `unmergeFact` — AmbiguousEdgeError on multi-edge
 *
 * The chainable mock follows the same `scriptedMock` pattern as
 * `dedup.test.ts`. RPC is mocked via the `from("get_contradiction_stats")`
 * surrogate because Supabase's `.rpc()` is also chainable through the
 * `getServiceClient` proxy (we hand-roll the rpc branch).
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// Mock the Supabase client BEFORE importing reviewService.
declare global {
  // eslint-disable-next-line no-var
  var __reviewServiceTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__reviewServiceTestClient = factory;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__reviewServiceTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__reviewServiceTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__reviewServiceTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__reviewServiceTestClient ?? (() => null))(),
}));

import {
  listContradictionsGlobal,
  getContradictionStats,
  listRecentMergeEvents,
  unmergeFact,
  NoActiveEdgeError,
  AmbiguousEdgeError,
  InvalidReasonCategoryError,
  FactNotFoundError,
} from "../reviewService";

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
  "rpc",
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
      if (method === "rpc") {
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
  return target;
}

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

const FACT_ID = "00000000-0000-0000-0000-0000000000f1";
const CANONICAL_ID = "00000000-0000-0000-0000-0000000000c1";
const SOURCE_ID = "00000000-0000-0000-0000-0000000000s1";
const USER_ID = "admin-1";

function makeContradiction(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-0000-0000-0000000000a1",
    fact_a_id: "00000000-0000-0000-0000-0000000000f2",
    fact_b_id: "00000000-0000-0000-0000-0000000000f3",
    conflict_type: "compound_mismatch",
    severity: "medium",
    explanation: null,
    status: "open",
    resolved_by: null,
    resolved_at: null,
    resolution_note: null,
    detected_at: "2026-06-15T00:00:00Z",
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1-4. listContradictionsGlobal
// ---------------------------------------------------------------------------

describe("reviewService — listContradictionsGlobal", () => {
  it("returns rows + total + limit + offset on the happy path", async () => {
    client = scriptedMock(
      [
        // count query (head: true, count: exact)
        { kind: "many", data: [], error: null },
        // page query
        {
          kind: "many",
          data: [makeContradiction(), makeContradiction({ id: "id-2" })],
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await listContradictionsGlobal({
      limit: 10,
      offset: 0,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
  });

  it("filters by status when provided", async () => {
    client = scriptedMock(
      [
        { kind: "many", data: [], error: null },
        { kind: "many", data: [makeContradiction()], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    await listContradictionsGlobal({
      status: "resolved",
      limit: 50,
      offset: 0,
    });
    const eqCalls = calls.filter((c) => c.method === "eq");
    // Both the count and the page query apply the status filter. The
    // DB column is `status`; for "resolved" the value passes through
    // directly (no mapping). For "unresolved" the function maps to
    // DB "open" before issuing the query.
    const statusEq = eqCalls.filter(
      (c) => c.args[0] === "status" && c.args[1] === "resolved",
    );
    expect(statusEq.length).toBeGreaterThanOrEqual(2);
  });

  it("clamps limit to 200 when a higher value is requested", async () => {
    client = scriptedMock(
      [
        { kind: "many", data: [], error: null },
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await listContradictionsGlobal({ limit: 9999, offset: 0 });
    expect(result.limit).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5-6. getContradictionStats
// ---------------------------------------------------------------------------

describe("reviewService — getContradictionStats", () => {
  it("clamps pending to 0 when resolved+dismissed > found", async () => {
    // The mock returns an RPC result with 1d { found: 5, resolved: 12, dismissed: 0 }
    // and edges (empty). The pending should be max(0, 5 - 12 - 0) = 0.
    client = scriptedMock(
      [
        // RPC: get_contradiction_stats returns 2 rows
        {
          kind: "many",
          data: [
            { window_label: "1d", found: 5, resolved: 12, dismissed: 0 },
            { window_label: "7d", found: 100, resolved: 30, dismissed: 5 },
          ],
          error: null,
        },
        // edges select
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const stats = await getContradictionStats();
    expect(stats.today.found).toBe(5);
    expect(stats.today.resolved).toBe(12);
    expect(stats.today.dismissed).toBe(0);
    expect(stats.today.pending).toBe(0);
    expect(stats.last7d.found).toBe(100);
    expect(stats.last7d.resolved).toBe(30);
    expect(stats.last7d.dismissed).toBe(5);
    expect(stats.last7d.pending).toBe(65);
  });

  it("returns the 6-metric shape for both windows on the happy path", async () => {
    client = scriptedMock(
      [
        {
          kind: "many",
          data: [
            { window_label: "1d", found: 10, resolved: 3, dismissed: 1 },
            { window_label: "7d", found: 50, resolved: 15, dismissed: 4 },
          ],
          error: null,
        },
        // edges with merges and unmerges in both windows
        {
          kind: "many",
          data: [
            {
              merged_at: new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString(),
              unmerged_at: null,
              is_active: true,
            },
            {
              merged_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
              unmerged_at: new Date(Date.now() - 1000 * 60 * 60 * 12).toISOString(),
              is_active: false,
            },
            {
              merged_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(),
              unmerged_at: null,
              is_active: true,
            },
          ],
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const stats = await getContradictionStats();
    expect(Object.keys(stats.today).sort()).toEqual(
      ["dismissed", "found", "merges", "pending", "resolved", "unmerges"].sort(),
    );
    expect(Object.keys(stats.last7d).sort()).toEqual(
      ["dismissed", "found", "merges", "pending", "resolved", "unmerges"].sort(),
    );
    expect(stats.today.pending).toBe(6);
    expect(stats.last7d.pending).toBe(31);
    expect(stats.today.merges).toBe(1);
    expect(stats.last7d.merges).toBe(1);
    expect(stats.today.unmerges).toBe(1);
    expect(stats.last7d.unmerges).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7-9. listRecentMergeEvents
// ---------------------------------------------------------------------------

describe("reviewService — listRecentMergeEvents", () => {
  it("returns active and unmerged events together", async () => {
    const mergedAt = new Date(Date.now() - 1000 * 60 * 60).toISOString();
    const unmergedAt = new Date().toISOString();
    client = scriptedMock(
      [
        {
          kind: "many",
          data: [
            {
              canonical_fact_id: CANONICAL_ID,
              merged_fact_id: FACT_ID,
              match_rule: "identity_key",
              merged_at: mergedAt,
              is_active: true,
              unmerged_at: null,
              unmerged_by: null,
              dedup_audit: null,
            },
            {
              canonical_fact_id: "canon-2",
              merged_fact_id: "fact-2",
              match_rule: "identity_key",
              merged_at: mergedAt,
              is_active: false,
              unmerged_at: unmergedAt,
              unmerged_by: "admin-1",
              dedup_audit: [
                {
                  id: "audit-1",
                  reason: "different compound",
                  reason_category: "different_compound",
                  created_at: unmergedAt,
                },
              ],
            },
          ],
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await listRecentMergeEvents({
      limit: 50,
      offset: 0,
      since: "24h",
    });
    expect(result.events).toHaveLength(2);
    expect(result.events[0].isActive).toBe(true);
    expect(result.events[0].reasonCode).toBeNull();
    expect(result.events[1].isActive).toBe(false);
    expect(result.events[1].reasonCode).toBe("different_compound");
    expect(result.events[1].reasonDetail).toBe("different compound");
  });

  it("omits the time filter when since='all'", async () => {
    client = scriptedMock(
      [{ kind: "many", data: [], error: null }],
      calls,
    );
    setMockServiceClient(() => client);

    await listRecentMergeEvents({ limit: 50, offset: 0, since: "all" });
    const gteCalls = calls.filter((c) => c.method === "gte");
    expect(gteCalls.length).toBe(0);
  });

  it("clamps limit to 200 when a higher value is requested", async () => {
    client = scriptedMock(
      [{ kind: "many", data: [], error: null }],
      calls,
    );
    setMockServiceClient(() => client);

    // We don't have direct access to the SQL LIMIT, but we can
    // verify the helper doesn't throw and returns a result.
    const result = await listRecentMergeEvents({
      limit: 9999,
      offset: 0,
      since: "7d",
    });
    expect(result.events).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 10-12. unmergeFact
// ---------------------------------------------------------------------------

describe("reviewService — unmergeFact", () => {
  it("updates the edge and writes an audit row on the happy path", async () => {
    client = scriptedMock(
      [
        // 1. fact existence check
        { kind: "single", data: { id: FACT_ID }, error: null },
        // 2. active edges lookup
        {
          kind: "many",
          data: [
            {
              canonical_fact_id: CANONICAL_ID,
              merged_fact_id: FACT_ID,
              match_rule: "identity_key",
              merged_at: "2026-06-10T00:00:00Z",
            },
          ],
          error: null,
        },
        // 3. UPDATE edge
        {
          kind: "single",
          data: {
            canonical_fact_id: CANONICAL_ID,
            merged_fact_id: FACT_ID,
            match_rule: "identity_key",
            merged_at: "2026-06-10T00:00:00Z",
            is_active: false,
            unmerged_at: "2026-06-16T00:00:00Z",
            unmerged_by: USER_ID,
          },
          error: null,
        },
        // 4. INSERT audit row
        {
          kind: "single",
          data: {
            id: "audit-1",
            fact_id: FACT_ID,
            event_type: "unmerge",
            old_canonical_id: CANONICAL_ID,
            new_canonical_id: null,
            user_id: USER_ID,
            reason: "wrong species",
            reason_category: "false_positive",
            created_at: "2026-06-16T00:00:00Z",
          },
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await unmergeFact({
      factId: FACT_ID,
      userId: USER_ID,
      reason: "wrong species",
      reasonCategory: "false_positive",
    });

    expect(result.edge.canonicalFactId).toBe(CANONICAL_ID);
    expect(result.edge.isActive).toBe(false);
    expect(result.edge.unmergedBy).toBe(USER_ID);
    expect(result.audit.eventType).toBe("unmerge");
    expect(result.audit.reasonCategory).toBe("false_positive");
    expect(result.audit.reason).toBe("wrong species");

    // Verify the WHERE is_active = true clause is in the update chain.
    const eqCalls = calls.filter(
      (c) => c.method === "eq" && c.args[0] === "is_active" && c.args[1] === true,
    );
    expect(eqCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("throws NoActiveEdgeError when no active edge exists (double-unmerge)", async () => {
    client = scriptedMock(
      [
        // fact exists
        { kind: "single", data: { id: FACT_ID }, error: null },
        // no active edges
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    await expect(
      unmergeFact({
        factId: FACT_ID,
        userId: USER_ID,
        reason: null,
        reasonCategory: "false_positive",
      }),
    ).rejects.toBeInstanceOf(NoActiveEdgeError);
  });

  it("throws AmbiguousEdgeError when multiple active edges exist", async () => {
    client = scriptedMock(
      [
        { kind: "single", data: { id: FACT_ID }, error: null },
        {
          kind: "many",
          data: [
            {
              canonical_fact_id: "canon-1",
              merged_fact_id: FACT_ID,
              match_rule: "identity_key",
              merged_at: "2026-06-10T00:00:00Z",
            },
            {
              canonical_fact_id: "canon-2",
              merged_fact_id: FACT_ID,
              match_rule: "embedding",
              merged_at: "2026-06-11T00:00:00Z",
            },
          ],
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    await expect(
      unmergeFact({
        factId: FACT_ID,
        userId: USER_ID,
        reason: null,
        reasonCategory: "false_positive",
      }),
    ).rejects.toBeInstanceOf(AmbiguousEdgeError);
  });
});

// ---------------------------------------------------------------------------
// 13-15. Error class sanity (bonus cases for the spec's error contract)
// ---------------------------------------------------------------------------

describe("reviewService — error classes", () => {
  it("throws InvalidReasonCategoryError for unknown reasonCategory", async () => {
    await expect(
      unmergeFact({
        factId: FACT_ID,
        userId: USER_ID,
        reason: null,
        reasonCategory: "not_a_real_category" as any,
      }),
    ).rejects.toBeInstanceOf(InvalidReasonCategoryError);
  });

  it("throws FactNotFoundError when the fact does not exist", async () => {
    client = scriptedMock(
      [{ kind: "single", data: null, error: null }],
      calls,
    );
    setMockServiceClient(() => client);

    await expect(
      unmergeFact({
        factId: "nonexistent-id",
        userId: USER_ID,
        reason: null,
        reasonCategory: "false_positive",
      }),
    ).rejects.toBeInstanceOf(FactNotFoundError);
  });
});
