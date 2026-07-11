import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { BioprospectingFact } from "../types";
import * as realLlmCost from "../llm-cost";

/**
 * Tests for the REAL `contradictionLlM` module.
 *
 * The previous version of this file copy-pasted `extractJsonArray`, the
 * validator and the grouping logic INTO the test and asserted against the
 * copies. That is why the id-contract bug shipped and survived: the module
 * asked the LLM for fact UUIDs it never put in the payload, every proposal
 * failed to join, and the run still logged `{ llmInserted: 0 }` as a
 * success. A test that duplicates the implementation cannot catch a
 * contract mismatch — so everything below imports the real module and
 * asserts the real contract:
 *
 *   1. `buildFactsJson` puts each fact's `id` in the payload.
 *   2. A model response referencing REAL ids resolves and inserts.
 *   3. A response referencing UNKNOWN ids is counted as `dropped` and
 *      logged at ERROR level (join-rate failure) — never a silent skip.
 *   4. The LLM tier is gated by its own flag and its cost is recorded.
 */

// ---------------------------------------------------------------------------
// Mocks — installed BEFORE the module under test is imported.
// ---------------------------------------------------------------------------

type UpsertCall = {
  factAId: string;
  factBId: string;
  conflictType: string;
  explanation?: string | null;
  metadata?: Record<string, unknown>;
};

let upsertCalls: UpsertCall[] = [];
let upsertReturnsNull = false;

mock.module("../contradictionDb", () => ({
  upsertBioprospectingContradiction: async (params: UpsertCall) => {
    upsertCalls.push(params);
    return upsertReturnsNull ? null : { id: `contradiction-${upsertCalls.length}` };
  },
}));

let llmPrompts: string[] = [];
let llmResponse: { content: string; usage?: { promptTokens: number; completionTokens: number } } =
  { content: "[]" };
let llmAvailable = true;

mock.module("../llm", () => ({
  resolveResearchBrainLLM: () =>
    llmAvailable
      ? {
          llm: {
            createChatCompletion: async (req: { messages: Array<{ content: string }> }) => {
              llmPrompts.push(req.messages[0].content);
              return llmResponse;
            },
          },
          providerName: "anthropic",
          model: "claude-3-haiku",
        }
      : { llm: null, providerName: null, model: null },
}));

let recordedCalls: Array<{ runId: string; entry: any }> = [];

// Only `recordLlmCall` is stubbed (it would otherwise reach Supabase). The REAL
// `calculateCost` is re-exported: bun's `mock.module` is process-wide, and
// replacing the whole module would silently break `costService.test.ts`, which
// asserts the real pricing math.
mock.module("../llm-cost", () => ({
  ...realLlmCost,
  recordLlmCall: async (runId: string, entry: any) => {
    recordedCalls.push({ runId, entry });
  },
}));

type LogCall = { payload: any; message?: string };
const logCalls: Record<"info" | "error" | "warn" | "debug", LogCall[]> = {
  info: [],
  error: [],
  warn: [],
  debug: [],
};

function capture(level: keyof typeof logCalls) {
  return (payload?: any, message?: string) => {
    if (typeof payload === "string") logCalls[level].push({ payload: {}, message: payload });
    else logCalls[level].push({ payload, message });
  };
}

mock.module("../../../utils/logger", () => ({
  default: {
    info: capture("info"),
    error: capture("error"),
    warn: capture("warn"),
    debug: capture("debug"),
  },
}));

import {
  buildFactsJson,
  extractJsonArray,
  isLLMContradiction,
  mapLLMContradictionType,
  runLLMDetection,
  JOIN_RATE_ERROR_THRESHOLD,
} from "../contradictionLlM";

// ---------------------------------------------------------------------------
// Fixtures — two facts in the SAME compound|bioactivity group, with real
// UUID-shaped ids (the join key the whole contract hangs on).
// ---------------------------------------------------------------------------

const FACT_A_ID = "11111111-1111-1111-1111-111111111111";
const FACT_B_ID = "22222222-2222-2222-2222-222222222222";
const UNKNOWN_ID = "99999999-9999-9999-9999-999999999999";

function makeFact(overrides: Partial<BioprospectingFact>): BioprospectingFact {
  return {
    id: FACT_A_ID,
    source_id: "source-1",
    status: "supported",
    confidence: "medium",
    compound: "Bryostatin",
    bioactivity: "PKC",
    measurement_direction: "agonist",
    relation_type: "activates",
    result_summary: "Bryostatin activates PKC",
    page: 3,
    source: { id: "source-1", title: "Paper A" },
    ...overrides,
  } as BioprospectingFact;
}

