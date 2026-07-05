/**
 * Unit tests for the read-through layer of discovery-persistence PR #2.
 *
 * The read-through layer (`loadDiscoveriesForConversation` +
 * `dbDiscoveriesToDomain` + `normalizedKey`) replaces the JSONB read
 * path for downstream consumers. v1 (PR #1) shipped the dual-write;
 * v2 (this PR) ships the read-through so we stop reading from
 * `conversation_states.values.discoveries` and start reading from
 * `research_discoveries` (+ evidence join).
 *
 * Coverage matrix:
 *
 *   Pure helpers (no IO):
 *     1.  dbDiscoveriesToDomain: basic shape conversion
 *     2.  dbDiscoveriesToDomain: evidence deduped by task_id
 *     3.  dbDiscoveriesToDomain: novelty=null -> ""
 *     4.  dbDiscoveriesToDomain: artifacts preserved
 *     5.  normalizedKey: NFKD + lowercase + alnum collapse
 *     6.  normalizedKey: equivalent title+claim set -> same key
 *
 *   loadDiscoveriesForConversation (mocked DB):
 *     7.  source="jsonb" -> never queries DB
 *     8.  source="db" + DB has rows -> returns DB shape
 *     9.  source="db" + DB empty -> falls back to JSONB (dbWasEmpty=true)
 *    10.  source="db" + DB throws -> falls back to JSONB
 *    11.  source="dual" + match -> returns DB, dualComparison shows match
 *    12.  source="dual" + mismatch -> returns DB, logs discovery_read_mismatch
 *    13.  source defaults to env var DISCOVERY_READ_SOURCE
 *    14.  source defaults to "db" when env var is unset or invalid
 *
 * The tests are hermetic: the Supabase service client is mocked with
 * a chainable stub (same pattern as compoundAuthority.test.ts).
 */

import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";

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
  var __readThroughTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__readThroughTestClient = factory;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__readThroughTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__readThroughTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__readThroughTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () => (globalThis.__readThroughTestClient ?? (() => null))(),
}));

import {
  loadDiscoveriesForConversation,
  dbDiscoveriesToDomain,
  normalizedKey,
  type ResearchDiscoveryWithEvidence,
} from "../discoveryPersistence";
import type { Discovery } from "../../../types/core";

let calls: Call[];
let client: any;

beforeEach(() => {
  calls = [];
  client = scriptedMock([], calls);
  setMockServiceClient(() => client);
  // Reset env between tests so DISCOVERY_READ_SOURCE doesn't leak
  // between cases.
  delete process.env.DISCOVERY_READ_SOURCE;
});

