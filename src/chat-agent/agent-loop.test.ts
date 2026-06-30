/**
 * Offline tests for the shared agent loop.
 *
 * The single mockable seam is ChatProvider.complete(): a FakeProvider returns
 * scripted NormalizedResponses so the loop's control flow is exercised without
 * any network, API keys, or SDK.
 */

import { describe, it, expect, beforeAll, spyOn } from "bun:test";
import { runAgentLoop } from "./agent-loop";
import { registerTool } from "./registry";
import logger from "../utils/logger";
import type {
  AgentLoopConfig,
  ChatProvider,
  NormalizedResponse,
} from "./types";

let echoCalls = 0;

beforeAll(() => {
  // Register a trivial tool so executeTool() succeeds for tool-call turns.
  registerTool({
    name: "echo",
    description: "Echo tool for tests",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      echoCalls++;
      return { content: "echo-result" };
    },
  });
});

class FakeProvider implements ChatProvider {
  completeCalls: { includeTools: boolean }[] = [];
  startCalls = 0;
  recordedAssistants = 0;
  recordedToolResults: { toolCallId: string; content: string; isError: boolean }[] =
    [];
  flushes = 0;
  private idx = 0;

  constructor(private responses: NormalizedResponse[]) {}

  start(): void {
    this.startCalls++;
  }

  async complete(opts: {
    model: string;
    maxTokens: number;
    temperature: number;
    includeTools: boolean;
  }): Promise<NormalizedResponse> {
    this.completeCalls.push({ includeTools: opts.includeTools });
    const resp = this.responses[this.idx];
    this.idx++;
    if (!resp) throw new Error("FakeProvider: no scripted response left");
    return resp;
  }

  recordAssistant(): void {
    this.recordedAssistants++;
  }

  recordToolResult(r: {
    toolCallId: string;
    content: string;
    isError: boolean;
  }): void {
    this.recordedToolResults.push(r);
  }

  flushToolResults(): void {
    this.flushes++;
  }
}

function baseConfig(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
  return {
    model: "test-model",
    systemPrompt: "system",
    maxToolCalls: 10,
    maxTokens: 4096,
    apiKey: "test-key",
    ...overrides,
  };
}

const textResp = (
  text: string,
  usage = { input: 0, output: 0 },
): NormalizedResponse => ({
  text,
  toolCalls: [],
  finishReason: "stop",
  usage,
});

const toolResp = (
  id: string,
  usage = { input: 0, output: 0 },
): NormalizedResponse => ({
  text: "",
  toolCalls: [{ id, name: "echo", input: {} }],
  finishReason: "tool_calls",
  usage,
});

describe("runAgentLoop (shared loop via FakeProvider)", () => {
  it("T1: immediate text reply with no tools", async () => {
    const provider = new FakeProvider([textResp("Hello there")]);
    const result = await runAgentLoop("hi", baseConfig(), provider);

    expect(result.finalText).toBe("Hello there");
    expect(result.toolCallCount).toBe(0);
    expect(result.hitMaxTokens).toBeUndefined();
    expect(provider.startCalls).toBe(1);
    expect(provider.completeCalls.length).toBe(1);
  });

  it("T2: one tool call then a final text reply", async () => {
    echoCalls = 0;
    let callbackCount = 0;
    const provider = new FakeProvider([
      toolResp("t1"),
      textResp("final answer"),
    ]);
    const result = await runAgentLoop("hi", baseConfig(), provider, undefined);

    // onToolResult is wired via config below to count invocations.
    const result2 = await runAgentLoop(
      "hi",
      baseConfig({
        onToolResult: async () => {
          callbackCount++;
        },
      }),
      new FakeProvider([toolResp("t1"), textResp("final answer")]),
    );

    expect(result.finalText).toBe("final answer");
    expect(result.toolCallCount).toBe(1);
    expect(provider.recordedAssistants).toBe(1);
    expect(provider.recordedToolResults.length).toBe(1);
    expect(provider.flushes).toBe(1);

    expect(result2.toolCallCount).toBe(1);
    expect(callbackCount).toBe(1);
  });

  it("T3: max_tokens immediately returns text and does not execute tools", async () => {
    echoCalls = 0;
    const withText = new FakeProvider([
      { text: "partial", toolCalls: [], finishReason: "max_tokens", usage: { input: 1, output: 1 } },
    ]);
    const r1 = await runAgentLoop("hi", baseConfig(), withText);
    expect(r1.hitMaxTokens).toBe(true);
    expect(r1.finalText).toBe("partial");
    expect(r1.toolCallCount).toBe(0);

    const emptyText = new FakeProvider([
      { text: "", toolCalls: [], finishReason: "max_tokens", usage: { input: 1, output: 1 } },
    ]);
    const r2 = await runAgentLoop("hi", baseConfig(), emptyText);
    expect(r2.hitMaxTokens).toBe(true);
    expect(r2.finalText).toBe("");
    expect(echoCalls).toBe(0);
  });

  it("T4: max_tokens mid-tool-call bails without executing tools", async () => {
    echoCalls = 0;
    let callbackCount = 0;
    const provider = new FakeProvider([
      {
        text: "stopped",
        toolCalls: [{ id: "x", name: "echo", input: {} }],
        finishReason: "max_tokens",
        usage: { input: 2, output: 2 },
      },
    ]);
    const result = await runAgentLoop(
      "hi",
      baseConfig({
        onToolResult: async () => {
          callbackCount++;
        },
      }),
      provider,
    );

    expect(result.hitMaxTokens).toBe(true);
    expect(result.toolCallCount).toBe(0);
    expect(provider.recordedAssistants).toBe(0);
    expect(echoCalls).toBe(0);
    expect(callbackCount).toBe(0);
  });

  it("T5: soft cap omits tools on the next request and emits cap log", async () => {
    const warnSpy = spyOn(logger, "warn");
    const provider = new FakeProvider([toolResp("a"), textResp("done")]);

    const result = await runAgentLoop("hi", baseConfig({ maxToolCalls: 1 }), provider);

    expect(result.finalText).toBe("done");
    expect(result.toolCallCount).toBe(1);
    // First call includes tools; second (at cap) omits them.
    expect(provider.completeCalls[0]!.includeTools).toBe(true);
    expect(provider.completeCalls[1]!.includeTools).toBe(false);

    const capLogged = warnSpy.mock.calls.some(
      (c) => c[1] === "agent_tool_call_cap_reached",
    );
    expect(capLogged).toBe(true);
    warnSpy.mockRestore();
  });

  it("T6: a throwing onToolResult callback warns but does not abort the loop", async () => {
    const warnSpy = spyOn(logger, "warn");
    const provider = new FakeProvider([toolResp("t1"), textResp("recovered")]);

    const result = await runAgentLoop(
      "hi",
      baseConfig({
        onToolResult: async () => {
          throw new Error("callback boom");
        },
      }),
      provider,
    );

    expect(result.finalText).toBe("recovered");
    expect(result.toolCallCount).toBe(1);
    const cbWarned = warnSpy.mock.calls.some(
      (c) => c[1] === "on_tool_result_callback_failed",
    );
    expect(cbWarned).toBe(true);
    warnSpy.mockRestore();
  });

  it("T7: usage accumulates across turns", async () => {
    const provider = new FakeProvider([
      toolResp("t1", { input: 10, output: 5 }),
      textResp("end", { input: 3, output: 7 }),
    ]);
    const result = await runAgentLoop("hi", baseConfig(), provider);

    // Cumulative across both turns (10+3, 5+7).
    expect(result.totalInputTokens).toBe(13);
    expect(result.totalOutputTokens).toBe(12);
  });
});