const FACTS: BioprospectingFact[] = [
  makeFact({ id: FACT_A_ID }),
  makeFact({
    id: FACT_B_ID,
    measurement_direction: "antagonist",
    relation_type: "inhibits",
    result_summary: "Bryostatin inhibits PKC",
    source: { id: "source-2", title: "Paper B" } as any,
  }),
];

function modelResponse(items: unknown[]) {
  return { content: JSON.stringify(items), usage: { promptTokens: 1200, completionTokens: 80 } };
}

beforeEach(() => {
  upsertCalls = [];
  upsertReturnsNull = false;
  llmPrompts = [];
  llmAvailable = true;
  llmResponse = { content: "[]" };
  recordedCalls = [];
  logCalls.info = [];
  logCalls.error = [];
  logCalls.warn = [];
  logCalls.debug = [];
  process.env.BIOPROSPECTING_CONTRADICTION_DETECTION = "true";
  process.env.BIOPROSPECTING_CONTRADICTION_LLM = "true";
});

afterEach(() => {
  delete process.env.BIOPROSPECTING_CONTRADICTION_DETECTION;
  delete process.env.BIOPROSPECTING_CONTRADICTION_LLM;
});

// ---------------------------------------------------------------------------
// 1. buildFactsJson — THE id contract
// ---------------------------------------------------------------------------

describe("buildFactsJson (real module)", () => {
  it("includes each fact's id in the payload sent to the model", () => {
    const lines = buildFactsJson(FACTS).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.id)).toEqual([FACT_A_ID, FACT_B_ID]);
    // The rest of the payload the prompt documents is still there.
    expect(parsed[0].compound).toBe("Bryostatin");
    expect(parsed[0].bioactivity).toBe("PKC");
    expect(parsed[0].measurement_direction).toBe("agonist");
    expect(parsed[1].source_title).toBe("Paper B");
  });

  it("skips singleton compound|bioactivity groups", () => {
    const payload = buildFactsJson([
      makeFact({ id: FACT_A_ID }),
      makeFact({ id: FACT_B_ID, compound: "Caulerpenyne" }),
    ]);
    expect(payload).toBe("");
  });

  it("puts the ids in the prompt the LLM actually receives", async () => {
    llmResponse = modelResponse([]);
    await runLLMDetection({ facts: FACTS, sourceId: "source-1", runId: "run-1" });

    expect(llmPrompts).toHaveLength(1);
    expect(llmPrompts[0]).toContain(FACT_A_ID);
    expect(llmPrompts[0]).toContain(FACT_B_ID);
  });
});

// ---------------------------------------------------------------------------
// 2. Happy path — real ids resolve and insert
// ---------------------------------------------------------------------------

