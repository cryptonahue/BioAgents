/**
 * Agent loop for chat mode via OpenRouter (OpenAI-compatible chat completions + tools).
 */

import type { AgentLoopConfig, AgentLoopResult } from "./types";
import { getToolDefinitions, executeTool } from "./registry";
import logger from "../utils/logger";

const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

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

function toOpenAIMessages(
  systemPrompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }> | undefined,
  userMessage: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

  if (history) {
    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  messages.push({ role: "user", content: userMessage });
  return messages;
}

async function createChatCompletion(
  apiKey: string,
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<OpenRouterResponse> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

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

/**
 * Run the agent loop using OpenRouter's OpenAI-compatible API.
 */
export async function runAgentLoopOpenRouter(
  userMessage: string,
  config: AgentLoopConfig,
  history?: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<AgentLoopResult> {
  const baseUrl = process.env.CHAT_AGENT_BASE_URL || DEFAULT_BASE_URL;
  const openaiTools = getOpenAITools();

  const messages = toOpenAIMessages(config.systemPrompt, history, userMessage);

  let toolCallCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalText = "";

  while (true) {
    const isAtCap = toolCallCount >= config.maxToolCalls;

    logger.info(
      { turn: toolCallCount, messageCount: messages.length, isAtCap },
      "agent_loop_turn_start",
    );

    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      max_tokens: config.maxTokens,
      temperature: config.temperature ?? DEFAULT_TEMPERATURE,
    };

    if (!isAtCap && openaiTools.length > 0) {
      body.tools = openaiTools;
      body.tool_choice = "auto";
    }

    const response = await createChatCompletion(config.apiKey, baseUrl, body);
    const choice = response.choices?.[0];

    if (response.usage) {
      totalInputTokens += response.usage.prompt_tokens ?? 0;
      totalOutputTokens += response.usage.completion_tokens ?? 0;
    }

    const assistantMessage = choice?.message;
    const toolCalls = assistantMessage?.tool_calls ?? [];
    const textContent = assistantMessage?.content?.trim() ?? "";

    if (choice?.finish_reason === "length") {
      finalText = textContent;
      logger.warn({ toolCallCount, hasText: finalText.length > 0 }, "agent_loop_max_tokens_reached");
      return {
        finalText,
        toolCallCount,
        totalInputTokens,
        totalOutputTokens,
        hitMaxTokens: true,
      };
    }

    if (toolCalls.length === 0) {
      finalText = textContent;
      break;
    }

    messages.push({
      role: "assistant",
      content: assistantMessage?.content ?? null,
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      toolCallCount++;

      let parsedInput: Record<string, unknown> = {};
      try {
        parsedInput = JSON.parse(toolCall.function.arguments || "{}") as Record<
          string,
          unknown
        >;
      } catch {
        parsedInput = {};
      }

      logger.info(
        { toolName: toolCall.function.name, toolCallId: toolCall.id, toolCallCount },
        "agent_tool_call_executing",
      );

      const result = await executeTool(toolCall.function.name, parsedInput);

      if (config.onToolResult) {
        try {
          await config.onToolResult({
            toolName: toolCall.function.name,
            toolCallId: toolCall.id,
            input: parsedInput,
            result,
            toolCallCount,
          });
        } catch (err) {
          logger.warn(
            { error: err, toolName: toolCall.function.name },
            "on_tool_result_callback_failed",
          );
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result.content,
      });
    }

    if (toolCallCount >= config.maxToolCalls) {
      logger.warn(
        { toolCallCount, max: config.maxToolCalls },
        "agent_tool_call_cap_reached",
      );
    }
  }

  return { finalText, toolCallCount, totalInputTokens, totalOutputTokens };
}
