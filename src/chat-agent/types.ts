/**
 * Self-contained types for the agent-based chat mode.
 * Independent from src/llm/types.ts to avoid modifying shared interfaces.
 */

/**
 * A registered tool with its JSON Schema and executor.
 */
export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema for Anthropic API
  execute: (input: Record<string, unknown>) => Promise<AgentToolResult>;
}

/**
 * Result of executing a tool.
 */
export interface AgentToolResult {
  content: string; // Stringified result for the LLM
  isError?: boolean; // If true, sent as is_error to the model
}

/**
 * Info passed to the onToolResult callback after each tool execution.
 */
export interface ToolCallInfo {
  toolName: string;
  toolCallId: string;
  input: unknown;
  result: AgentToolResult;
  toolCallCount: number; // Running total of tool calls so far
}

/**
 * Configuration for the agent loop.
 */
export interface AgentLoopConfig {
  model: string;
  systemPrompt: string;
  maxToolCalls: number;
  maxTokens: number;
  temperature?: number;
  apiKey: string;
  /** Called after each tool execution. Use for DB state updates, progress notifications, etc. */
  onToolResult?: (info: ToolCallInfo) => Promise<void>;
}

/**
 * Result returned by the agent loop.
 */
export interface AgentLoopResult {
  finalText: string;
  toolCallCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  hitMaxTokens?: boolean;
}

/**
 * Provider-neutral representation of a single LLM completion.
 *
 * The shared agent loop only ever reads this shape; every provider-specific
 * wire detail (Anthropic content blocks vs OpenAI chat messages) is hidden
 * behind the ChatProvider adapter.
 */
export interface NormalizedResponse {
  /** Concatenated assistant text (provider joins blocks; loop trims). */
  text: string;
  /** Tool calls requested by the model this turn. */
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  /**
   * Why the model stopped:
   * - "max_tokens": output cap hit — loop bails without executing tools
   * - "tool_calls": model wants to call tools
   * - "stop": normal completion
   */
  finishReason: "max_tokens" | "tool_calls" | "stop";
  /** Token usage for this turn (cumulative semantics owned by the loop). */
  usage: { input: number; output: number };
}

/**
 * Adapter that hides provider-specific wire format from the shared agent loop.
 *
 * Conversation state (message history, pending tool results) lives inside the
 * provider; the loop only orchestrates control flow.
 */
export interface ChatProvider {
  /** Seed the conversation: system prompt, prior history, and the new user message. */
  start(
    systemPrompt: string,
    history: { role: "user" | "assistant"; content: string }[] | undefined,
    userMessage: string,
  ): void;
  /** Run one completion. When includeTools is false, the request omits tools. */
  complete(opts: {
    model: string;
    maxTokens: number;
    temperature: number;
    includeTools: boolean;
  }): Promise<NormalizedResponse>;
  /** Append the assistant turn (full provider-native content) to history. */
  recordAssistant(resp: NormalizedResponse): void;
  /** Buffer a single tool result for the current turn. */
  recordToolResult(r: {
    toolCallId: string;
    content: string;
    isError: boolean;
  }): void;
  /** Commit buffered tool results to history (Anthropic: one user message; OpenAI: no-op). */
  flushToolResults(): void;
}
