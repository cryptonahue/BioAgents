import logger from "../../utils/logger";
import type { BioprospectingFact } from "./types";
import { upsertBioprospectingContradiction } from "./contradictionDb";
import { resolveResearchBrainLLM } from "./llm";
import { calculateCost, recordLlmCall } from "./llm-cost";

export function extractJsonArray(text: string): any[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] || text) as string;
  // Walk from the end: for each ']', find the matching '[' and try to parse.
  // This handles inputs with multiple concatenated arrays (e.g. "[1,2,3][4,5,6]")
  // by always returning the LAST well-formed array.
  for (let end = candidate.lastIndexOf("]"); end > 0; end = candidate.lastIndexOf("]", end - 1)) {
    let depth = 0;
    for (let start = end; start >= 0; start--) {
      const ch = candidate[start];
      if (ch === "]") depth++;
      else if (ch === "[") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(candidate.slice(start, end + 1));
            if (Array.isArray(parsed)) return parsed;
          } catch {
            // try the previous closing bracket
          }
          break;
        }
      }
    }
  }
  return [];
}

export interface LLMContradiction {
  sourceFactId: string;
  conflictingFactId: string;
  contradictionType: "contextual" | "measurement_impossibility" | "directional_conflict";
  explanation: string;
}

export function isLLMContradiction(item: unknown): item is LLMContradiction {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof (item as any).sourceFactId === "string" &&
    typeof (item as any).conflictingFactId === "string" &&
    typeof (item as any).contradictionType === "string" &&
    typeof (item as any).explanation === "string"
  );
}

/**
 * Outcome of one LLM detection pass.
 *
 * `proposed` / `resolved` / `dropped` exist so a dead run can never look
 * like a successful one again: before this contract the module only
 * reported `inserted`, and a 100% join failure (the model returning ids
 * it was never shown) logged `{ llmInserted: 0 }` as a success.
 */
export interface LLMDetectionResult {
  /** Well-formed contradiction objects returned by the model. */
  proposed: number;
  /** Proposals whose BOTH fact ids joined back to a fact in the payload. */
  resolved: number;
  /** Proposals dropped because at least one id is unknown. */
  dropped: number;
  /** Rows actually written (a duplicate upsert returns null and is not counted). */
  inserted: number;
}

/**
 * Below this join rate (resolved / proposed) the run is treated as a
 * contract failure and logged at ERROR level, not silently skipped.
 */
export const JOIN_RATE_ERROR_THRESHOLD = 0.5;

/** Cap on how many unknown ids we echo back into the error log. */
const UNKNOWN_ID_SAMPLE_SIZE = 5;

/**
 * Serialize the facts the model must reason over.
 *
 * The `id` field is REQUIRED: the prompt asks the model to answer with
 * `sourceFactId` / `conflictingFactId` UUIDs, and the insert path joins
 * those ids back against this exact fact set. Omitting `id` here (the
 * original bug) makes every proposal unjoinable, so every LLM run was
 * dead on arrival while still paying for the call.
 */
