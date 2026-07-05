import logger from "../../utils/logger";
import type { BioprospectingFact } from "./types";
import { upsertBioprospectingContradiction } from "./contradictionDb";
import { resolveResearchBrainLLM } from "./llm";

function extractJsonArray(text: string): any[] {
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

interface LLMContradiction {
  sourceFactId: string;
  conflictingFactId: string;
  contradictionType: "contextual" | "measurement_impossibility" | "directional_conflict";
  explanation: string;
}

function buildFactsJson(facts: BioprospectingFact[]): string {
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
 * Runs only when BIOPROSPECTING_CONTRADICTION_DETECTION=true and an LLM is available.
 * Adds contradictions that rule-based detection would miss (contextual, measurement impossibility, etc.).
 */
export async function runLLMDetection(params: {
  facts: BioprospectingFact[];
  sourceId: string;
}): Promise<number> {
  if (process.env.BIOPROSPECTING_CONTRADICTION_DETECTION !== "true") {
    return 0;
  }

  const { llm, model } = resolveResearchBrainLLM();
  if (!llm || !model) {
    logger.debug("runLLMDetection: no LLM available, skipping");
    return 0;
  }

  const { facts, sourceId } = params;
  if (facts.length < 2) return 0;

  const factsJson = buildFactsJson(facts);
  if (!factsJson) return 0;

  const prompt = `You are a scientific fact consistency checker for marine bioprospecting research.

Given a set of facts about the same compound-target interaction extracted from different sources,
identify any contradictions that are not detectable by simple string matching.

For each fact, you receive:
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

If no contradictions, return [].

Facts:
${factsJson}

Respond only with the JSON array.`;

  let response;
  try {
    response = await llm.createChatCompletion({
      model,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 2000,
      temperature: 0,
    });
  } catch (err) {
    logger.error({ err }, "runLLMDetection: LLM call failed");
    return 0;
  }

  const raw = extractJsonArray(response.content);
  const contradictions = raw.filter(
    (item): item is LLMContradiction =>
      typeof item === "object" &&
      item !== null &&
      typeof item.sourceFactId === "string" &&
      typeof item.conflictingFactId === "string" &&
      typeof item.contradictionType === "string" &&
      typeof item.explanation === "string",
  );

  let inserted = 0;
  for (const c of contradictions) {
    const factA = facts.find((f) => f.id === c.sourceFactId);
    const factB = facts.find((f) => f.id === c.conflictingFactId);
    if (!factA || !factB) continue;

    const result = await upsertBioprospectingContradiction({
      factAId: c.sourceFactId,
      factBId: c.conflictingFactId,
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

  logger.info(
    { sourceId, llmInserted: inserted },
    "runLLMDetection_completed",
  );

  return inserted;
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
function mapLLMContradictionType(llmType: string): string {
  const mapping: Record<string, string> = {
    contextual: "bioactivity_mismatch",
    measurement_impossibility: "measurement_mismatch",
    directional_conflict: "measurement_mismatch",
  };
  return mapping[llmType] ?? "bioactivity_mismatch";
}
