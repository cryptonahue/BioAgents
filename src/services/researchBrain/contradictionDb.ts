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
 * The natural key of a contradiction row. Backed by the unique index
 * `uniq_contradictions_fact_pair_type` (migration 20260711030000), which is what
 * makes the ON CONFLICT below legal in PostgREST.
 */
export const CONTRADICTION_NATURAL_KEY = "fact_a_id,fact_b_id,conflict_type";

export type ContradictionUpsertResult = {
  row: ResearchBioprospectingContradiction;
  /** false when the natural key already existed (the row was refreshed, not created). */
  created: boolean;
};

/**
 * Idempotent upsert on (fact_a_id, fact_b_id, conflict_type).
 *
 * The previous implementation was SELECT-then-INSERT against a table with NO
 * unique index: two concurrent runs — or one re-run racing itself — could
 * duplicate a row, and a corpus-wide sweep re-run would have flooded the review
 * queue with copies. The unique index plus ON CONFLICT makes a re-run a no-op
 * at the DB level, not just at the application level.
 *
 * `status` is deliberately NOT in the payload. PostgREST builds the ON CONFLICT
 * update list from the payload keys, so omitting it means:
 *   - INSERT -> the column default ('open') applies;
 *   - CONFLICT -> an operator's `resolved` / `dismissed` decision is PRESERVED.
 * A re-detection must never resurrect a dismissed contradiction.
 *
 * `metadata` / `severity` / `explanation` ARE refreshed: on a cross-source
 * sweep the group can grow (a new paper joins the conflict) and the row's
 * evidence pack must keep up.
 */
export async function upsertBioprospectingContradictionRow(
  params: ContradictionInsert,
): Promise<ContradictionUpsertResult> {
  const { data: existing } = await supabase
    .from("research_bioprospecting_contradictions")
    .select("id")
    .eq("fact_a_id", params.factAId)
    .eq("fact_b_id", params.factBId)
    .eq("conflict_type", params.conflictType)
    .maybeSingle();

  const { data, error } = await supabase
    .from("research_bioprospecting_contradictions")
    .upsert(
      {
        fact_a_id: params.factAId,
        fact_b_id: params.factBId,
        conflict_type: params.conflictType,
        severity: params.severity ?? "medium",
        explanation: params.explanation ?? null,
        metadata: params.metadata ?? {},
      },
      { onConflict: CONTRADICTION_NATURAL_KEY },
    )
    .select("*")
    .single();

  if (error) throw error;
  return {
    row: data as ResearchBioprospectingContradiction,
    created: !existing,
  };
}

/**
 * Upsert a single bioprospecting contradiction.
 * Returns `null` when the contradiction already existed (same fact_a_id,
 * fact_b_id, conflict_type) so callers can keep counting NEW rows; the row is
 * still refreshed idempotently underneath.
 */
export async function upsertBioprospectingContradiction(
  params: ContradictionInsert,
): Promise<ResearchBioprospectingContradiction | null> {
  const result = await upsertBioprospectingContradictionRow(params);
  return result.created ? result.row : null;
}

/**
 * Corpus-wide fact loader for the cross-source contradiction sweep.
 *
 * Deliberately lives here and NOT in `db.ts`: the intra-source loader
 * (`getBioprospectingFactsForSource`) filters `.eq("source_id", sourceId)`,
 * which is exactly the constraint the cross-source tier must escape.
 *
 * - Only facts with a `compound_canonical_id` are returned: the canonical id is
 *   the group key's compound half, and a fact without one cannot be matched to
 *   the same molecule in another paper.
 * - Facts merged into a canonical twin (`merged_into_fact_id IS NOT NULL`) are
 *   excluded — semantic-dedup already collapsed them, and counting both copies
 *   would inflate a conflict's fact/source counts.
 * - Paginated: PostgREST caps a response at ~1000 rows by default, and the
 *   corpus is expected to grow well past that.
 */
export async function getBioprospectingFactsForCrossSource(params?: {
  pageSize?: number;
}): Promise<BioprospectingFact[]> {
  const pageSize = Math.max(1, Math.min(1000, params?.pageSize ?? 1000));
  const all: BioprospectingFact[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("research_bioprospecting_facts")
      .select("*, source:research_sources(id, title, doi)")
      .not("compound_canonical_id", "is", null)
      .is("merged_into_fact_id", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    const batch = (data || []) as BioprospectingFact[];
    all.push(...batch);
    if (batch.length < pageSize) break;
  }

  return all;
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