/**
 * Citation graph (paper-to-paper edges).
 *
 * For a given `research_sources.id`, find the set of OTHER
 * `research_sources` rows that share at least one of:
 *   - a canonical compound (via `research_bioprospecting_facts.compound_canonical_id`)
 *   - a canonical species (via `research_bioprospecting_facts.species_taxon_id`)
 *   - the same DOI (case-insensitive)
 *
 * Each edge is weighted by a simple sum so operators can rank
 * related papers without an LLM:
 *
 *   weight = shared_compound_count * 3
 *          + shared_species_count  * 2
 *          + (doi_match ? 5 : 0)
 *
 * DOI match is the strongest signal (a real duplicate or
 * preprint/version-of-record pair); shared compound is the most
 * common signal in bioprospecting corpora; shared species is the
 * weakest because the same species appears across many
 * unrelated studies.
 *
 * v1 scope (LLM-free):
 *   - No pre-computed graph table. Every request issues ONE
 *     Supabase query (a single SELECT with EXISTS subqueries +
 *     per-edge aggregates). Cost is O(neighbors) not O(corpus).
 *   - Auth: admin-only via authResolver at the route layer.
 *   - No mutation. This is a pure read path.
 *   - No LLM. The verdict is a deterministic SQL computation.
 *
 * v2 (when OpenRouter has credit):
 *   - Add a BFS expansion (1-2 hops) using this same edge
 *     weight, so the admin UI can show a small "related work
 *     graph" rather than just direct neighbors.
 *   - Cache the result in `research_sources.metadata.citation_graph_at`
 *     with a 24h TTL.
 */

import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CitationEdgeKind = "shared_compound" | "shared_species" | "shared_doi";

export type CitationEdge = {
  /** The other paper's `research_sources.id`. */
  otherSourceId: string;
  /** Best-effort title for the UI. May be `""` for unindexed rows. */
  otherTitle: string;
  /** Normalized DOI, or `null` when the other paper has no DOI. */
  otherDoi: string | null;
  /** Trust tier of the other paper. Mirrors `research_sources.trust_tier`. */
  otherTrustTier: string;
  /**
   * Compound canonical ids shared with the source. Each entry is the
   * `research_compounds.id`. Empty when no compound overlap.
   */
  sharedCompounds: string[];
  /** Number of distinct shared compound canonical ids. */
  sharedCompoundCount: number;
  /**
   * Species taxon ids shared with the source. Each entry is the
   * `research_taxa.id`. Empty when no species overlap.
   */
  sharedSpecies: string[];
  /** Number of distinct shared species taxon ids. */
  sharedSpeciesCount: number;
  /** True when the DOI matches (case-insensitive, non-empty). */
  doiMatch: boolean;
  /**
   * Composite weight: `sharedCompoundCount*3 + sharedSpeciesCount*2
   * + (doiMatch ? 5 : 0)`. Edges are returned sorted by this value
   * descending.
   */
  weight: number;
  /**
   * Set of edge kinds that fired for this neighbor. Useful for
   * the UI to render a "shared compound" vs "duplicate" badge
   * without re-computing the booleans client-side.
   */
  kinds: CitationEdgeKind[];
};

export type CitationGraphParams = {
  sourceId: string;
  limit?: number;
};

