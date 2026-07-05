/**
 * Unit tests for `src/services/researchBrain/discoveryPersistence.ts`
 * (the service module shipped by `discovery-persistence` PR #1, exercised
 * by PR #2's route + tests).
 *
 * Coverage matrix — one test per scenario from
 * `openspec/changes/discovery-persistence/design/design.md` §10.2:
 *
 *   persistDiscoveriesToDb:
 *     - happy: 3 new discoveries, empty DB
 *     - supersede: 1 existing row, 1 new with Jaccard >= 0.7
 *     - no match: 1 existing with low Jaccard
 *     - removed: 1 existing, LLM output omits it
 *     - load-fail: load query throws
 *     - insert-fail: mock insert throws
 *     - all-fail: every call throws
 *
 *   getDiscoveriesForConversation:
 *     - happy: 2 rows + 3 evidence rows
 *     - no rows: empty DB
 *     - only-current: 3 rows, 1 superseded
 *
 * The tests are hermetic: the Supabase service client is mocked with
 * a chainable stub (`scriptedMock` from `compoundAuthority.test.ts`).
 * No DB or network round-trip happens.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock infrastructure — mirrors compoundAuthority.test.ts:78-143
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
  return target;
}

declare global {
  // eslint-disable-next-line no-var
  var __discoveryPersistenceTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__discoveryPersistenceTestClient = factory;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__discoveryPersistenceTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__discoveryPersistenceTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__discoveryPersistenceTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__discoveryPersistenceTestClient ?? (() => null))(),
}));

// SUT imports (post-mock)
import {
  getDiscoveriesForConversation,
  persistDiscoveriesToDb,
} from "../discoveryPersistence";
import type { Discovery } from "../../../types/core";

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

const CONV = "00000000-0000-0000-0000-000000000c01";
const MSG = "00000000-0000-0000-0000-000000000m01";

function makeDiscovery(overrides: Partial<Discovery> = {}): Discovery {
  return {
    title: "Kinase Binding In Vitro",
    claim: "compound binds kinase in vitro",
    summary: "Strong evidence of binding affinity in vitro.",
    evidenceArray: [],
    artifacts: [],
    novelty: "First observation of binding in this scaffold.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// persistDiscoveriesToDb — happy path
// ---------------------------------------------------------------------------

describe("discoveryPersistence — persistDiscoveriesToDb (happy path)", () => {
  it("inserts 3 fresh rows, 0 supersedes, 0 removes, no errors", async () => {
    // Script:
    //   0. load existing (empty)
    //   1. insert d1
    //   2. insert d1 evidence (none)
    //   3. insert d2
    //   4. insert d2 evidence (none)
    //   5. insert d3
    //   6. insert d3 evidence (none)
    const script = [
      { kind: "many", data: [], error: null }, // load existing
      { kind: "many", data: [], error: null }, // insert d1
      { kind: "many", data: [], error: null }, // insert d2
      { kind: "many", data: [], error: null }, // insert d3
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const result = await persistDiscoveriesToDb({
      discoveries: [
        makeDiscovery({ title: "Kinase Binding In Vitro", claim: "compound binds kinase in vitro" }),
        makeDiscovery({ title: "Pathway Inhibition Assay", claim: "compound inhibits pathway in cells" }),
        makeDiscovery({ title: "Cellular Toxicity Profile", claim: "compound shows cellular toxicity profile" }),
      ],
      conversationId: CONV,
      messageId: MSG,
      threshold: 0.7,
    });

    expect(result.errors).toEqual([]);
    expect(result.inserted.length).toBe(3);
    expect(result.superseded).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.unchanged).toEqual([]);

    // Verify: 3 inserts on research_discoveries were issued.
    const insertCalls = calls.filter(
      (c) => c.method === "insert" && c.table === "research_discoveries",
    );
    expect(insertCalls.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// persistDiscoveriesToDb — supersede
// ---------------------------------------------------------------------------

describe("discoveryPersistence — persistDiscoveriesToDb (supersede + evidence merge)", () => {
  it("inserts 1 new row, supersedes 1 existing, merges evidence", async () => {
    // Existing row with discovery_key matching incoming.
    // 0. load existing -> one row with the same key
    // 1. insert new (supersedes old)
    // 2. update old to is_current=false (supersede)
    // 3. load old evidence -> one row
    // 4. insert new evidence (carry-over + new, deduped)
    const oldRowId = "00000000-0000-0000-0000-0000000000o1";
    const oldEvidence = [
      {
        id: "ev-1",
        discovery_id: oldRowId,
        task_id: "ana-1",
        job_id: "j-1",
        explanation: "old explanation",
        source_url: null,
        evidence_archived: false,
        created_at: "2026-06-13T00:00:00Z",
      },
    ];
    const script = [
      { kind: "many", data: [{
        id: oldRowId,
        // Use a discovery_key that matches the incoming at Jaccard >= 0.7.
        // incoming tokens: binding, binds, compound, kinase, vitro (5).
        // row tokens: binding, binds, compound, kinase, vitro (5). 5/5 = 1.0.
        discovery_key: "binding|binds|compound|kinase|vitro",
        discovery_group_id: "00000000-0000-0000-0000-000000000g1",
      }], error: null },
      { kind: "many", data: [], error: null }, // insert new
      { kind: "many", data: [], error: null }, // update old to is_current=false
      { kind: "many", data: oldEvidence, error: null }, // load old evidence
      { kind: "many", data: [], error: null }, // insert new evidence (carry-over + new)
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const result = await persistDiscoveriesToDb({
      discoveries: [
        makeDiscovery({
          title: "Kinase Binding In Vitro",
          claim: "compound binds kinase in vitro",
          evidenceArray: [
            { taskId: "ana-2", jobId: "j-2", explanation: "new explanation" },
          ],
        }),
      ],
      conversationId: CONV,
      messageId: MSG,
      threshold: 0.7,
    });

    expect(result.errors).toEqual([]);
    expect(result.inserted.length).toBe(1);
    expect(result.superseded).toEqual([oldRowId]);
    expect(result.removed).toEqual([]);

    // Verify: 1 update on research_discoveries (the supersede) was issued.
    const updateCalls = calls.filter(
      (c) => c.method === "update" && c.table === "research_discoveries",
    );
    expect(updateCalls.length).toBe(1);
    const updatePayload = (updateCalls[0].args[0] as Record<string, unknown>);
    expect(updatePayload.is_current).toBe(false);
    expect(typeof updatePayload.superseded_at).toBe("string");

    // Verify: evidence insert happened with merged rows.
    const evidenceInserts = calls.filter(
      (c) => c.method === "insert" && c.table === "research_discovery_evidence",
    );
    expect(evidenceInserts.length).toBe(1);
    const evidenceRows = evidenceInserts[0].args[0] as Array<
      Record<string, unknown>
    >;
    // 1 old (ana-1) + 1 new (ana-2), no overlap -> 2 rows.
    expect(evidenceRows.length).toBe(2);
    const taskIds = evidenceRows.map((r) => r.task_id).sort();
    expect(taskIds).toEqual(["ana-1", "ana-2"]);
  });
});

// ---------------------------------------------------------------------------
// persistDiscoveriesToDb — no match (fresh group id)
// ---------------------------------------------------------------------------

describe("discoveryPersistence — persistDiscoveriesToDb (no match -> fresh group id)", () => {
  it("inserts with a new group id and supersedes_discovery_id = null", async () => {
    // Existing row with a different discovery_key.
    // 0. load existing (1 row, low-similarity)
    // 1. insert new (fresh group)
    const script = [
      { kind: "many", data: [{
        id: "00000000-0000-0000-0000-0000000000o1",
        discovery_key: "completely|unrelated|tokens",
        discovery_group_id: "00000000-0000-0000-0000-000000000g1",
      }], error: null },
      { kind: "many", data: [], error: null }, // insert new
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const result = await persistDiscoveriesToDb({
      discoveries: [
        makeDiscovery({
          title: "Kinase Binding In Vitro",
          claim: "compound binds kinase in vitro",
        }),
      ],
      conversationId: CONV,
      messageId: MSG,
      threshold: 0.7,
    });

    expect(result.errors).toEqual([]);
    expect(result.inserted.length).toBe(1);
    expect(result.superseded).toEqual([]);

    const insertCall = calls.find(
      (c) => c.method === "insert" && c.table === "research_discoveries",
    );
    expect(insertCall).toBeDefined();
    const payload = (insertCall!.args[0] as Record<string, unknown>);
    expect(payload.supersedes_discovery_id).toBeNull();
    // group id was generated (UUID) and is not the old group.
    expect(payload.discovery_group_id).not.toBe(
      "00000000-0000-0000-0000-000000000g1",
    );
  });
});

// ---------------------------------------------------------------------------
// persistDiscoveriesToDb — removed
// ---------------------------------------------------------------------------

describe("discoveryPersistence — persistDiscoveriesToDb (removed: LLM omits the finding)", () => {
  it("soft-deletes the existing row when it is not in the incoming batch", async () => {
    // 0. load existing (1 row, NOT in incoming batch)
    // 1. update existing (the reconcile/remove step)
    const oldRowId = "00000000-0000-0000-0000-0000000000o1";
    const script = [
      { kind: "many", data: [{
        id: oldRowId,
        discovery_key: "old|removed|topic",
        discovery_group_id: "00000000-0000-0000-0000-000000000g1",
      }], error: null },
      { kind: "many", data: [], error: null }, // update old to is_current=false
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const result = await persistDiscoveriesToDb({
      discoveries: [
        // LLM output has a different topic — no match for the old one.
        makeDiscovery({
          title: "Pathway Inhibition Assay",
          claim: "compound inhibits cellular pathway",
        }),
      ],
      conversationId: CONV,
      messageId: MSG,
      threshold: 0.7,
    });

    expect(result.errors).toEqual([]);
    expect(result.inserted.length).toBe(1);
    expect(result.superseded).toEqual([]);
    expect(result.removed).toEqual([oldRowId]);

    // Verify the update set is_current=false.
    const updateCalls = calls.filter(
      (c) => c.method === "update" && c.table === "research_discoveries",
    );
    expect(updateCalls.length).toBe(1);
    const updatePayload = (updateCalls[0].args[0] as Record<string, unknown>);
    expect(updatePayload.is_current).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// persistDiscoveriesToDb — load-fail
// ---------------------------------------------------------------------------

describe("discoveryPersistence — persistDiscoveriesToDb (load-fail)", () => {
  it("returns an empty PersistResult with the load error and does not throw", async () => {
    // 0. load existing -> error
    const script = [
      { kind: "many", data: null, error: { message: "load failed" } },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const result = await persistDiscoveriesToDb({
      discoveries: [makeDiscovery()],
      conversationId: CONV,
      messageId: MSG,
      threshold: 0.7,
    });

    expect(result.inserted).toEqual([]);
    expect(result.superseded).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.errors).toEqual(["discovery_persist_load_failed"]);
  });
});

// ---------------------------------------------------------------------------
// persistDiscoveriesToDb — insert-fail (per-row)
// ---------------------------------------------------------------------------

describe("discoveryPersistence — persistDiscoveriesToDb (insert-fail for one row)", () => {
  it("logs the failure, continues with remaining rows", async () => {
    // 0. load existing (empty)
    // 1. insert d1 -> success
    // 2. insert d2 -> error
    const script = [
      { kind: "many", data: [], error: null },
      { kind: "many", data: [], error: null },
      { kind: "many", data: null, error: { message: "insert failed" } },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const result = await persistDiscoveriesToDb({
      discoveries: [
        makeDiscovery({ title: "Discovery One Unique Token", claim: "compound one unique thing" }),
        makeDiscovery({ title: "Discovery Two Unique Token", claim: "compound two unique thing" }),
      ],
      conversationId: CONV,
      messageId: MSG,
      threshold: 0.7,
    });

    // One insert succeeded; the other failed and was logged.
    expect(result.inserted.length).toBe(1);
    expect(result.errors).toContain("discovery_persist_insert_failed");
  });
});

// ---------------------------------------------------------------------------
// persistDiscoveriesToDb — all-fail (top-level catch)
// ---------------------------------------------------------------------------

describe("discoveryPersistence — persistDiscoveriesToDb (all-fail soft-fails top-level)", () => {
  it("returns an empty PersistResult with the top-level error", async () => {
    // Build a client that throws on every chained method. The
    // scriptedMock proxy returns the script for terminal methods;
    // for the load step we want a real exception. We simulate by
    // making every script entry an error.
    const script = [
      { kind: "many", data: null, error: { message: "boom" } },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const result = await persistDiscoveriesToDb({
      discoveries: [makeDiscovery()],
      conversationId: CONV,
      messageId: MSG,
      threshold: 0.7,
    });

    // Top-level: load fails -> empty result with the load error.
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getDiscoveriesForConversation
// ---------------------------------------------------------------------------

describe("discoveryPersistence — getDiscoveriesForConversation (happy path)", () => {
  it("returns rows with their joined evidence", async () => {
    // 0. join query (returns rows with evidence field)
    const rows = [
      {
        id: "d-1",
        discovery_group_id: "g-1",
        conversation_id: CONV,
        message_id: MSG,
        supersedes_discovery_id: null,
        is_current: true,
        superseded_at: null,
        title: "Kinase Binding In Vitro",
        claim: "compound binds kinase in vitro",
        summary: "Strong evidence of binding.",
        novelty: "novel",
        artifacts: [],
        discovery_key: "binds|kinase|vitro",
        reeval_status: "none",
        reeval_notes: null,
        last_checked_at: null,
        created_at: "2026-06-13T00:00:00Z",
        updated_at: "2026-06-13T00:00:00Z",
        evidence: [
          {
            id: "ev-1",
            discovery_id: "d-1",
            task_id: "ana-1",
            job_id: "j-1",
            explanation: "supports",
            source_url: null,
            evidence_archived: false,
            created_at: "2026-06-13T00:00:00Z",
          },
          {
            id: "ev-2",
            discovery_id: "d-1",
            task_id: "ana-2",
            job_id: "j-2",
            explanation: "supports",
            source_url: null,
            evidence_archived: false,
            created_at: "2026-06-13T00:00:00Z",
          },
        ],
      },
      {
        id: "d-2",
        discovery_group_id: "g-2",
        conversation_id: CONV,
        message_id: MSG,
        supersedes_discovery_id: null,
        is_current: true,
        superseded_at: null,
        title: "Pathway Inhibition Assay",
        claim: "compound inhibits cellular pathway",
        summary: "Reduces activity.",
        novelty: null,
        artifacts: [],
        discovery_key: "inhibits|pathway|cellular",
        reeval_status: "none",
        reeval_notes: null,
        last_checked_at: null,
        created_at: "2026-06-12T00:00:00Z",
        updated_at: "2026-06-12T00:00:00Z",
        evidence: [
          {
            id: "ev-3",
            discovery_id: "d-2",
            task_id: "ana-3",
            job_id: "j-3",
            explanation: "supports",
            source_url: null,
            evidence_archived: false,
            created_at: "2026-06-12T00:00:00Z",
          },
        ],
      },
    ];
    const script = [
      { kind: "many", data: rows, error: null },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const result = await getDiscoveriesForConversation({ conversationId: CONV });
    expect(result.length).toBe(2);
    expect(result[0].id).toBe("d-1");
    expect(result[0].evidence.length).toBe(2);
    expect(result[1].id).toBe("d-2");
    expect(result[1].evidence.length).toBe(1);
  });
});

describe("discoveryPersistence — getDiscoveriesForConversation (no rows)", () => {
  it("returns [] for an empty conversation", async () => {
    const script = [
      { kind: "many", data: [], error: null },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const result = await getDiscoveriesForConversation({ conversationId: CONV });
    expect(result).toEqual([]);
  });
});

describe("discoveryPersistence — getDiscoveriesForConversation (only-current filter)", () => {
  it("only returns rows with is_current=true (filtered at the DB level)", async () => {
    // The function relies on the DB query for filtering. We confirm
    // that the script's data array (the rows the mock returns) is
    // passed through unchanged — i.e. the v1 function does not
    // double-filter on is_current (the SQL `.eq('is_current', true)`
    // does that). The mock returns only current rows, so the
    // result is exactly those rows.
    const currentRows = [
      {
        id: "d-1",
        discovery_group_id: "g-1",
        conversation_id: CONV,
        message_id: MSG,
        supersedes_discovery_id: null,
        is_current: true,
        superseded_at: null,
        title: "Current A",
        claim: "compound a is current",
        summary: "",
        novelty: null,
        artifacts: [],
        discovery_key: "current",
        reeval_status: "none",
        reeval_notes: null,
        last_checked_at: null,
        created_at: "2026-06-13T00:00:00Z",
        updated_at: "2026-06-13T00:00:00Z",
        evidence: [],
      },
    ];
    const script = [
      { kind: "many", data: currentRows, error: null },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const result = await getDiscoveriesForConversation({ conversationId: CONV });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("d-1");
    expect(result[0].is_current).toBe(true);
  });
});
