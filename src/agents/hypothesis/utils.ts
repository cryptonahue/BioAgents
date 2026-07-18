import { LLM } from "../../llm/provider";
import type { LLMProvider } from "../../types/core";
import logger from "../../utils/logger";
import { hypGenDeepResearchPrompt } from "./prompts";
import { getGlobalDeepResearchModel } from "../../config/deepResearchModel";

export type HypothesisDoc = {
  title: string;
  text: string;
  context: string;
};

export type HypothesisOptions = {
  model?: string;
  maxTokens?: number;
  thinking?: boolean;
  thinkingBudget?: number;
  mode?: "create" | "update";
  messageId?: string; // For token usage tracking
  usageType?: "chat" | "deep-research" | "paper-generation";
};

export type HypothesisResult = {
  text: string;
  thought?: string;
};

/**
 * Generate or update hypothesis based on documents
 * Always uses deep research mode
 */
export async function generateHypothesis(
  question: string,
  documents: HypothesisDoc[],
  options: HypothesisOptions = {},
): Promise<HypothesisResult> {
  const model =
    process.env.HYP_LLM_MODEL ||
    (await getGlobalDeepResearchModel()) ||
    "minimax/minimax-m3";
  const mode = options.mode ?? "create";

  // Build document content
  const documentText = documents
    .map((d) => `Title: ${d.title}\n\n${d.text}`)
    .join("\n\n\n");

  // Use deep research prompt
  let hypGenInstruction = hypGenDeepResearchPrompt.replace(
    "{{question}}",
    question,
  );

  // Add mode-specific instructions
  if (mode === "update") {
    hypGenInstruction += `\n\nIMPORTANT: You are UPDATING an existing hypothesis. The current hypothesis is included in the documents. Refine and improve it based on the new findings, but maintain consistency with the overall research direction.`;
  }

  const HYP_LLM_PROVIDER: LLMProvider =
    (process.env.HYP_LLM_PROVIDER as LLMProvider) || "openrouter";
  const llmApiKey = process.env[`${HYP_LLM_PROVIDER.toUpperCase()}_API_KEY`];

  if (!llmApiKey) {
    throw new Error(
      `${HYP_LLM_PROVIDER.toUpperCase()}_API_KEY is not configured.`,
    );
  }

  const llmProvider = new LLM({
    name: HYP_LLM_PROVIDER,
    apiKey: llmApiKey,
  });

  const llmRequest = {
    model,
    messages: [
      {
        role: "assistant" as const,
        content: `Use the following evidence set to formulate a hypothesis: ${documentText}`,
      },
      {
        role: "user" as const,
        content: hypGenInstruction,
      },
    ],
    maxTokens: options.maxTokens ?? 4000,
    thinkingBudget: options.thinking
      ? (options.thinkingBudget ?? 2048)
      : undefined,
    messageId: options.messageId,
    usageType: options.usageType,
  };

  try {
    const response = await llmProvider.createChatCompletion(llmRequest);

    // Parse JSON if needed. Only adopt the parsed `.message` when it is a
    // non-empty string — a model that returns `{"message":""}` (or JSON with no
    // message) must NOT blank a hypothesis that came through as raw content.
    let finalText = response.content ?? "";
    try {
      const parsed = JSON.parse(
        response.content.replace(/```json\n?/, "").replace(/\n?```$/, ""),
      );
      if (typeof parsed?.message === "string" && parsed.message.trim()) {
        finalText = parsed.message;
      }
    } catch {
      // Keep raw text if not JSON
    }

    logger.info(
      {
        mode,
        hypothesisLength: finalText.length,
        docCount: documents.length,
      },
      "hypothesis_generated",
    );

    return {
      text: finalText,
      thought: undefined, // TODO: Extract thinking if available from response
    };
  } catch (error) {
    logger.error({ error, mode }, "hypothesis_generation_failed");
    throw error;
  }
}