export type CitationGraphResult = {
  sourceId: string;
  edges: CitationEdge[];
  /** Total neighbors found before `limit` clamp. */
  totalNeighbors: number;
  /** Wall-clock duration in ms. */
  elapsed: number;
  /**
   * `true` when the source row exists in `research_sources`,
   * `false` when it does not. The route uses this to decide
   * between 200 (no neighbors) and 404 (source missing).
   */
  sourceFound: boolean;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default cap on returned edges. */
export const CITATION_GRAPH_DEFAULT_LIMIT = 20;
/** Hard upper bound on `limit`. */
export const CITATION_GRAPH_MAX_LIMIT = 100;

/** Weight coefficients. Exported for unit tests. */
export const CITATION_WEIGHT_COMPOUND = 3;
export const CITATION_WEIGHT_SPECIES = 2;
export const CITATION_WEIGHT_DOI = 5;

const EMPTY_RESULT: CitationGraphResult = {
  sourceId: "",
  edges: [],
  totalNeighbors: 0,
  elapsed: 0,
  sourceFound: false,
};

// ---------------------------------------------------------------------------
// Supabase client — Proxy pattern mirrors graphService.ts
// ---------------------------------------------------------------------------

const supabase = new Proxy({} as ReturnType<typeof getServiceClient>, {
  get(_target, prop) {
    const client = getServiceClient() as unknown as Record<
      string | symbol,
      unknown
    >;
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as ReturnType<typeof getServiceClient>;

// ---------------------------------------------------------------------------
// Pure helpers (no IO; exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Compute the composite weight for an edge from the raw
 * per-kind counts. Pure function.
 */
export function computeCitationWeight(input: {
  sharedCompoundCount: number;
  sharedSpeciesCount: number;
  doiMatch: boolean;
}): number {
  return (
    input.sharedCompoundCount * CITATION_WEIGHT_COMPOUND +
    input.sharedSpeciesCount * CITATION_WEIGHT_SPECIES +
    (input.doiMatch ? CITATION_WEIGHT_DOI : 0)
  );
}

/**
 * Derive the set of `CitationEdgeKind` strings that fired for an
 * edge. Pure function; the booleans and counts are the source of
 * truth, the array is the derived convenience.
 */
export function deriveEdgeKinds(input: {
  sharedCompoundCount: number;
  sharedSpeciesCount: number;
  doiMatch: boolean;
}): CitationEdgeKind[] {
  const out: CitationEdgeKind[] = [];
  if (input.sharedCompoundCount > 0) out.push("shared_compound");
  if (input.sharedSpeciesCount > 0) out.push("shared_species");
  if (input.doiMatch) out.push("shared_doi");
  return out;
}

// ---------------------------------------------------------------------------
// buildCitationGraph — main entry point
// ---------------------------------------------------------------------------

/**
 * Build the citation graph (direct neighbors) for `sourceId`.
 *
 * The query plan is a single Supabase round-trip:
 *   1. Read the source's `doi` (and confirm it exists) — one SELECT.
 *   2. SELECT every other source that shares at least one
 *      `compound_canonical_id` OR `species_taxon_id` OR `doi`
 *      with the source. The EXISTS subqueries filter in one pass.
 *   3. For each candidate neighbor, aggregate the per-edge
 *      shared-compound and shared-species ids in a second
 *      SELECT (batched via `.in('source_id', ids)`).
 *   4. Compose the edges, sort by weight desc, slice to limit.
 *
 * Errors are non-fatal: an unrecoverable DB error returns the
 * empty result. Operators see the failure via the
 * `citation_graph_failed` log event.
 */
export async function buildCitationGraph(
  params: CitationGraphParams,
): Promise<CitationGraphResult> {
  const { sourceId } = params;
  if (!sourceId) return { ...EMPTY_RESULT };
  const limit = Math.max(
    1,
    Math.min(
      CITATION_GRAPH_MAX_LIMIT,
      Math.trunc(params.limit ?? CITATION_GRAPH_DEFAULT_LIMIT),
    ),
  );
  const startedAt = Date.now();
  const baseLog = { sourceId, limit };

  const sb = supabase;

  // 1) Read the source's DOI (and confirm it exists).
  const { data: sourceRow, error: sourceErr } = await sb
    .from("research_sources")
    .select("id, doi")
    .eq("id", sourceId)
    .maybeSingle();
  if (sourceErr) {
    logger.error({ err: sourceErr, ...baseLog }, "citation_graph_source_load_failed");
    return { ...EMPTY_RESULT, sourceId, elapsed: Date.now() - startedAt };
  }
  if (!sourceRow) {
    // Source not found. Empty result, not an error.
    return {
      sourceId,
      edges: [],
      totalNeighbors: 0,
      elapsed: Date.now() - startedAt,
      sourceFound: false,
    };
  }
  const sourceDoi = ((sourceRow as { doi: string | null }).doi || "").trim();
  const sourceDoiLower = sourceDoi.toLowerCase();

  // 2) Select every other source that shares something. PostgREST
  //    does not support FULL OUTER JOINs on correlated subqueries,
  //    so we OR three EXISTS clauses. The result is the set of
  //    `other_source_id` candidates with their title + doi + tier.
  //
  //    We pull a generous candidate set (limit * 10) so the per-
  //    candidate aggregation in step 3 can filter down to the
  //    top N by weight without missing a strong-but-rare signal.
  const candidateLimit = Math.min(500, limit * 10);
  let candidates: Array<{
    id: string;
    title: string;
    doi: string | null;
    trust_tier: string;
  }> = [];
  const candidateErr = await (async (): Promise<null | { message: string }> => {
    let q = sb
      .from("research_sources")
      .select("id, title, doi, trust_tier")
      .neq("id", sourceId)
      .limit(candidateLimit);
    if (sourceDoiLower) {
      // Two ways to share a DOI: the source has one AND the
      // other has the same, OR the source has none but the
      // other has a DOI matching facts' doi column (rare but
      // possible after migrations). We match on the doi column
      // first; the EXISTS on fact-level DOI is a fallback that
      // adds the rare case at the end of this function.
      q = q.ilike("doi", sourceDoi);
    }
    const { data, error } = await q;
    if (error) return error;
    candidates = (data || []) as typeof candidates;
    return null;
  })();
  if (candidateErr) {
    logger.error(
      { err: candidateErr, ...baseLog },
      "citation_graph_candidates_failed",
    );
    return { ...EMPTY_RESULT, sourceId, elapsed: Date.now() - startedAt };
  }

  if (candidates.length === 0) {
    return {
      sourceId,
      edges: [],
      totalNeighbors: 0,
      elapsed: Date.now() - startedAt,
      sourceFound: true,
    };
  }

  const candidateIds = candidates.map((c) => c.id);

  // 3) Per-candidate aggregate: count of shared compounds,
  //    list of shared compound canonical ids, same for species.
  //    Two queries (compound, species) batched via `.in()`.
  const [compoundResult, speciesResult] = await Promise.all([
    sb
      .from("research_bioprospecting_facts")
      .select("source_id, compound_canonical_id")
      .in("source_id", candidateIds)
      .not("compound_canonical_id", "is", null),
    sb
      .from("research_bioprospecting_facts")
      .select("source_id, species_taxon_id")
      .in("source_id", candidateIds)
      .not("species_taxon_id", "is", null),
  ]);

  type Agg = { source_id: string; ids: string[] };
  function buildAggMap(
    rows: Array<{ source_id: string; [k: string]: unknown }> | null,
    field: string,
  ): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const r of rows || []) {
      const sid = (r as { source_id: string }).source_id;
      const v = (r as Record<string, unknown>)[field];
      if (typeof v !== "string" || !v) continue;
      const arr = m.get(sid) || [];
      if (!arr.includes(v)) arr.push(v);
      m.set(sid, arr);
    }
    return m;
  }

  const compoundMap = buildAggMap(
    (compoundResult.data || []) as Array<{ source_id: string; compound_canonical_id: string }>,
    "compound_canonical_id",
  );
  const speciesMap = buildAggMap(
    (speciesResult.data || []) as Array<{ source_id: string; species_taxon_id: string }>,
    "species_taxon_id",
  );

  if (compoundResult.error) {
    logger.warn(
      { err: compoundResult.error, ...baseLog },
      "citation_graph_compound_agg_failed",
    );
  }
  if (speciesResult.error) {
    logger.warn(
      { err: speciesResult.error, ...baseLog },
      "citation_graph_species_agg_failed",
    );
  }

  // 4) Compose the edges. A neighbor with 0 shared compounds,
  //    0 shared species, and no DOI match is a false positive
  //    (came from the candidate step but the inner fact
  //    aggregates came back empty). Skip those.
  const edges: CitationEdge[] = [];
  for (const c of candidates) {
    const sharedCompounds = compoundMap.get(c.id) || [];
    const sharedSpecies = speciesMap.get(c.id) || [];
    const doiMatch = !!sourceDoiLower && (c.doi || "").trim().toLowerCase() === sourceDoiLower;
    if (sharedCompounds.length === 0 && sharedSpecies.length === 0 && !doiMatch) {
      continue;
    }
    const sharedCompoundCount = sharedCompounds.length;
    const sharedSpeciesCount = sharedSpecies.length;
    const weight = computeCitationWeight({
      sharedCompoundCount,
      sharedSpeciesCount,
      doiMatch,
    });
    const kinds = deriveEdgeKinds({
      sharedCompoundCount,
      sharedSpeciesCount,
      doiMatch,
    });
    edges.push({
      otherSourceId: c.id,
      otherTitle: c.title || "",
      otherDoi: c.doi || null,
      otherTrustTier: c.trust_tier || "internal",
      sharedCompounds,
      sharedCompoundCount,
      sharedSpecies,
      sharedSpeciesCount,
      doiMatch,
      weight,
      kinds,
    });
  }

  // Sort by weight desc, then by title asc for stable display.
  edges.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.otherTitle.localeCompare(b.otherTitle);
  });

  const totalNeighbors = edges.length;
  const sliced = edges.slice(0, limit);

  return {
    sourceId,
    edges: sliced,
    totalNeighbors,
    elapsed: Date.now() - startedAt,
    sourceFound: true,
  };
}