export function buildFactsJson(facts: BioprospectingFact[]): string {
  const grouped = new Map<string, BioprospectingFact[]>();
  for (const fact of facts) {
    const key = `${fact.compound ?? ""}|${fact.bioactivity ?? ""}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(fact);
  }

  const lines: string[] = [];
  for (const [, groupFacts] of grouped) {
    if (groupFacts.length < 2) continue;
    for (const fact of groupFacts) {
      lines.push(
        JSON.stringify({
          id: fact.id,
          compound: fact.compound ?? null,
          bioactivity: fact.bioactivity ?? null,
          measurement_direction: fact.measurement_direction ?? null,
          relation_type: fact.relation_type ?? null,
          result_summary: fact.result_summary ?? null,
          source_title: fact.source?.title ?? null,
          page: fact.page ?? null,
        }),
      );
    }
  }
  return lines.join("\n");
}

/**
 * LLM-assisted semantic contradiction detection.
 *
 * Gated by TWO flags:
 *   - BIOPROSPECTING_CONTRADICTION_DETECTION — the whole feature
 *   - BIOPROSPECTING_CONTRADICTION_LLM       — this (paid) tier only,
 *     default OFF, so the free rule-based tier can run without spending.
 *
 * Adds contradictions that rule-based detection would miss (contextual,
 * measurement impossibility, etc.).
 */
export async function runLLMDetection(params: {
  facts: BioprospectingFact[];
  sourceId: string;
  /** Ingestion run id — used to attribute the LLM spend via recordLlmCall. */
  runId?: string;
}): Promise<LLMDetectionResult> {
  const empty: LLMDetectionResult = {
    proposed: 0,
    resolved: 0,
    dropped: 0,
    inserted: 0,
  };

  if (process.env.BIOPROSPECTING_CONTRADICTION_DETECTION !== "true") {
    return empty;
  }
  if (process.env.BIOPROSPECTING_CONTRADICTION_LLM !== "true") {
    logger.debug("runLLMDetection: LLM tier flag disabled, skipping");
    return empty;
  }

  const { llm, providerName, model } = resolveResearchBrainLLM();
  if (!llm || !model) {
    logger.debug("runLLMDetection: no LLM available, skipping");
    return empty;
  }

  const { facts, sourceId, runId } = params;
  if (facts.length < 2) return empty;

  const factsJson = buildFactsJson(facts);
  if (!factsJson) return empty;

  const prompt = `You are a scientific fact consistency checker for marine bioprospecting research.

Given a set of facts about the same compound-target interaction extracted from different sources,
identify any contradictions that are not detectable by simple string matching.

For each fact, you receive:
- id: the fact's UUID — use this EXACT value when referring to the fact
- compound: the molecule name
- bioactivity: the biological target/activity
- measurement_direction: e.g. agonist, antagonist, activator, inhibitor, increase, decrease
- relation_type: e.g. activates, inhibits, upregulates, downregulates
- result_summary: human-readable summary of the finding
- source_title: title of the paper
- page: page number in source

Check for contextual contradictions that rule-based detection would miss, such as:
- The same compound described as having opposite effects in different assay conditions
- Conflicting claims about whether a compound activates or inhibits the same target
- Numbers that are physically impossible or mutually exclusive (e.g., 1000% increase vs 5% decrease)

Return a JSON array of contradictions found. Each object:
{
  "sourceFactId": "uuid of first fact",
  "conflictingFactId": "uuid of second fact",
  "contradictionType": "contextual" | "measurement_impossibility" | "directional_conflict",
  "explanation": "why these two facts contradict each other"
}

Both ids MUST be copied verbatim from the "id" field of the facts below. Never invent an id.

If no contradictions, return [].

Facts:
${factsJson}

Respond only with the JSON array.`;

  const startedAt = Date.now();
  let response;
  try {
    response = await llm.createChatCompletion({
      model,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 2000,
      temperature: 0,
    });
  } catch (err) {
    logger.error({ err, sourceId }, "runLLMDetection: LLM call failed");
    return empty;
  }
  const latencyMs = Date.now() - startedAt;

  // Cost accounting. The call has already been paid for at this point,
  // so record it even if parsing/joining later fails — an untracked
  // tier is how this one burned tokens unnoticed for its whole lifetime.
  await recordLLMDetectionCost({
    runId,
    sourceId,
    providerName,
    model,
    response,
    latencyMs,
  });

  const raw = extractJsonArray(response.content);
  const contradictions = raw.filter(isLLMContradiction);

  const factsById = new Map(facts.map((f) => [f.id, f]));

  let inserted = 0;
  let resolved = 0;
  const unknownIds: string[] = [];

  for (const c of contradictions) {
    const factA = factsById.get(c.sourceFactId);
    const factB = factsById.get(c.conflictingFactId);

    if (!factA || !factB) {
      // NOT a silent `continue`: every unjoinable proposal is counted
      // and surfaced in the summary + the join-rate assertion below.
      if (!factA) unknownIds.push(c.sourceFactId);
      if (!factB) unknownIds.push(c.conflictingFactId);
      continue;
    }
    resolved++;

    const result = await upsertBioprospectingContradiction({
      factAId: factA.id,
      factBId: factB.id,
      conflictType: mapLLMContradictionType(c.contradictionType),
      explanation: c.explanation,
      metadata: {
        source_a: {
          fact_id: factA.id,
          source: factA.source?.title || factA.doi || "unknown source",
          value: factA.measurement_direction || factA.relation_type || "",
          provenance: buildProvenance(factA),
        },
        source_b: {
          fact_id: factB.id,
          source: factB.source?.title || factB.doi || "unknown source",
          value: factB.measurement_direction || factB.relation_type || "",
          provenance: buildProvenance(factB),
        },
        conflict_summary: c.explanation,
      },
    });
    if (result) inserted++;
  }

  const proposed = contradictions.length;
  const dropped = proposed - resolved;
  const result: LLMDetectionResult = { proposed, resolved, dropped, inserted };

  assertJoinRate({ sourceId, model, factCount: facts.length, unknownIds, result });

  logger.info(
    {
      sourceId,
      llmProposed: proposed,
      llmResolved: resolved,
      llmDropped: dropped,
      llmInserted: inserted,
    },
    "runLLMDetection_completed",
  );

  return result;
}

/**
 * Join-rate assertion.
 *
 * The insert path can only write a row when BOTH ids returned by the
 * model join back to a fact we actually sent. A low join rate means the
 * prompt/payload contract is broken (that is exactly what the missing
 * `id` field caused) — it is a defect, not a quiet no-op, so it is
 * logged at ERROR level with the evidence needed to debug it.
 */
function assertJoinRate(params: {
  sourceId: string;
  model: string;
  factCount: number;
  unknownIds: string[];
  result: LLMDetectionResult;
}): void {
  const { sourceId, model, factCount, unknownIds, result } = params;
  const { proposed, resolved, dropped } = result;
  if (proposed === 0) return;

  const joinRate = resolved / proposed;
  if (resolved > 0 && joinRate >= JOIN_RATE_ERROR_THRESHOLD) return;

  logger.error(
    {
      sourceId,
      model,
      factCount,
      llmProposed: proposed,
      llmResolved: resolved,
      llmDropped: dropped,
      joinRate: Math.round(joinRate * 100) / 100,
      threshold: JOIN_RATE_ERROR_THRESHOLD,
      unknownFactIdSample: unknownIds.slice(0, UNKNOWN_ID_SAMPLE_SIZE),
    },
    "runLLMDetection_join_rate_failure",
  );
}

/**
 * Record the (already-incurred) cost of the detection call. Accounting
 * only — there is no cap here; extending the cost-cap `ApiProvider`
 * union is tracked separately.
 */
async function recordLLMDetectionCost(params: {
  runId?: string;
  sourceId: string;
  providerName: string | null;
  model: string;
  response: { usage?: { promptTokens: number; completionTokens: number } };
  latencyMs: number;
}): Promise<void> {
  const { runId, sourceId, providerName, model, response, latencyMs } = params;
  if (!runId || !providerName) {
    logger.warn(
      { sourceId, providerName, model, hasRunId: Boolean(runId) },
      "runLLMDetection_cost_not_attributed",
    );
    return;
  }

  const inputTokens = response.usage?.promptTokens ?? 0;
  const outputTokens = response.usage?.completionTokens ?? 0;
  const { costUsd } = calculateCost(providerName, model, inputTokens, outputTokens);

  await recordLlmCall(runId, {
    provider: providerName,
    model,
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs,
    timestamp: new Date().toISOString(),
  });
}

function buildProvenance(fact: BioprospectingFact): string {
  const parts: string[] = [];
  if (fact.page != null) parts.push(`page ${fact.page}`);
  if (fact.chunk?.chunk_index != null) parts.push(`chunk ${fact.chunk.chunk_index}`);
  return parts.length > 0 ? parts.join(", ") : "unknown location";
}

/**
 * Map LLM-returned contradiction types to the schema's check constraint values:
 * 'compound_mismatch' | 'bioactivity_mismatch' | 'organism_mismatch' | 'measurement_mismatch'
 */
export function mapLLMContradictionType(llmType: string): string {
  const mapping: Record<string, string> = {
    contextual: "bioactivity_mismatch",
    measurement_impossibility: "measurement_mismatch",
    directional_conflict: "measurement_mismatch",
  };
  return mapping[llmType] ?? "bioactivity_mismatch";
}
