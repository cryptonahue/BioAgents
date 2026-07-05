/**
 * LLM Cost Tracking for Research Brain Ingestion
 *
 * Provides:
 * - Provider pricing map (OpenAI, Anthropic, Google, OpenRouter)
 * - calculateCost() to compute USD cost from token counts (LLMs)
 *   or units (external providers like mistral-ocr / pubchem)
 * - recordLlmCall() to persist a call record via Supabase RPC
 *
 * The `calculateCost` return shape is `{ costUsd, units }` so it can
 * serve both LLM providers (units = tokens) and external API
 * providers (units = pages, requests, etc.) that participate in the
 * `api-cost-guard-rails` cost-cap infrastructure.
 */

import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";

// Provider pricing: input cost per 1M tokens, output cost per 1M tokens
const LLM_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  // OpenAI
  "gpt-4o": { inputPer1M: 3.0, outputPer1M: 12.0 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4-turbo": { inputPer1M: 10.0, outputPer1M: 30.0 },
  "gpt-4": { inputPer1M: 30.0, outputPer1M: 60.0 },
  "gpt-3.5-turbo": { inputPer1M: 0.5, outputPer1M: 1.5 },
  // Anthropic
  "claude-opus-4": { inputPer1M: 18.0, outputPer1M: 90.0 },
  "claude-sonnet-4": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-5-sonnet": { inputPer1M: 1.5, outputPer1M: 7.5 },
  "claude-3-opus": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-3-sonnet": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-haiku": { inputPer1M: 0.25, outputPer1M: 1.25 },
  // Google
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10.0 },
  "gemini-2.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
  "gemini-2.0-pro": { inputPer1M: 0.0, outputPer1M: 0.0 }, // free
  "gemini-1.5-pro": { inputPer1M: 1.25, outputPer1M: 5.0 },
  "gemini-1.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
  // OpenRouter (varies by underlying provider, use a blended estimate)
  "openrouter/gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "openrouter/claude-3-haiku": { inputPer1M: 0.25, outputPer1M: 1.25 },
};

// External API providers tracked under api-cost-guard-rails. The
// pricing for these is per-unit (pages for mistral-ocr; requests for
// pubchem, which is free in dollars but rate-limited).
const EXTERNAL_PROVIDER_PRICING: Record<
  string,
  { costPerUnit: number; unitsLabel: string }
> = {
  // mistral-ocr: $0.05 per page by default; overridable via
  // MISTRAL_OCR_COST_PER_PAGE_USD at call time (calculateCost reads
  // process.env on every call to match the env-driven cap model).
  "mistral-ocr": { costPerUnit: 0.05, unitsLabel: "pages" },
  // pubchem: free, but we still track the unit count for the
  // PUBCHEM_DAILY_REQUEST_CAP enforcement.
  pubchem: { costPerUnit: 0, unitsLabel: "requests" },
};

export interface LlmCallEntry {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  timestamp: string;
}

/**
 * Result of a cost calculation. Always carries both `costUsd` and
 * `units` so the same shape works for LLM token-based billing
 * (units = tokens) and external API unit-based billing (units =
 * pages, requests, etc.).
 */
export interface CostResult {
  costUsd: number;
  units: number;
}

/**
 * Calculate USD cost for a call. Supports:
 *   - LLM providers (e.g. "openai/gpt-4o"): costUsd derived from
 *     input/output token counts against the LLM_PRICING table.
 *   - External API providers ("mistral-ocr", "pubchem"): costUsd
 *     derived from `units` against the EXTERNAL_PROVIDER_PRICING
 *     table. Pubchem is always $0; mistral-ocr defaults to $0.05
 *     per page and is overridable via
 *     MISTRAL_OCR_COST_PER_PAGE_USD.
 *
 * The function never throws on unknown providers; it returns
 * `{ costUsd: 0, units: <passthrough> }` and logs a WARN.
 */
export function calculateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  // Optional external-API unit count. For LLM calls this is
  // ignored and the token-based cost is returned. For external
  // providers (mistral-ocr, pubchem) this is the authoritative
  // unit count.
  externalUnits?: number,
): CostResult {
  // External API providers (mistral-ocr, pubchem).
  const external = EXTERNAL_PROVIDER_PRICING[provider];
  if (external) {
    const units = externalUnits ?? 0;
    if (provider === "mistral-ocr") {
      const raw = process.env.MISTRAL_OCR_COST_PER_PAGE_USD;
      const costPerPage = raw != null && raw !== "" && !Number.isNaN(Number(raw))
        ? Number(raw)
        : external.costPerUnit;
      const costUsd = Math.round(units * costPerPage * 1_000_000) / 1_000_000;
      return { costUsd, units };
    }
    // pubchem (and any future free-but-capped external provider).
    return { costUsd: 0, units };
  }

  // LLM providers: token-based pricing.
  const key = `${provider}/${model}`;
  const pricing = LLM_PRICING[key] ?? LLM_PRICING[model];

  if (!pricing) {
    logger.warn({ provider, model }, "llm_cost_unknown_pricing");
    // For LLM calls the "units" is the sum of input + output tokens
    // — surfaces the volume even when pricing is unknown.
    return { costUsd: 0, units: inputTokens + outputTokens };
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;
  const costUsd =
    Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
  return { costUsd, units: inputTokens + outputTokens };
}

/**
 * Record an LLM call to the run's llm_calls JSONB and accumulate cost
 * Uses the record_llm_call Supabase RPC for atomicity
 */
export async function recordLlmCall(
  runId: string,
  entry: LlmCallEntry,
): Promise<void> {
  try {
    const supabase = getServiceClient();
    const { error } = await supabase.rpc("record_llm_call", {
      p_run_id: runId,
      p_provider: entry.provider,
      p_model: entry.model,
      p_input_tokens: entry.inputTokens,
      p_output_tokens: entry.outputTokens,
      p_cost_usd: entry.costUsd,
      p_latency_ms: entry.latencyMs,
    });

    if (error) {
      logger.error({ err: error, runId }, "record_llm_call_failed");
    }
  } catch (error) {
    logger.error({ err: error, runId }, "record_llm_call_exception");
  }
}
