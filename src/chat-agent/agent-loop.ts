/**
 * Provider-agnostic agent loop for chat mode.
 *
 * Contains ALL the shared/incidental control flow exactly once. Every wire-format
 * difference between Anthropic and OpenRouter lives behind the ChatProvider adapter
 * (see ./providers/*); this file never imports an SDK.
 */

import type {
  AgentLoopConfig,
  AgentLoopResult,
  ChatProvider,
} from "./types";
import { executeTool } from "./registry";
import logger from "../utils/logger";

const DEFAULT_TEMPERATURE = 0.3;

/**
 * Run the agent loop: send message to LLM, execute tool calls, loop until done.
 *
 * When the tool call cap is reached, the next LLM call omits tools (soft cap)
 * to force a text-only response.
 */
export async function runAgentLoop(
  userMessage: string,
  config: AgentLoopConfig,
  provider: ChatProvider,
  history?: { role: "user" | "assistant"; content: string }[],
): Promise<AgentLoopResult> {
  provider.start(config.systemPrompt, history, userMessage);

  let toolCallCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalText = "";

  while (true) {
    // Soft cap: omit tools once we have hit the limit, forcing a text response.
    const includeTools = toolCallCount < config.maxToolCalls;

    logger.info(
      { turn: toolCallCount, isAtCap: !includeTools },
      "agent_loop_turn_start",
    );

    const response = await provider.complete({
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature ?? DEFAULT_TEMPERATURE,
      includeTools,
    });

    // Track token usage. Providers default missing usage to 0; the accumulation
    // here intentionally preserves today's cumulative accounting semantics.
    totalInputTokens += response.usage.input;
    totalOutputTokens += response.usage.output;

    // max_tokens: return immediately with whatever text we have (even empty);
    // tools are NOT executed.
    if (response.finishReason === "max_tokens") {
      finalText = response.text.trim();
      logger.warn(
        { toolCallCount, hasText: finalText.length > 0 },
        "agent_loop_max_tokens_reached",
      );
      return {
        finalText,
        toolCallCount,
        totalInputTokens,
        totalOutputTokens,
        hitMaxTokens: true,
      };
    }

    // No tool calls — we're done.
    if (response.toolCalls.length === 0) {
      finalText = response.text.trim();
      break;
    }

    // Tool calls requested — record the assistant turn, then execute each tool.
    provider.recordAssistant(response);

    for (const toolCall of response.toolCalls) {
      toolCallCount++;

      logger.info(
        {
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          toolCallCount,
        },
        "agent_tool_call_executing",
      );

      const result = await executeTool(toolCall.name, toolCall.input);

      // Notify caller BEFORE appending the result (e.g. for DB state updates).
      if (config.onToolResult) {
        try {
          await config.onToolResult({
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            input: toolCall.input,
            result,
            toolCallCount,
          });
        } catch (err) {
          logger.warn(
            { error: err, toolName: toolCall.name },
            "on_tool_result_callback_failed",
          );
          // Don't break the loop — a callback failure shouldn't stop the agent.
        }
      }

      provider.recordToolResult({
        toolCallId: toolCall.id,
        content: result.content,
        isError: result.isError ?? false,
      });
    }

    // Commit this turn's tool results to history.
    provider.flushToolResults();

    if (toolCallCount >= config.maxToolCalls) {
      logger.warn(
        { toolCallCount, max: config.maxToolCalls },
        "agent_tool_call_cap_reached",
      );
      // Loop continues — next iteration omits tools, forcing a text response.
    }
  }

  return { finalText, toolCallCount, totalInputTokens, totalOutputTokens };
}
