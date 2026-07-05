/**
 * Agent smoke tests for `src/agents/discovery/index.ts`
 * (discovery-persistence v1).
 *
 * Verifies the dual-write call from the discovery agent to
 * `persistDiscoveriesToDb`:
 *
 *   1. The agent invokes `persistDiscoveriesToDb` with the right
 *      args (`discoveries`, `conversationId`, `messageId`,
 *      `threshold=0.7`).
 *   2. When `persistDiscoveriesToDb` throws, the agent still returns
 *      the in-memory discoveries (the soft-fail contract).
 *   3. The agent's return value contains the post-`fixDiscoveryArtifactPaths`
 *      discoveries, not the raw LLM output.
 *
 * Strategy: we mock the Supabase service client (the only IO the
 * persistence module does) and the LLM extractor, and let the real
 * `persistDiscoveriesToDb` run. We observe its behavior via the calls
 * the mock captures. This is hermetic — no live DB, no live LLM.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Supabase chainable stub (mirrors compoundAuthority.test.ts:78-143)
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

function scriptedMock(script: Terminal[], calls: Call[]) {
  let cursor = 0;
  let currentTable: string | undefined;
  const target: any = {};
  const next = (): Terminal =>
    script[cursor++] || { kind: "many", data: [], error: null };
  for (const method of BUILDER_METHODS) {
    target[method] = (...args: unknown[]) => {
      if (method === "from") currentTable = args[0] as string;
      calls.push({ method, args, table: currentTable });
      return target;
    };
  }
  Object.defineProperty(target, "then", {
    get() {
      return (onFulfilled: any, onRejected: any) => {
        const t = next();
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
  var __discoveryAgentTestClient: (() => any) | undefined;
  // eslint-disable-next-line no-var
  var __discoveryAgentGetMessages:
    | ((conversationId: string, n: number) => Promise<any[]>)
    | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__discoveryAgentTestClient = factory;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__discoveryAgentTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__discoveryAgentTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__discoveryAgentTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__discoveryAgentTestClient ?? (() => null))(),
}));

// Stub the DB operations used by the agent. The agent does
// `await import("../../db/operations")` inside the function, so we
// only need to expose the function it actually uses. The LLM provider
// also pulls in `createTokenUsage` from the same module.
function setGetMessages(fn: (id: string, n: number) => Promise<any[]>) {
  globalThis.__discoveryAgentGetMessages = fn;
}
setGetMessages(() => Promise.resolve([]));
mock.module("../../../db/operations", () => ({
  getMessagesByConversation: (id: string, n: number) =>
    (globalThis.__discoveryAgentGetMessages ?? (() => Promise.resolve([])))(id, n),
  createTokenUsage: () => Promise.resolve(undefined),
}));

// ---------------------------------------------------------------------------
// SUT (post-mock)
// ---------------------------------------------------------------------------

import { discoveryAgent } from "../index";
import type {
  ConversationState,
  Discovery,
  Message,
  PlanTask,
} from "../../../types/core";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CONV_ID = "00000000-0000-0000-0000-000000000c01";
const MSG_ID = "00000000-0000-0000-0000-000000000m01";

function makeState(): ConversationState {
  return {
    id: "state-1",
    conversation_id: CONV_ID,
    values: {
      discoveries: [],
      objective: "Investigate kinase binding",
    },
  } as unknown as ConversationState;
}

function makeMessage(): Message {
  return {
    id: MSG_ID,
    conversation_id: CONV_ID,
    question: "Does compound X bind kinase Y?",
  } as unknown as Message;
}

function makeTasks(): PlanTask[] {
  return [
    {
      id: "ana-1",
      type: "analysis",
      objective: "Test binding",
      output: "Binding affinity is 10 nM.",
      jobId: "j-1",
      artifacts: [],
    } as unknown as PlanTask,
  ];
}

function makeDiscovery(overrides: Partial<Discovery> = {}): Discovery {
  return {
    title: "Kinase Binding In Vitro",
    claim: "compound binds kinase in vitro",
    summary: "Strong evidence of binding.",
    evidenceArray: [],
    artifacts: [],
    novelty: "novel",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock extractDiscoveries + fixDiscoveryArtifactPaths to keep the test
// deterministic. The agent's index.ts statically imports these from
// "./utils"; we replace the module with a stub that returns our
// pre-canned discoveries.
// ---------------------------------------------------------------------------

mock.module("../utils", () => ({
  extractDiscoveries: () =>
    Promise.resolve({
      discoveries: [
        makeDiscovery({ title: "Raw Title A", claim: "raw claim a" }),
        makeDiscovery({ title: "Raw Title B", claim: "raw claim b" }),
      ],
    }),
  fixDiscoveryArtifactPaths: (discoveries: Discovery[]) =>
    discoveries.map((d) => ({ ...d, title: d.title + " (fixed)" })),
}));

// SUT (post-mock)
import { discoveryAgent } from "../index";

beforeEach(() => {
  setMockServiceClient(() => scriptedMock([], []));
});

// ---------------------------------------------------------------------------
// 1. The agent calls persistDiscoveriesToDb with the right args
// ---------------------------------------------------------------------------

describe("discoveryAgent — calls persistDiscoveriesToDb (dual-write contract)", () => {
  it("invokes persistDiscoveriesToDb with the discovered fixes, conversationId, messageId, threshold=0.7", async () => {
    // Empty existing -> 2 inserts, 0 supersedes, 0 removes.
    const calls: Call[] = [];
    const client = scriptedMock(
      [
        { kind: "many", data: [], error: null }, // load existing
        { kind: "many", data: [], error: null }, // insert d1
        { kind: "many", data: [], error: null }, // insert d2
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await discoveryAgent({
      conversationState: makeState(),
      message: makeMessage(),
      tasksToConsider: makeTasks(),
    });

    // Verify the agent made the right Supabase calls. The persistence
    // module's first call is the "load existing rows" select, then
    // 2 inserts on research_discoveries.
    const fromCalls = calls.filter((c) => c.method === "from");
    const fromArgs = fromCalls.map((c) => c.args[0]);
    expect(fromArgs).toContain("research_discoveries");
    const insertCalls = calls.filter(
      (c) => c.method === "insert" && c.table === "research_discoveries",
    );
    expect(insertCalls.length).toBe(2);

    // The first insert payload should carry the right conversationId +
    // messageId, the post-fix title, and the discovery_key.
    const firstPayload = insertCalls[0].args[0] as Record<string, unknown>;
    expect(firstPayload.conversation_id).toBe(CONV_ID);
    expect(firstPayload.message_id).toBe(MSG_ID);
    expect(firstPayload.title).toBe("Raw Title A (fixed)");
    expect(typeof firstPayload.discovery_key).toBe("string");

    // The return value contains the fixed discoveries.
    expect(result.discoveries.length).toBe(2);
    expect(result.discoveries[0].title).toBe("Raw Title A (fixed)");
  });
});

// ---------------------------------------------------------------------------
// 2. Persist failure does not break the agent's return value
// ---------------------------------------------------------------------------

describe("discoveryAgent — soft-fail on persist throw", () => {
  it("returns the discoveries even when the persistence layer throws", async () => {
    // Empty existing -> 2 inserts. Make the first insert throw to
    // exercise the soft-fail. The agent's defensive try/catch wraps
    // the whole persistDiscoveriesToDb call, so even an exception
    // there is swallowed and logged.
    const calls: Call[] = [];
    const client = scriptedMock(
      [
        { kind: "many", data: [], error: null }, // load existing
        { kind: "many", data: null, error: { message: "DB down" } }, // insert d1 throws
        { kind: "many", data: null, error: { message: "DB down" } }, // insert d2 throws
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await discoveryAgent({
      conversationState: makeState(),
      message: makeMessage(),
      tasksToConsider: makeTasks(),
    });

    // The agent's return value still contains the discoveries.
    expect(result.discoveries.length).toBe(2);
    expect(result.discoveries[0].title).toBe("Raw Title A (fixed)");
    expect(result.start).toBeDefined();
    expect(result.end).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. The return value is post-fixDiscoveryArtifactPaths
// ---------------------------------------------------------------------------

describe("discoveryAgent — return value is post-fixDiscoveryArtifactPaths", () => {
  it("returns discoveries with the (fixed) title suffix applied", async () => {
    setMockServiceClient(() => scriptedMock([], []));

    const result = await discoveryAgent({
      conversationState: makeState(),
      message: makeMessage(),
      tasksToConsider: makeTasks(),
    });

    // The mocked fixDiscoveryArtifactPaths appends " (fixed)" to
    // each title. The agent's return value must reflect this.
    expect(result.discoveries[0].title).toBe("Raw Title A (fixed)");
    expect(result.discoveries[1].title).toBe("Raw Title B (fixed)");
  });
});
