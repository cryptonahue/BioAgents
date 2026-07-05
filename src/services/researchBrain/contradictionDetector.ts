import logger from "../../utils/logger";
import type { BioprospectingFact } from "./types";
import { upsertBioprospectingContradiction } from "./contradictionDb";
import { getBioprospectingFactsForSource } from "./db";
import { normalizeForMatch } from "./search";
import { runLLMDetection } from "./contradictionLlM";

const MEASUREMENT_DIRECTION_OPPOSITES: Record<string, string> = {
  agonist: "antagonist",
  antagonist: "agonist",
  activator: "inhibitor",
  inhibitor: "activator",
  upregulator: "downregulator",
  downregulator: "upregulator",
  increase: "decrease",
  decrease: "increase",
};

const RELATION_TYPE_OPPOSITES: Record<string, string> = {
  activates: "inhibits",
  inhibits: "activates",
  upregulates: "downregulates",
  downregulates: "upregulates",
  increases: "decreases",
  decreases: "increases",
};

function buildKey(fact: BioprospectingFact): string | null {
  const compound = fact.compound;
  const bioactivity = fact.bioactivity;
  if (!compound || !bioactivity) return null;
  return `${normalizeForMatch(compound)}|${normalizeForMatch(bioactivity)}`;
}

function buildMetadata(
  factA: BioprospectingFact,
  factB: BioprospectingFact,
  field: "measurement_direction" | "relation_type",
  valueA: string,
  valueB: string,
): Record<string, unknown> {
  const sourceA = factA.source?.title || factA.doi || "unknown source";
  const sourceB = factB.source?.title || factB.doi || "unknown source";
  const provenanceA = buildProvenance(factA);
  const provenanceB = buildProvenance(factB);

  return {
    source_a: {
      fact_id: factA.id,
      source: sourceA,
      value: valueA,
      provenance: provenanceA,
    },
    source_b: {
      fact_id: factB.id,
      source: sourceB,
      value: valueB,
      provenance: provenanceB,
    },
    conflict_summary: `Conflicting ${field}: ${valueA} vs ${valueB}`,
  };
}

function buildProvenance(fact: BioprospectingFact): string {
  const parts: string[] = [];
  if (fact.page != null) parts.push(`page ${fact.page}`);
  if (fact.chunk?.chunk_index != null) parts.push(`chunk ${fact.chunk.chunk_index}`);
  return parts.length > 0 ? parts.join(", ") : "unknown location";
}

/**
 * Rule-based contradiction detection.
 * Matches facts on normalized compound + bioactivity pair, then checks for
 * opposite measurement_direction or relation_type values.
 *
 * Returns the number of contradictions inserted.
 */
export async function runRuleBasedDetection(params: {
  facts: BioprospectingFact[];
  sourceId: string;
  runId: string;
}): Promise<number> {
  const { facts, sourceId } = params;
  if (facts.length < 2) return 0;

  // Group facts by compound|bioactivity key
  const groups = new Map<string, BioprospectingFact[]>();
  for (const fact of facts) {
    const key = buildKey(fact);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(fact);
  }

  let inserted = 0;

  for (const [, groupFacts] of groups) {
    if (groupFacts.length < 2) continue;

    // Check measurement_direction opposites
    const byDirection = new Map<string, BioprospectingFact[]>();
    for (const fact of groupFacts) {
      const dir = fact.measurement_direction?.toLowerCase();
      if (!dir) continue;
      if (!byDirection.has(dir)) byDirection.set(dir, []);
      byDirection.get(dir)!.push(fact);
    }

    for (const [dir, dirFacts] of byDirection) {
      const opposite = MEASUREMENT_DIRECTION_OPPOSITES[dir];
      if (!opposite) continue;
      const oppositeFacts = byDirection.get(opposite);
      if (!oppositeFacts) continue;

      for (const factA of dirFacts) {
        for (const factB of oppositeFacts) {
          if (factA.id >= factB.id) continue; // avoid symmetric pairs
          const metadata = buildMetadata(
            factA,
            factB,
            "measurement_direction",
            factA.measurement_direction!,
            factB.measurement_direction!,
          );
          const result = await upsertBioprospectingContradiction({
            factAId: factA.id,
            factBId: factB.id,
            conflictType: "compound_mismatch",
            metadata,
          });
          if (result) inserted++;
        }
      }
    }

    // Check relation_type opposites
    const byRelation = new Map<string, BioprospectingFact[]>();
    for (const fact of groupFacts) {
      const rel = fact.relation_type?.toLowerCase();
      if (!rel) continue;
      if (!byRelation.has(rel)) byRelation.set(rel, []);
      byRelation.get(rel)!.push(fact);
    }

    for (const [rel, relFacts] of byRelation) {
      const opposite = RELATION_TYPE_OPPOSITES[rel];
      if (!opposite) continue;
      const oppositeFacts = byRelation.get(opposite);
      if (!oppositeFacts) continue;

      for (const factA of relFacts) {
        for (const factB of oppositeFacts) {
          if (factA.id >= factB.id) continue;
          const metadata = buildMetadata(
            factA,
            factB,
            "relation_type",
            factA.relation_type,
            factB.relation_type,
          );
          const result = await upsertBioprospectingContradiction({
            factAId: factA.id,
            factBId: factB.id,
            conflictType: "bioactivity_mismatch",
            metadata,
          });
          if (result) inserted++;
        }
      }
    }
  }

  logger.info(
    { sourceId, ruleBasedInserted: inserted, totalFacts: facts.length },
    "runRuleBasedDetection_completed",
  );

  return inserted;
}

export interface ContradictionDetectionOptions {
  force?: boolean;
}

/**
 * Orchestrates contradiction detection for a source:
 * 1. Fetches all bioprospecting facts for the source
 * 2. Runs rule-based detection
 * 3. Runs LLM detection (if flag is enabled and LLM is available)
 *
 * Returns the total number of contradictions inserted.
 */
export async function runContradictionDetection(params: {
  sourceId: string;
  runId: string;
  options?: ContradictionDetectionOptions;
}): Promise<{ ruleBased: number; llm: number; total: number }> {
  if (process.env.BIOPROSPECTING_CONTRADICTION_DETECTION !== "true") {
    logger.debug("runContradictionDetection: flag disabled, skipping");
    return { ruleBased: 0, llm: 0, total: 0 };
  }

  const { sourceId } = params;

  const facts = await getBioprospectingFactsForSource(sourceId);
  if (facts.length < 2) {
    logger.debug({ sourceId, factCount: facts.length }, "runContradictionDetection: insufficient facts");
    return { ruleBased: 0, llm: 0, total: 0 };
  }

  const ruleBased = await runRuleBasedDetection({ facts, sourceId, runId: params.runId });
  const llm = await runLLMDetection({ facts, sourceId });

  logger.info(
    { sourceId, ruleBased, llm, total: ruleBased + llm },
    "runContradictionDetection_completed",
  );

  return { ruleBased, llm, total: ruleBased + llm };
}
