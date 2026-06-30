/**
 * OpenAI-compatible ChatProvider (OpenRouter chat completions + tools).
 *
 * Wire-format details (messages[0] system role, function-shaped tool defs,
 * string tool_choice, per-call tool messages, JSON-string tool arguments)
 * are confined to this file. Adds a 120s request timeout the legacy loop lacked.
 */

import type { ChatProvider, NormalizedResponse } from "../types";
import { getToolDefinitions } from "../registry";
import logger from "../../utils/logger";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 120_000;

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenRouterChoice {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason?: string;
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

function getOpenAITools() {
  return getToolDefinitions().map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

export class OpenAIProvider implements ChatProvider {
  private apiKey: string;
  private baseUrl: string;
  private messages: ChatMessage[] = [];
  /** Assistant message from the most recent completion (for recordAssistant). */
  private lastAssistant: {
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  } = { content: null };

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || process.env.CHAT_AGENT_BASE_URL || DEFAULT_BASE_URL;
  }

  start(
    systemPrompt: string,
    history: { role: "user" | "assistant"; content: string }[] | undefined,
    userMessage: string,
  ): void {
    // System prompt is messages[0].
    this.messages = [{ role: "system", content: systemPrompt }];
    if (history) {
      for (const msg of history) {
        this.messages.push({ role: msg.role, content: msg.content });
      }
    }
    this.messages.push({ role: "user", content: userMessage });
  }

  async complete(opts: {
    model: string;
    maxTokens: number;
    temperature: number;
    includeTools: boolean;
  }): Promise<NormalizedResponse> {
    const tools = getOpenAITools();

    const body: Record<string, unknown> = {
      model: opts.model,
      messages: this.messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
    };

    if (opts.includeTools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const response = await this.createChatCompletion(body);

    const choice = response.choices?.[0];

    // Defensive: OpenRouter can return an empty choices array.
    if (!choice) {
      logger.warn(
        { hasUsage: Boolean(response.usage) },
        "agent_loop_empty_choices",
      );
      this.lastAssistant = { content: null };
      return {
        text: "",
        toolCalls: [],
        finishReason: "stop",
        usage: {
          input: response.usage?.prompt_tokens ?? 0,
          output: response.usage?.completion_tokens ?? 0,
        },
      };
    }

    const assistantMessage = choice.message;
    const rawToolCalls = assistantMessage?.tool_calls ?? [];
    this.lastAssistant = {
      content: assistantMessage?.content ?? null,
      tool_calls: rawToolCalls,
    };

    let finishReason: NormalizedResponse["finishReason"];
    if (choice.finish_reason === "length") {
      finishReason = "max_tokens";
    } else if (choice.finish_reason === "tool_calls") {
      finishReason = "tool_calls";
    } else {
      finishReason = "stop";
    }

    const toolCalls = rawToolCalls.map((tc) => {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments || "{}") as Record<
          string,
          unknown
        >;
      } catch {
        input = {};
      }
      return { id: tc.id, name: tc.function.name, input };
    });

    return {
      text: assistantMessage?.content ?? "",
      toolCalls,
      finishReason,
      usage: {
        input: response.usage?.prompt_tokens ?? 0,
        output: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  recordAssistant(_resp: NormalizedResponse): void {
    this.messages.push({
      role: "assistant",
      content: this.lastAssistant.content,
      tool_calls: this.lastAssistant.tool_calls,
    });
  }

  recordToolResult(r: {
    toolCallId: string;
    content: string;
    isError: boolean;
  }): void {
    // One tool message per call (OpenAI convention).
    this.messages.push({
      role: "tool",
      tool_call_id: r.toolCallId,
      content: r.content,
    });
  }

  flushToolResults(): void {
    // No-op: OpenAI tool results are appended individually in recordToolResult.
  }

  private async createChatCompletion(
    body: Record<string, unknown>,
  ): Promise<OpenRouterResponse> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;

    // Add a request timeout (the legacy OpenRouter loop had none).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted || (err as Error)?.name === "AbortError") {
        throw new Error(
          `OpenRouter API request timed out after ${REQUEST_TIMEOUT_MS}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      let message = raw || res.statusText;
      try {
        const parsed = JSON.parse(raw);
        message = parsed?.error?.message ?? parsed?.message ?? message;
      } catch {
        // use raw text
      }
      throw new Error(`OpenRouter API error: ${res.status} - ${message}`);
    }

    return (await res.json()) as OpenRouterResponse;
  }
}
