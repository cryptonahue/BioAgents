/**
 * Offline wire-fidelity tests for AnthropicProvider.
 * The Anthropic SDK client is injected (a stub), so no network or key is used.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { AnthropicProvider, type AnthropicLike } from "./anthropic-provider";
import { registerTool } from "../registry";

const TOOL_SCHEMA = {
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
};

// Unique name so the shared registry singleton doesn't collide with other test files.
const TOOL_NAME = "echo_anthropic";

beforeAll(() => {
  registerTool({
    name: TOOL_NAME,
    description: "Echo tool for tests",
    inputSchema: TOOL_SCHEMA,
    execute: async () => ({ content: "ok" }),
  });
});

function stubClient(responses: any[]): {
  client: AnthropicLike;
  calls: any[];
} {
  const calls: any[] = [];
  const client: AnthropicLike = {
    messages: {
      create: (async (params: any) => {
        calls.push(params);
        const resp = responses.shift();
        if (!resp) throw new Error("stubClient: no scripted response");
        return resp;
      }) as AnthropicLike["messages"]["create"],
    },
  };
  return { client, calls };
}

const completeOpts = {
  model: "claude-test",
  maxTokens: 4096,
  temperature: 0.3,
  includeTools: true,
};

const toolUseResponse = {
  content: [
    { type: "text", text: "let me look that up" },
    { type: "tool_use", id: "tu1", name: "echo", input: { q: "hi" } },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 12, output_tokens: 6 },
};

const stopResponse = {
  content: [{ type: "text", text: "all done" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 2, output_tokens: 2 },
};

describe("AnthropicProvider wire fidelity", () => {
  it("sends system top-level, tool_choice {type:'auto'}, and input_schema tool defs", async () => {
    const { client, calls } = stubClient([stopResponse]);
    const provider = new AnthropicProvider("key", client);
    provider.start("SYSTEM PROMPT", undefined, "hello");
    const resp = await provider.complete(completeOpts);

    const params = calls[0];
    expect(params.system).toBe("SYSTEM PROMPT");
    // system is NOT smuggled into messages
    expect(params.messages[0].role).toBe("user");
    expect(params.messages[0].content).toBe("hello");
    expect(params.tool_choice).toEqual({ type: "auto" });
    const echoTool = params.tools.find((t: any) => t.name === TOOL_NAME);
    expect(echoTool.input_schema).toEqual(TOOL_SCHEMA);

    expect(resp.text).toBe("all done");
    expect(resp.finishReason).toBe("stop");
    expect(resp.usage).toEqual({ input: 2, output: 2 });
  });

  it("maps tool_use stop reason and preserves intermediate text", async () => {
    const { client } = stubClient([toolUseResponse]);
    const provider = new AnthropicProvider("key", client);
    provider.start("s", undefined, "u");
    const resp = await provider.complete(completeOpts);

    expect(resp.finishReason).toBe("tool_calls");
    expect(resp.text).toBe("let me look that up");
    expect(resp.toolCalls).toEqual([
      { id: "tu1", name: "echo", input: { q: "hi" } },
    ]);
  });

  it("flushes all tool results of a turn into a SINGLE user message", async () => {
    const { client, calls } = stubClient([toolUseResponse, stopResponse]);
    const provider = new AnthropicProvider("key", client);
    provider.start("s", undefined, "u");

    await provider.complete(completeOpts); // returns tool_use
    provider.recordAssistant({
      text: "",
      toolCalls: [],
      finishReason: "tool_calls",
      usage: { input: 0, output: 0 },
    });
    provider.recordToolResult({ toolCallId: "tu1", content: "r1", isError: false });
    provider.recordToolResult({ toolCallId: "tu2", content: "r2", isError: true });
    provider.flushToolResults();

    await provider.complete(completeOpts); // second turn captures the built messages

    const params = calls[1];
    const messages = params.messages;

    // [user, assistant(text+tool_use), user(tool_results array)]
    const assistant = messages.find((m: any) => m.role === "assistant");
    expect(Array.isArray(assistant.content)).toBe(true);
    const types = assistant.content.map((b: any) => b.type);
    expect(types).toContain("text");
    expect(types).toContain("tool_use");

    // The tool results are ONE user message with an array of 2 tool_result blocks.
    const toolResultMsgs = messages.filter(
      (m: any) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.every((b: any) => b.type === "tool_result"),
    );
    expect(toolResultMsgs.length).toBe(1);
    expect(toolResultMsgs[0].content.length).toBe(2);
    expect(toolResultMsgs[0].content[0].tool_use_id).toBe("tu1");
    expect(toolResultMsgs[0].content[1].is_error).toBe(true);
  });

  it("maps max_tokens stop reason", async () => {
    const { client } = stubClient([
      {
        content: [{ type: "text", text: "cut off" }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    const provider = new AnthropicProvider("key", client);
    provider.start("s", undefined, "u");
    const resp = await provider.complete(completeOpts);
    expect(resp.finishReason).toBe("max_tokens");
  });

  it("omits tools and tool_choice when includeTools is false", async () => {
    const { client, calls } = stubClient([stopResponse]);
    const provider = new AnthropicProvider("key", client);
    provider.start("s", undefined, "u");
    await provider.complete({ ...completeOpts, includeTools: false });
    expect(calls[0].tools).toBeUndefined();
    expect(calls[0].tool_choice).toBeUndefined();
  });
});