describe("runLLMDetection — proposals referencing real ids", () => {
  it("resolves and inserts them", async () => {
    llmResponse = modelResponse([
      {
        sourceFactId: FACT_A_ID,
        conflictingFactId: FACT_B_ID,
        contradictionType: "directional_conflict",
        explanation: "agonist vs antagonist on the same target",
      },
    ]);

    const result = await runLLMDetection({
      facts: FACTS,
      sourceId: "source-1",
      runId: "run-1",
    });

    expect(result).toEqual({ proposed: 1, resolved: 1, dropped: 0, inserted: 1 });

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].factAId).toBe(FACT_A_ID);
    expect(upsertCalls[0].factBId).toBe(FACT_B_ID);
    expect(upsertCalls[0].conflictType).toBe("measurement_mismatch");
    expect((upsertCalls[0].metadata as any).source_a.fact_id).toBe(FACT_A_ID);
    expect((upsertCalls[0].metadata as any).source_b.provenance).toContain("page 3");

    // A healthy join rate is NOT an error.
    expect(logCalls.error).toHaveLength(0);

    // The summary carries the join counters, not just `inserted`.
    const summary = logCalls.info.find((c) => c.message === "runLLMDetection_completed");
    expect(summary).toBeDefined();
    expect(summary!.payload).toMatchObject({
      llmProposed: 1,
      llmResolved: 1,
      llmDropped: 0,
      llmInserted: 1,
    });
  });

  it("counts a duplicate (already-existing) contradiction as resolved but not inserted", async () => {
    upsertReturnsNull = true;
    llmResponse = modelResponse([
      {
        sourceFactId: FACT_A_ID,
        conflictingFactId: FACT_B_ID,
        contradictionType: "contextual",
        explanation: "dup",
      },
    ]);

    const result = await runLLMDetection({ facts: FACTS, sourceId: "s", runId: "run-1" });
    expect(result).toEqual({ proposed: 1, resolved: 1, dropped: 0, inserted: 0 });
    expect(logCalls.error).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. The regression that shipped — unknown ids must be LOUD, not silent
// ---------------------------------------------------------------------------

describe("runLLMDetection — proposals referencing unknown ids", () => {
  it("counts them as dropped and logs a join-rate failure at ERROR level", async () => {
    llmResponse = modelResponse([
      {
        sourceFactId: UNKNOWN_ID,
        conflictingFactId: FACT_B_ID,
        contradictionType: "contextual",
        explanation: "model invented an id",
      },
    ]);

    const result = await runLLMDetection({
      facts: FACTS,
      sourceId: "source-1",
      runId: "run-1",
    });

    expect(result).toEqual({ proposed: 1, resolved: 0, dropped: 1, inserted: 0 });
    expect(upsertCalls).toHaveLength(0);

    const failure = logCalls.error.find(
      (c) => c.message === "runLLMDetection_join_rate_failure",
    );
    expect(failure).toBeDefined();
    expect(failure!.payload).toMatchObject({
      sourceId: "source-1",
      llmProposed: 1,
      llmResolved: 0,
      llmDropped: 1,
      threshold: JOIN_RATE_ERROR_THRESHOLD,
    });
    expect(failure!.payload.unknownFactIdSample).toContain(UNKNOWN_ID);
  });

  it("logs the failure when the join rate falls below the threshold (1 of 3)", async () => {
    llmResponse = modelResponse([
      {
        sourceFactId: FACT_A_ID,
        conflictingFactId: FACT_B_ID,
        contradictionType: "contextual",
        explanation: "real",
      },
      {
        sourceFactId: UNKNOWN_ID,
        conflictingFactId: FACT_B_ID,
        contradictionType: "contextual",
        explanation: "bogus",
      },
      {
        sourceFactId: FACT_A_ID,
        conflictingFactId: UNKNOWN_ID,
        contradictionType: "contextual",
        explanation: "bogus",
      },
    ]);

    const result = await runLLMDetection({ facts: FACTS, sourceId: "s", runId: "run-1" });

    expect(result.proposed).toBe(3);
    expect(result.resolved).toBe(1);
    expect(result.dropped).toBe(2);
    expect(result.resolved / result.proposed).toBeLessThan(JOIN_RATE_ERROR_THRESHOLD);
    expect(
      logCalls.error.some((c) => c.message === "runLLMDetection_join_rate_failure"),
    ).toBe(true);
  });

  it("does not log a failure when nothing was proposed", async () => {
    llmResponse = modelResponse([]);
    const result = await runLLMDetection({ facts: FACTS, sourceId: "s", runId: "run-1" });
    expect(result).toEqual({ proposed: 0, resolved: 0, dropped: 0, inserted: 0 });
    expect(logCalls.error).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Flags — the LLM tier has its own switch and defaults to OFF
// ---------------------------------------------------------------------------

describe("runLLMDetection — flag gating", () => {
  it("does not call the LLM when BIOPROSPECTING_CONTRADICTION_LLM is unset", async () => {
    delete process.env.BIOPROSPECTING_CONTRADICTION_LLM;

    const result = await runLLMDetection({ facts: FACTS, sourceId: "s", runId: "run-1" });

    expect(result).toEqual({ proposed: 0, resolved: 0, dropped: 0, inserted: 0 });
    expect(llmPrompts).toHaveLength(0);
    expect(recordedCalls).toHaveLength(0);
  });

  it("does not call the LLM when the feature flag is off, even with the LLM flag on", async () => {
    process.env.BIOPROSPECTING_CONTRADICTION_DETECTION = "false";

    const result = await runLLMDetection({ facts: FACTS, sourceId: "s", runId: "run-1" });

    expect(result.proposed).toBe(0);
    expect(llmPrompts).toHaveLength(0);
  });

  it("skips when no LLM provider is configured", async () => {
    llmAvailable = false;
    const result = await runLLMDetection({ facts: FACTS, sourceId: "s", runId: "run-1" });
    expect(result.inserted).toBe(0);
    expect(llmPrompts).toHaveLength(0);
  });

  it("skips when fewer than two facts are given", async () => {
    const result = await runLLMDetection({
      facts: [makeFact({ id: FACT_A_ID })],
      sourceId: "s",
      runId: "run-1",
    });
    expect(result.proposed).toBe(0);
    expect(llmPrompts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Cost tracking — the tier is no longer invisible spend
// ---------------------------------------------------------------------------

describe("runLLMDetection — cost accounting", () => {
  it("records the call against the run, even when every proposal is dropped", async () => {
    llmResponse = modelResponse([
      {
        sourceFactId: UNKNOWN_ID,
        conflictingFactId: UNKNOWN_ID,
        contradictionType: "contextual",
        explanation: "bogus",
      },
    ]);

    await runLLMDetection({ facts: FACTS, sourceId: "s", runId: "run-42" });

    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0].runId).toBe("run-42");
    expect(recordedCalls[0].entry).toMatchObject({
      provider: "anthropic",
      model: "claude-3-haiku",
      inputTokens: 1200,
      outputTokens: 80,
    });
    expect(recordedCalls[0].entry.costUsd).toBeGreaterThan(0);
  });

  it("warns instead of recording when no runId is available", async () => {
    llmResponse = modelResponse([]);
    await runLLMDetection({ facts: FACTS, sourceId: "s" });

    expect(recordedCalls).toHaveLength(0);
    expect(
      logCalls.warn.some((c) => c.message === "runLLMDetection_cost_not_attributed"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Parsing / validation helpers — the REAL exports, not copies
// ---------------------------------------------------------------------------

describe("extractJsonArray (real module)", () => {
  it("parses a fenced JSON array", () => {
    const text = '```json\n[{"sourceFactId":"f1"}]\n```';
    expect(extractJsonArray(text)[0].sourceFactId).toBe("f1");
  });

  it("parses a raw JSON array", () => {
    expect(extractJsonArray('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  it("returns [] for invalid or empty input", () => {
    expect(extractJsonArray('[{"sourceFactId":}]')).toEqual([]);
    expect(extractJsonArray("")).toEqual([]);
    expect(extractJsonArray('{"sourceFactId":"f1"}')).toEqual([]);
  });

  it("returns the last well-formed array when several are present", () => {
    expect(extractJsonArray("[1,2,3][4,5,6]")).toEqual([4, 5, 6]);
  });
});

describe("isLLMContradiction (real module)", () => {
  it("accepts a well-formed proposal", () => {
    expect(
      isLLMContradiction({
        sourceFactId: FACT_A_ID,
        conflictingFactId: FACT_B_ID,
        contradictionType: "contextual",
        explanation: "x",
      }),
    ).toBe(true);
  });

  it("rejects malformed proposals", () => {
    expect(isLLMContradiction(null)).toBe(false);
    expect(isLLMContradiction("string")).toBe(false);
    expect(
      isLLMContradiction({ conflictingFactId: FACT_B_ID, contradictionType: "contextual", explanation: "x" }),
    ).toBe(false);
    expect(
      isLLMContradiction({
        sourceFactId: 123,
        conflictingFactId: FACT_B_ID,
        contradictionType: "contextual",
        explanation: "x",
      }),
    ).toBe(false);
  });

  it("drops malformed proposals before they reach the join", async () => {
    llmResponse = modelResponse([
      { sourceFactId: FACT_A_ID, conflictingFactId: FACT_B_ID }, // no type/explanation
    ]);

    const result = await runLLMDetection({ facts: FACTS, sourceId: "s", runId: "run-1" });
    expect(result).toEqual({ proposed: 0, resolved: 0, dropped: 0, inserted: 0 });
    expect(upsertCalls).toHaveLength(0);
  });
});

describe("mapLLMContradictionType (real module)", () => {
  it("maps to the schema's conflict_type check-constraint values", () => {
    expect(mapLLMContradictionType("contextual")).toBe("bioactivity_mismatch");
    expect(mapLLMContradictionType("measurement_impossibility")).toBe("measurement_mismatch");
    expect(mapLLMContradictionType("directional_conflict")).toBe("measurement_mismatch");
    expect(mapLLMContradictionType("nonsense")).toBe("bioactivity_mismatch");
  });
});
