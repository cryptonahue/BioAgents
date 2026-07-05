import { LLM } from "../../llm/provider";
import type { LLMProvider } from "../../llm/types";

const PROVIDER_ENV_KEYS: Record<LLMProvider["name"], string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const DEFAULT_MODELS: Record<LLMProvider["name"], string> = {
  anthropic: "claude-sonnet-4-6",
  google: "gemini-2.5-flash",
  openai: "gpt-4o",
  openrouter: "qwen/qwen3.6-plus",
};

export function resolveResearchBrainLLM(): {
  llm: LLM | null;
  providerName: LLMProvider["name"] | null;
  model: string | null;
} {
  const requested = (
    process.env.RESEARCH_BRAIN_LLM_PROVIDER ||
    process.env.STRUCTURED_LLM_PROVIDER ||
    process.env.PLANNING_LLM_PROVIDER ||
    ""
  ).toLowerCase() as LLMProvider["name"];

  const providerName =
    requested && process.env[PROVIDER_ENV_KEYS[requested]]
      ? requested
      : (Object.keys(PROVIDER_ENV_KEYS).find(
          (name) => process.env[PROVIDER_ENV_KEYS[name as LLMProvider["name"]]],
        ) as LLMProvider["name"] | undefined);

  if (!providerName) {
    return { llm: null, providerName: null, model: null };
  }

  const apiKey = process.env[PROVIDER_ENV_KEYS[providerName]];
  if (!apiKey) {
    return { llm: null, providerName: null, model: null };
  }

  const model =
    process.env.RESEARCH_BRAIN_LLM_MODEL ||
    process.env.STRUCTURED_LLM_MODEL ||
    process.env.PLANNING_LLM_MODEL ||
    DEFAULT_MODELS[providerName];

  return {
    llm: new LLM({ name: providerName, apiKey }),
    providerName,
    model,
  };
}
