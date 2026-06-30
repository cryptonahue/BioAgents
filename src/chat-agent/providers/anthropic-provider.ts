/**
 * Anthropic-native ChatProvider.
 *
 * Wire-format details (top-level system param, input_schema tool defs,
 * tool_choice object, content-block assistant turns, batched tool_result
 * user messages) are confined to this file.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlock,
  ContentBlockParam,
  ToolUseBlock,
  TextBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type { ChatProvider, NormalizedResponse } from "../types";
import { getToolDefinitions } from "../registry";

/** Minimal surface of the Anthropic SDK the provider depends on (for injection in tests). */
export interface AnthropicLike {
  messages: {
    create(params: Anthropic.MessageCreateParams): Promise<Anthropic.Message>;
  };
}

export class AnthropicProvider implements ChatProvider {
  private client: AnthropicLike;
  private system = "";
  private messages: MessageParam[] = [];
  private pendingToolResults: ContentBlockParam[] = [];
  /** Raw assistant content from the most recent completion (preserves text + tool_use). */
  private lastAssistantContent: ContentBlock[] = [];

  constructor(apiKey: string, client?: AnthropicLike) {
    this.client = client ?? new Anthropic({ apiKey, timeout: 120_000 });
  }

  start(
    systemPrompt: string,
    history: { role: "user" | "assistant"; content: string }[] | undefined,
    userMessage: string,
  ): void {
    this.system = systemPrompt;
    this.messages = [
      ...(history ?? []).map(
        (m): MessageParam => ({ role: m.role, content: m.content }),
      ),
      { role: "user", content: userMessage },
    ];
  }

  async complete(opts: {
    model: string;
    maxTokens: number;
    temperature: number;
    includeTools: boolean;
  }): Promise<NormalizedResponse> {
    const toolDefs = getToolDefinitions();
    const useTools = opts.includeTools && toolDefs.length > 0;

    const params: Anthropic.MessageCreateParams = {
      model: opts.model,
      // System prompt is the top-level param, NOT a message.
      system: this.system,
      messages: this.messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      // Cast: registry returns loose JSON Schema objects; SDK expects strict Tool type.
      tools: useTools ? (toolDefs as any) : undefined,
      tool_choice: useTools ? { type: "auto" as const } : undefined,
    };

    const response = await this.client.messages.create(params);

    // Preserve the full assistant content (text + tool_use) for recordAssistant.
    this.lastAssistantContent = response.content;

    const toolUseBlocks = response.content.filter(
      (block): block is ToolUseBlock => block.type === "tool_use",
    );
    const text = response.content
      .filter((block): block is TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n\n");

    let finishReason: NormalizedResponse["finishReason"];
    if (response.stop_reason === "max_tokens") {
      finishReason = "max_tokens";
    } else {
      finishReason = toolUseBlocks.length > 0 ? "tool_calls" : "stop";
    }

    return {
      text,
      toolCalls: toolUseBlocks.map((block) => ({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      })),
      finishReason,
      usage: {
        input: response.usage?.input_tokens ?? 0,
        output: response.usage?.output_tokens ?? 0,
      },
    };
  }

  recordAssistant(_resp: NormalizedResponse): void {
    // Append the FULL assistant content block array, preserving intermediate text.
    this.messages.push({
      role: "assistant",
      content: this.lastAssistantContent as ContentBlockParam[],
    });
  }

  recordToolResult(r: {
    toolCallId: string;
    content: string;
    isError: boolean;
  }): void {
    // Cast: SDK types don't export ToolResultBlockParam directly.
    this.pendingToolResults.push({
      type: "tool_result",
      tool_use_id: r.toolCallId,
      content: r.content,
      is_error: r.isError,
    } as unknown as ContentBlockParam);
  }

  flushToolResults(): void {
    if (this.pendingToolResults.length === 0) return;
    // All tool results for a turn flush into a SINGLE user message
    // (never split across multiple user messages).
    this.messages.push({ role: "user", content: this.pendingToolResults });
    this.pendingToolResults = [];
  }
}
