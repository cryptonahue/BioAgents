/**
 * Centralized LLM provider/model resolution.
 *
 * Pure config module: imports nothing from src/llm, bullmq, or db. It NEVER
 * throws and NEVER mutates state — call sites decide how to react when a key is
 * missing (plain Error, UnrecoverableError, HTTP 503, etc.).
 *
 * All process.env reads happen INSIDE resolveLLM (not at module load) to avoid
 * TDZ issues in the Bun worker process.
 */

export type LLMProviderName = "anthropic" | "openrouter" | "openai" | "google";

export interface ResolveLLMOptions {
  /** Ordered env names for the provider hint, e.g. ["CHAT_AGENT_LLM_PROVIDER"]. */
  providerEnv: string[];
  /** Ordered env names for a model override, e.g. ["CHAT_AGENT_MODEL"]. */
  modelEnv?: string[];
  /** Providers this call site can actually execute. */
  allowed: LLMProviderName[];
  /**
   * strict = honor the hint/default; if the resolved provider's key is missing
   *          it is simply reported as not configured (no fallback).
   * auto   = honor the hint only if its key exists, otherwise fall back to the
   *          first allowed provider that has a configured key.
   */
  selection: "strict" | "auto";
  /** Provider used when the hint is absent or not in `allowed` (strict mode). */
  defaultProvider?: LLMProviderName;
}

export interface ResolvedLLM {
  provider: LLMProviderName;
  /** "" when the provider has no configured key. */
  apiKey: string;
  model: string;
  keyConfigured: boolean;
}

const KEY_ENV: Record<LLMProviderName, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
};

function readEnvChain(names: string[] | undefined): string {
  for (const name of names ?? []) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
}

function isProviderName(value: string): value is LLMProviderName {
  return (
    value === "anthropic" ||
    value === "openrouter" ||
    value === "openai" ||
    value === "google"
  );
}

export function resolveLLM(opts: ResolveLLMOptions): ResolvedLLM {
  // Built inside the function (not at module load) for TDZ safety in the worker.
  const defaultModels: Record<LLMProviderName, string> = {
    anthropic: process.env.DEFAULT_ANTHROPIC_MODEL || "claude-sonnet-4-6",
    openrouter: process.env.DEFAULT_OPENROUTER_MODEL || "minimax/minimax-m3",
    openai: process.env.DEFAULT_OPENAI_MODEL || "gpt-4o",
    google: process.env.DEFAULT_GOOGLE_MODEL || "gemini-2.5-pro",
  };

  const keys: Record<LLMProviderName, string> = {
    anthropic: process.env[KEY_ENV.anthropic] || "",
    openrouter: process.env[KEY_ENV.openrouter] || "",
    openai: process.env[KEY_ENV.openai] || "",
    google: process.env[KEY_ENV.google] || "",
  };

  const defaultProvider: LLMProviderName =
    opts.defaultProvider ?? opts.allowed[0] ?? "anthropic";

  const hint = readEnvChain(opts.providerEnv).toLowerCase();

  let provider: LLMProviderName;

  if (opts.selection === "strict") {
    // Honor the hint only if it is an allowed provider; otherwise the default.
    provider =
      isProviderName(hint) && opts.allowed.includes(hint)
        ? hint
        : defaultProvider;
  } else {
    // auto: honor the hint only when its key is configured, else fall back to
    // the first allowed provider that has a key, else the default.
    if (isProviderName(hint) && opts.allowed.includes(hint) && keys[hint]) {
      provider = hint;
    } else {
      provider =
        opts.allowed.find((p) => keys[p]) ?? defaultProvider;
    }
  }

  const apiKey = keys[provider] || "";
  const model = readEnvChain(opts.modelEnv) || defaultModels[provider];

  return {
    provider,
    apiKey,
    model,
    keyConfigured: apiKey.length > 0,
  };
}