afterEach(() => {
  delete process.env.DISCOVERY_READ_SOURCE;
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("dbDiscoveriesToDomain — pure shape conversion", () => {
  it("maps DB columns to the Discovery consumer shape", () => {
    const rows: ResearchDiscoveryWithEvidence[] = [
      {
        id: "d1",
        discovery_group_id: "g1",
        conversation_id: "c1",
        message_id: "m1",
        supersedes_discovery_id: null,
        is_current: true,
        superseded_at: null,
        title: "Anthoteibinene J inhibits Candida albicans",
        claim: "IC50 7.7-9.1 ug/mL",
        summary: "Tested in marine paper X",
        novelty: "First report",
        artifacts: [
          { id: "a1", description: "Figure 1", type: "FILE", name: "fig1.png" },
        ],
        discovery_key: "k1",
        reeval_status: "none",
        reeval_notes: null,
        last_checked_at: null,
        created_at: "2026-06-19T00:00:00Z",
        updated_at: "2026-06-19T00:00:00Z",
        evidence: [
          {
            id: "e1",
            discovery_id: "d1",
            task_id: "lit-1",
            job_id: "j1",
            explanation: "supports",
            source_url: null,
            evidence_archived: false,
            created_at: "2026-06-19T00:00:00Z",
          },
        ],
      },
    ];
    const out = dbDiscoveriesToDomain(rows);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Anthoteibinene J inhibits Candida albicans");
    expect(out[0].claim).toBe("IC50 7.7-9.1 ug/mL");
    expect(out[0].summary).toBe("Tested in marine paper X");
    expect(out[0].novelty).toBe("First report");
    expect(out[0].evidenceArray).toEqual([
      { taskId: "lit-1", jobId: "j1", explanation: "supports" },
    ]);
    expect(out[0].artifacts).toHaveLength(1);
  });

  it("dedupes evidence by task_id (first row wins)", () => {
    const rows: ResearchDiscoveryWithEvidence[] = [
      {
        id: "d1",
        discovery_group_id: "g1",
        conversation_id: "c1",
        message_id: null,
        supersedes_discovery_id: null,
        is_current: true,
        superseded_at: null,
        title: "T",
        claim: "C",
        summary: "S",
        novelty: null,
        artifacts: [],
        discovery_key: "k1",
        reeval_status: "none",
        reeval_notes: null,
        last_checked_at: null,
        created_at: "2026-06-19T00:00:00Z",
        updated_at: "2026-06-19T00:00:00Z",
        evidence: [
          {
            id: "e1",
            discovery_id: "d1",
            task_id: "lit-1",
            job_id: "j-old",
            explanation: "OLD carry-over",
            source_url: null,
            evidence_archived: false,
            created_at: "2026-06-19T00:00:00Z",
          },
          {
            id: "e2",
            discovery_id: "d1",
            task_id: "lit-1",
            job_id: "j-new",
            explanation: "NEW duplicate",
            source_url: null,
            evidence_archived: false,
            created_at: "2026-06-19T00:00:01Z",
          },
          {
            id: "e3",
            discovery_id: "d1",
            task_id: "ana-1",
            job_id: null,
            explanation: "secondary",
            source_url: null,
            evidence_archived: false,
            created_at: "2026-06-19T00:00:02Z",
          },
        ],
      },
    ];
    const out = dbDiscoveriesToDomain(rows);
    expect(out[0].evidenceArray).toHaveLength(2);
    // First row wins (e1 with j-old).
    expect(out[0].evidenceArray[0]).toEqual({
      taskId: "lit-1",
      jobId: "j-old",
      explanation: "OLD carry-over",
    });
    expect(out[0].evidenceArray[1].taskId).toBe("ana-1");
  });

  it("maps novelty: null -> \"\" and omits jobId when null", () => {
    const rows: ResearchDiscoveryWithEvidence[] = [
      {
        id: "d1",
        discovery_group_id: "g1",
        conversation_id: "c1",
        message_id: null,
        supersedes_discovery_id: null,
        is_current: true,
        superseded_at: null,
        title: "T",
        claim: "C",
        summary: "S",
        novelty: null,
        artifacts: [],
        discovery_key: "k1",
        reeval_status: "none",
        reeval_notes: null,
        last_checked_at: null,
        created_at: "2026-06-19T00:00:00Z",
        updated_at: "2026-06-19T00:00:00Z",
        evidence: [
          {
            id: "e1",
            discovery_id: "d1",
            task_id: "lit-1",
            job_id: null,
            explanation: "x",
            source_url: null,
            evidence_archived: false,
            created_at: "2026-06-19T00:00:00Z",
          },
        ],
      },
    ];
    const out = dbDiscoveriesToDomain(rows);
    expect(out[0].novelty).toBe("");
    // jobId should not be present (we don't pass undefined).
    expect("jobId" in out[0].evidenceArray[0]).toBe(false);
  });

  it("preserves the artifacts array (cast through JSONB)", () => {
    const rows: ResearchDiscoveryWithEvidence[] = [
      {
        id: "d1",
        discovery_group_id: "g1",
        conversation_id: "c1",
        message_id: null,
        supersedes_discovery_id: null,
        is_current: true,
        superseded_at: null,
        title: "T",
        claim: "C",
        summary: "S",
        novelty: null,
        artifacts: [
          { id: "a1", description: "d1", type: "FOLDER", name: "n1" },
          { id: "a2", description: "d2", type: "FILE", name: "n2" },
        ],
        discovery_key: "k1",
        reeval_status: "none",
        reeval_notes: null,
        last_checked_at: null,
        created_at: "2026-06-19T00:00:00Z",
        updated_at: "2026-06-19T00:00:00Z",
        evidence: [],
      },
    ];
    const out = dbDiscoveriesToDomain(rows);
    expect(out[0].artifacts).toEqual([
      { id: "a1", description: "d1", type: "FOLDER", name: "n1" },
      { id: "a2", description: "d2", type: "FILE", name: "n2" },
    ]);
  });
});

describe("normalizedKey — pure key generator", () => {
  it("applies NFKD + lowercase + alnum collapse", () => {
    expect(
      normalizedKey("Anthoteibinene J", "IC\u2085\u2080 7.7-9.1 \u00b5g/mL"),
    ).toBe("anthoteibinene j ic50 7 7 9 1 g ml");
  });

  it("produces the same key for equivalent title+claim sets", () => {
    const k1 = normalizedKey("Alpha Compound", "IC50 = 10 uM");
    const k2 = normalizedKey("alpha  compound", "ic50 10 um");
    expect(k1).toBe(k2);
  });
});

// ---------------------------------------------------------------------------
// loadDiscoveriesForConversation — source="jsonb"
// ---------------------------------------------------------------------------

describe("loadDiscoveriesForConversation — source=\"jsonb\"", () => {
  it("returns the JSONB without querying the DB", async () => {
    const jsonb: Discovery[] = [
      {
        title: "T1",
        claim: "C1",
        summary: "S1",
        evidenceArray: [],
        artifacts: [],
        novelty: "",
      },
    ];
    const result = await loadDiscoveriesForConversation({
      conversationId: "c1",
      fallbackDiscoveries: jsonb,
      source: "jsonb",
    });
    expect(result.discoveries).toEqual(jsonb);
    expect(result.source).toBe("jsonb");
    expect(result.dbWasEmpty).toBe(false);
    // No DB query should have been made.
    expect(calls.filter((c) => c.table === "research_discoveries")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadDiscoveriesForConversation — source="db"
// ---------------------------------------------------------------------------

describe("loadDiscoveriesForConversation — source=\"db\"", () => {
  it("returns the DB rows converted to the consumer shape", async () => {
    // Script: getDiscoveriesForConversation does ONE join query
    // (single .then() consumption).
    const dbRows = [
      {
        id: "d1",
        discovery_group_id: "g1",
        conversation_id: "c1",
        message_id: "m1",
        supersedes_discovery_id: null,
        is_current: true,
        superseded_at: null,
        title: "T-DB",
        claim: "C-DB",
        summary: "S-DB",
        novelty: "N-DB",
        artifacts: [],
        discovery_key: "k1",
        reeval_status: "none",
        reeval_notes: null,
        last_checked_at: null,
        created_at: "2026-06-19T00:00:00Z",
        updated_at: "2026-06-19T00:00:00Z",
        evidence: [
          {
            id: "e1",
            discovery_id: "d1",
            task_id: "lit-1",
            job_id: "j1",
            explanation: "supports",
            source_url: null,
            evidence_archived: false,
            created_at: "2026-06-19T00:00:00Z",
          },
        ],
      },
    ];
    client = scriptedMock(
      [{ kind: "many", data: dbRows, error: null }],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await loadDiscoveriesForConversation({
      conversationId: "c1",
      fallbackDiscoveries: [
        {
          title: "T-JSONB",
          claim: "C-JSONB",
          summary: "S-JSONB",
          evidenceArray: [],
          artifacts: [],
          novelty: "",
        },
      ],
      source: "db",
    });
    expect(result.source).toBe("db");
    expect(result.dbWasEmpty).toBe(false);
    expect(result.discoveries).toHaveLength(1);
    expect(result.discoveries[0].title).toBe("T-DB");
    expect(result.discoveries[0].claim).toBe("C-DB");
    expect(result.discoveries[0].evidenceArray[0].taskId).toBe("lit-1");
  });

  it("falls back to JSONB when the DB returns 0 rows", async () => {
    client = scriptedMock([{ kind: "many", data: [], error: null }], calls);
    setMockServiceClient(() => client);

    const jsonb: Discovery[] = [
      {
        title: "T-JSONB",
        claim: "C-JSONB",
        summary: "S-JSONB",
        evidenceArray: [],
        artifacts: [],
        novelty: "",
      },
    ];
    const result = await loadDiscoveriesForConversation({
      conversationId: "c1",
      fallbackDiscoveries: jsonb,
      source: "db",
    });
    expect(result.source).toBe("jsonb");
    expect(result.dbWasEmpty).toBe(true);
    expect(result.discoveries).toEqual(jsonb);
  });

  it("falls back to JSONB when the DB query errors (observed as 0 rows)", async () => {
    // Note: getDiscoveriesForConversation is best-effort and swallows
    // Supabase errors, returning [] on failure. The read-through
    // treats this as "DB empty" and falls back to JSONB. The
    // underlying error is logged inside getDiscoveriesForConversation
    // with event name discovery_get_discoveries_failed. Operators
    // see the gap via that log, not via dbWasEmpty (which is
    // specifically "DB was queried and returned 0 rows").
    client = scriptedMock(
      [{ kind: "many", data: null, error: { message: "boom" } }],
      calls,
    );
    setMockServiceClient(() => client);

    const jsonb: Discovery[] = [
      {
        title: "T-JSONB",
        claim: "C-JSONB",
        summary: "S-JSONB",
        evidenceArray: [],
        artifacts: [],
        novelty: "",
      },
    ];
    const result = await loadDiscoveriesForConversation({
      conversationId: "c1",
      fallbackDiscoveries: jsonb,
      source: "db",
    });
    expect(result.source).toBe("jsonb");
    // The DB call returned no usable rows; the read-through fell
    // back. dbWasEmpty=true is the conservative label here.
    expect(result.dbWasEmpty).toBe(true);
    expect(result.discoveries).toEqual(jsonb);
  });
});

// ---------------------------------------------------------------------------
// loadDiscoveriesForConversation — source="dual"
// ---------------------------------------------------------------------------

describe("loadDiscoveriesForConversation — source=\"dual\"", () => {
  it("returns DB rows and reports a match when DB and JSONB agree", async () => {
    const sameTitle = "T-MATCH";
    const sameClaim = "C-MATCH";
    const dbRows = [
      {
        id: "d1",
        discovery_group_id: "g1",
        conversation_id: "c1",
        message_id: null,
        supersedes_discovery_id: null,
        is_current: true,
        superseded_at: null,
        title: sameTitle,
        claim: sameClaim,
        summary: "S",
        novelty: null,
        artifacts: [],
        discovery_key: "k1",
        reeval_status: "none",
        reeval_notes: null,
        last_checked_at: null,
        created_at: "2026-06-19T00:00:00Z",
        updated_at: "2026-06-19T00:00:00Z",
        evidence: [],
      },
    ];
    client = scriptedMock([{ kind: "many", data: dbRows, error: null }], calls);
    setMockServiceClient(() => client);

    const result = await loadDiscoveriesForConversation({
      conversationId: "c1",
      fallbackDiscoveries: [
        {
          title: sameTitle,
          claim: sameClaim,
          summary: "S",
          evidenceArray: [],
          artifacts: [],
          novelty: "",
        },
      ],
      source: "dual",
    });
    expect(result.source).toBe("db");
    expect(result.dualComparison).not.toBeNull();
    expect(result.dualComparison!.dbCount).toBe(1);
    expect(result.dualComparison!.jsonbCount).toBe(1);
    expect(result.dualComparison!.onlyInDb).toEqual([]);
    expect(result.dualComparison!.onlyInJsonb).toEqual([]);
  });

  it("returns DB rows and logs the diff when DB and JSONB disagree", async () => {
    const dbRows = [
      {
        id: "d1",
        discovery_group_id: "g1",
        conversation_id: "c1",
        message_id: null,
        supersedes_discovery_id: null,
        is_current: true,
        superseded_at: null,
        title: "T-ONLY-IN-DB",
        claim: "C-ONLY-IN-DB",
        summary: "S",
        novelty: null,
        artifacts: [],
        discovery_key: "k1",
        reeval_status: "none",
        reeval_notes: null,
        last_checked_at: null,
        created_at: "2026-06-19T00:00:00Z",
        updated_at: "2026-06-19T00:00:00Z",
        evidence: [],
      },
    ];
    client = scriptedMock([{ kind: "many", data: dbRows, error: null }], calls);
    setMockServiceClient(() => client);

    const result = await loadDiscoveriesForConversation({
      conversationId: "c1",
      fallbackDiscoveries: [
        {
          title: "T-ONLY-IN-JSONB",
          claim: "C-ONLY-IN-JSONB",
          summary: "S",
          evidenceArray: [],
          artifacts: [],
          novelty: "",
        },
      ],
      source: "dual",
    });
    // DB wins.
    expect(result.source).toBe("db");
    expect(result.discoveries[0].title).toBe("T-ONLY-IN-DB");
    // Diff is reported.
    expect(result.dualComparison!.dbCount).toBe(1);
    expect(result.dualComparison!.jsonbCount).toBe(1);
    expect(result.dualComparison!.onlyInDb).toHaveLength(1);
    expect(result.dualComparison!.onlyInJsonb).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Env-driven default
// ---------------------------------------------------------------------------

describe("loadDiscoveriesForConversation — env-driven default", () => {
  it("uses DISCOVERY_READ_SOURCE=jsonb when set", async () => {
    process.env.DISCOVERY_READ_SOURCE = "jsonb";
    const jsonb: Discovery[] = [
      {
        title: "T1",
        claim: "C1",
        summary: "S1",
        evidenceArray: [],
        artifacts: [],
        novelty: "",
      },
    ];
    const result = await loadDiscoveriesForConversation({
      conversationId: "c1",
      fallbackDiscoveries: jsonb,
    });
    expect(result.source).toBe("jsonb");
    // No DB call.
    expect(calls.filter((c) => c.table === "research_discoveries")).toHaveLength(0);
  });

  it("defaults to \"db\" when env var is unset", async () => {
    delete process.env.DISCOVERY_READ_SOURCE;
    // Mock a successful DB read so the test doesn't fall back.
    client = scriptedMock([{ kind: "many", data: [], error: null }], calls);
    setMockServiceClient(() => client);

    const result = await loadDiscoveriesForConversation({
      conversationId: "c1",
      fallbackDiscoveries: [],
    });
    // DB was queried, returned empty, so the result source is
    // "jsonb" (the fallback path), but dbWasEmpty=true confirms
    // the default source was "db".
    expect(result.dbWasEmpty).toBe(true);
  });

  it("falls back to \"db\" when env var is invalid", async () => {
    process.env.DISCOVERY_READ_SOURCE = "not-a-real-mode";
    client = scriptedMock([{ kind: "many", data: [], error: null }], calls);
    setMockServiceClient(() => client);

    const result = await loadDiscoveriesForConversation({
      conversationId: "c1",
      fallbackDiscoveries: [],
    });
    expect(result.dbWasEmpty).toBe(true);
  });
});
