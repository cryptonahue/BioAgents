import { getServiceClient } from "../../db/client";
import type {
  BioprospectingFact,
  ResearchBioprospectingContradiction,
} from "./types";

const supabase = getServiceClient();

export type ContradictionInsert = {
  factAId: string;
  factBId: string;
  conflictType: string;
  severity?: string;
  explanation?: string | null;
  metadata?: Record<string, unknown>;
};

export type ContradictionSearchResult = ResearchBioprospectingContradiction & {
  fact_a?: BioprospectingFact & { source?: { id: string; title: string; doi: string | null } };
  fact_b?: BioprospectingFact & { source?: { id: string; title: string; doi: string | null } };
};

/**
 * Upsert a single bioprospecting contradiction.
 * Skips insert if an identical contradiction already exists (same fact_a_id,
 * fact_b_id, and conflict_type).
 */
export async function upsertBioprospectingContradiction(
  params: ContradictionInsert,
): Promise<ResearchBioprospectingContradiction | null> {
  const { data: existing } = await supabase
    .from("research_bioprospecting_contradictions")
    .select("id")
    .eq("fact_a_id", params.factAId)
    .eq("fact_b_id", params.factBId)
    .eq("conflict_type", params.conflictType)
    .maybeSingle();

  if (existing) {
    return null;
  }

  const { data, error } = await supabase
    .from("research_bioprospecting_contradictions")
    .insert({
      fact_a_id: params.factAId,
      fact_b_id: params.factBId,
      conflict_type: params.conflictType,
      severity: params.severity ?? "medium",
      explanation: params.explanation ?? null,
      metadata: params.metadata ?? {},
      status: "open",
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as ResearchBioprospectingContradiction;
}

/**
 * Search for contradictions where either the fact_a_id or fact_b_id
 * appears in the provided factIds list.
 * Returns only open contradictions by default.
 */
export async function searchBioprospectingContradictions(params: {
  factIds: string[];
  includeResolved?: boolean;
}): Promise<ResearchBioprospectingContradiction[]> {
  if (params.factIds.length === 0) return [];

  const factIds = params.factIds.join(",");
  let query = supabase
    .from("research_bioprospecting_contradictions")
    .select(
      // Nested FK joins: fact_a_id and fact_b_id both reference
      // research_bioprospecting_facts, which in turn references
      // research_sources via its own source_id FK.
      "*, fact_a:research_bioprospecting_facts!fact_a_id(*, source:research_sources(*)), fact_b:research_bioprospecting_facts!fact_b_id(*, source:research_sources(*))",
    )
    .or(
      `fact_a_id.in.(${factIds}),fact_b_id.in.(${factIds})`,
    );

  if (!params.includeResolved) {
    query = query.eq("status", "open");
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as ResearchBioprospectingContradiction[];
}

/**
 * Resolve or dismiss a contradiction by updating its status.
 */
export async function resolveBioprospectingContradiction(params: {
  contradictionId: string;
  resolutionStatus: "resolved" | "dismissed";
  resolvedBy?: string;
  resolutionNote?: string;
}): Promise<ResearchBioprospectingContradiction> {
  const { data, error } = await supabase
    .from("research_bioprospecting_contradictions")
    .update({
      status: params.resolutionStatus,
      resolved_by: params.resolvedBy || null,
      resolved_at: new Date().toISOString(),
      resolution_note: params.resolutionNote || null,
    })
    .eq("id", params.contradictionId)
    .select("*")
    .single();

  if (error) throw error;
  return data as ResearchBioprospectingContradiction;
}