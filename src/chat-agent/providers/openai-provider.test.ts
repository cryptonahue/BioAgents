/**
 * Offline wire-fidelity tests for OpenAIProvider (OpenRouter shape).
 * global fetch is mocked; no network is used.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterEach,
} from "bun:test";
import { OpenAIProvider } from "./openai-provider";
import { registerTool } from "../registry";

const TOOL_SCHEMA = {
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
};

// Unique name so the shared registry singleton doesn't collide with other test files.
const TOOL_NAME = "echo_oai";

beforeAll(() => {
  registerTool({
    name: TOOL_NAME,
    description: "Echo tool for tests",
    inputSchema: TOOL_SCHEMA,
    execute: async () => ({ content: "ok" }),
  });
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface CapturedRequest {
  url: string;
  options: RequestInit;
  body: any;
}

function mockFetch(responseBody: unknown): { captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    captured.push({
      url,
      options,
      body: JSON.parse(options.body as string),
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { captured };
}

const completeOpts = {
  model: "test-model",
  maxTokens: 1024,
  temperature: 0.3,
  includeTools: true,
};

describe("OpenAIProvider wire fidelity", () => {
  it("sends system as messages[0], tool_choice 'auto', and function-shaped tools", async () => {
    const { captured } = mockFetch({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });

    const provider = new OpenAIProvider("key");
    provider.start("SYSTEM PROMPT", undefined, "hello");
    const resp = await provider.complete(completeOpts);

    expect(captured.length).toBe(1);
    const body = captured[0]!.body;
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe("SYSTEM PROMPT");
    expect(body.tool_choice).toBe("auto");
    const echoTool = body.tools.find(
      (t: any) => t.function.name === TOOL_NAME,
    );
    expect(echoTool.type).toBe("function");
    expect(echoTool.function.parameters).toEqual(TOOL_SCHEMA);

    // AbortController/timeout is wired: fetch receives an AbortSignal.
    expect(captured[0]!.options.signal).toBeInstanceOf(AbortSignal);

    expect(resp.text).toBe("hi");
    expect(resp.finishReason).toBe("stop");
    expect(resp.usage).toEqual({ input: 7, output: 3 });
  });

  it("throws a clear timeout error when the request aborts", async () => {
    // Simulate the AbortController firing: fetch rejects with an AbortError.
    globalThis.fetch = (async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider("key");
    provider.start("SYSTEM", undefined, "hello");
    await expect(provider.complete(completeOpts)).rejects.toThrow(/timed out/i);
  });

  it("clears the timeout timer on a successful response (no leaked timer)", async () => {
    mockFetch({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });
    const cleared: unknown[] = [];
    const realClear = globalThis.clearTimeout;
    globalThis.clearTimeout = ((id: any) => {
      cleared.push(id);
      return realClear(id);
    }) as typeof clearTimeout;
    try {
      const provider = new OpenAIProvider("key");
      provider.start("S", undefined, "hi");
      await provider.complete(completeOpts);
      expect(cleared.length).toBeGreaterThan(0);
    } finally {
      globalThis.clearTimeout = realClear;
    }
  });

  it("parses tool_call arguments from a JSON string; malformed -> {}", async () => {
    const good = mockFetch({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "tc1",
                type: "function",
                function: { name: "echo", arguments: '{"q":"hi"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const p1 = new OpenAIProvider("key");
    p1.start("s", undefined, "u");
    const r1 = await p1.complete(completeOpts);
    expect(r1.finishReason).toBe("tool_calls");
    expect(r1.toolCalls[0]!.input).toEqual({ q: "hi" });
    good.captured; // referenced to satisfy lint

    const bad = mockFetch({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "tc2",
                type: "function",
                function: { name: "echo", arguments: "{not json" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const p2 = new OpenAIProvider("key");
    p2.start("s", undefined, "u");
    const r2 = await p2.complete(completeOpts);
    expect(r2.toolCalls[0]!.input).toEqual({});
    bad.captured;
  });

  it("handles empty choices array defensively", async () => {
    mockFetch({ choices: [] });
    const provider = new OpenAIProvider("key");
    provider.start("s", undefined, "u");
    const resp = await provider.complete(completeOpts);

    expect(resp.text).toBe("");
    expect(resp.finishReason).toBe("stop");
    expect(resp.toolCalls).toEqual([]);
  });

  it("maps finish_reason length -> max_tokens", async () => {
    mockFetch({
      choices: [{ message: { content: "partial" }, finish_reason: "length" }],
    });
    const provider = new OpenAIProvider("key");
    provider.start("s", undefined, "u");
    const resp = await provider.complete(completeOpts);
    expect(resp.finishReason).toBe("max_tokens");
  });

  it("defaults usage to 0 when absent", async () => {
    mockFetch({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    });
    const provider = new OpenAIProvider("key");
    provider.start("s", undefined, "u");
    const resp = await provider.complete(completeOpts);
    expect(resp.usage).toEqual({ input: 0, output: 0 });
  });

  it("omits tools when includeTools is false", async () => {
    const { captured } = mockFetch({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    });
    const provider = new OpenAIProvider("key");
    provider.start("s", undefined, "u");
    await provider.complete({ ...completeOpts, includeTools: false });
    expect(captured[0]!.body.tools).toBeUndefined();
    expect(captured[0]!.body.tool_choice).toBeUndefined();
  });
});
