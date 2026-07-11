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
 * Candidate selection is a UNION (logical OR) of the three
 * signals — NOT an intersection. The DOI is a *bonus signal*, it
 * is never applied as an AND-filter on the candidate query.
 * (It used to be: `.ilike("doi", sourceDoi)` narrowed the
 * candidate set to same-DOI sources whenever the focus had a
 * DOI, silently dropping every shared-compound / shared-species
 * neighbor for every real paper.)
 *
 * v1 scope (LLM-free):
 *   - No pre-computed graph table. Every request issues a bounded
 *     set of Supabase queries (focus row -> focus canonical keys ->
 *     3 parallel OR-branches -> candidate hydration). Cost is
 *     O(neighbors) not O(corpus): each fact scan is capped by
 *     `CITATION_FACT_SCAN_CAP` and the candidate set by
 *     `candidateLimit = min(500, limit * 10)`.
 *   - Auth: any authenticated caller via authResolver at the route layer.
 *   - No mutation. This is a pure read path.
 *   - No LLM. The verdict is a deterministic SQL computation.
 *
 * Canonical-id coverage drives everything here: a fact with a NULL
 * `compound_canonical_id` and a NULL `species_taxon_id` can never
 * produce an edge. Measure it before drawing conclusions from an
 * empty graph:
 *
 *   SELECT count(*)                                                          AS facts,
 *          count(compound_canonical_id)                                      AS with_compound,
 *          round(100.0 * count(compound_canonical_id) / nullif(count(*),0), 1) AS pct_compound,
 *          count(species_taxon_id)                                           AS with_taxon,
 *          round(100.0 * count(species_taxon_id) / nullif(count(*),0), 1)      AS pct_taxon
 *   FROM research_bioprospecting_facts;
 *
 * (Full coverage query, including the per-source rollup, lives in
 * `openspec/changes/graph-neighborhood-edges/design.md` Part 4.)
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

/**
 * Hard cap on the number of fact rows scanned per OR-branch. Keeps
 * the shared-compound / shared-species branches bounded on a large
 * corpus (a hub compound can appear in thousands of facts).
 */
export const CITATION_FACT_SCAN_CAP = 5000;

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

/**
 * Collect the distinct, non-empty string values of `values`,
 * preserving first-seen order. Pure function.
 */
function uniqueStrings(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (typeof v !== "string" || !v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Group overlap rows (`{ source_id, <field> }`) by `source_id`, de-duping
 * the field values and skipping the focus source itself. The rows come
 * from a branch query already filtered by the focus's key set, so every
 * value is by construction an OVERLAP with the focus. Pure function.
 */
function buildOverlapMap(
  rows: Array<Record<string, unknown>>,
  field: string,
  excludeSourceId: string,
): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const r of rows) {
    const sid = r.source_id;
    const value = r[field];
    if (typeof sid !== "string" || !sid || sid === excludeSourceId) continue;
    if (typeof value !== "string" || !value) continue;
    const arr = m.get(sid);
    if (arr) {
      if (!arr.includes(value)) arr.push(value);
    } else {
      m.set(sid, [value]);
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// buildCitationGraph — main entry point
// ---------------------------------------------------------------------------

/**
 * Build the citation graph (direct neighbors) for `sourceId`.
 *
 * The query plan:
 *   1. Read the source's `doi` (and confirm it exists) — one SELECT.
 *   2. Read the source's canonical keys — its distinct
 *      `compound_canonical_id` / `species_taxon_id` set — one SELECT.
 *   3. Candidate UNION: three OR-branches in ONE `Promise.all`
 *        (A) facts sharing a `compound_canonical_id` with the focus,
 *        (B) facts sharing a `species_taxon_id` with the focus,
 *        (C) sources with the same DOI (skipped when the focus has none).
 *      Branches A and B double as the per-edge shared-id aggregate:
 *      because they are filtered by the focus's own key set, every row
 *      they return IS an overlap. `candidateIds = (A ∪ B ∪ C) \ {sourceId}`,
 *      capped at `candidateLimit = min(500, limit * 10)`.
 *   4. Hydrate the candidates (title / doi / trust_tier) — one SELECT.
 *   5. Compose the edges, sort by weight desc, slice to limit.
 *
 * The DOI is a *bonus signal* (`+CITATION_WEIGHT_DOI` in
 * `computeCitationWeight`) and an *entry point* into the candidate set —
 * never a filter that narrows it.
 *
 * Errors are non-fatal: an unrecoverable DB error returns the
 * empty result. Operators see the failure via the
 * `citation_graph_*_failed` log events.
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

  // 2) Read the focus source's own canonical keys. These are what a
  //    neighbor has to overlap with; querying by them (instead of by
  //    candidate id) means every returned row IS an overlap, so the
  //    candidate branch and the per-edge aggregate collapse into the
  //    same query.
  const { data: focusFactRows, error: focusFactErr } = await sb
    .from("research_bioprospecting_facts")
    .select("compound_canonical_id, species_taxon_id")
    .eq("source_id", sourceId)
    .limit(CITATION_FACT_SCAN_CAP);
  if (focusFactErr) {
    // Non-fatal: the DOI branch can still produce edges.
    logger.warn(
      { err: focusFactErr, ...baseLog },
      "citation_graph_focus_keys_failed",
    );
  }

  const focusCompoundIds = uniqueStrings(
    ((focusFactRows || []) as Array<{ compound_canonical_id: unknown }>).map(
      (r) => r.compound_canonical_id,
    ),
  );
  const focusTaxonIds = uniqueStrings(
    ((focusFactRows || []) as Array<{ species_taxon_id: unknown }>).map(
      (r) => r.species_taxon_id,
    ),
  );

  // 3) Candidate UNION — three OR-branches, in parallel.
  //
  //    The candidate set is (A ∪ B ∪ C), NOT (A ∩ C). The DOI is one of
  //    three ways to ENTER the set; it never removes a shared-compound
  //    or shared-species neighbor. A branch with no focus key to match
  //    on is skipped (no query issued) rather than degenerating into an
  //    unfiltered scan of `research_sources`.
  //
  //    We pull a generous candidate set (limit * 10, capped at 500) so
  //    step 5's top-N-by-weight can pick the strongest edges without
  //    missing a strong-but-rare signal.
  const candidateLimit = Math.min(500, limit * 10);
  type BranchResult = { data: unknown[] | null; error: unknown };
  const emptyBranch = (): Promise<BranchResult> =>
    Promise.resolve({ data: [], error: null });

  const [compoundBranch, speciesBranch, doiBranch] = (await Promise.all([
    focusCompoundIds.length > 0
      ? sb
          .from("research_bioprospecting_facts")
          .select("source_id, compound_canonical_id")
          .in("compound_canonical_id", focusCompoundIds)
          .neq("source_id", sourceId)
          .limit(CITATION_FACT_SCAN_CAP)
      : emptyBranch(),
    focusTaxonIds.length > 0
      ? sb
          .from("research_bioprospecting_facts")
          .select("source_id, species_taxon_id")
          .in("species_taxon_id", focusTaxonIds)
          .neq("source_id", sourceId)
          .limit(CITATION_FACT_SCAN_CAP)
      : emptyBranch(),
    sourceDoiLower
      ? sb
          .from("research_sources")
          .select("id")
          .ilike("doi", sourceDoi)
          .neq("id", sourceId)
          .limit(candidateLimit)
      : emptyBranch(),
  ])) as unknown as [BranchResult, BranchResult, BranchResult];

  if (compoundBranch.error) {
    logger.warn(
      { err: compoundBranch.error, ...baseLog },
      "citation_graph_compound_branch_failed",
    );
  }
  if (speciesBranch.error) {
    logger.warn(
      { err: speciesBranch.error, ...baseLog },
      "citation_graph_species_branch_failed",
    );
  }
  if (doiBranch.error) {
    logger.warn(
      { err: doiBranch.error, ...baseLog },
      "citation_graph_doi_branch_failed",
    );
  }
  if (compoundBranch.error && speciesBranch.error && doiBranch.error) {
    logger.error({ ...baseLog }, "citation_graph_candidates_failed");
    return { ...EMPTY_RESULT, sourceId, elapsed: Date.now() - startedAt };
  }

  // Branch rows double as the per-edge shared-id aggregate: they are
  // already filtered by the focus's key set, so `compoundMap.get(x)`
  // holds exactly the compounds `x` SHARES with the focus.
  const compoundMap = buildOverlapMap(
    (compoundBranch.data || []) as Array<Record<string, unknown>>,
    "compound_canonical_id",
    sourceId,
  );
  const speciesMap = buildOverlapMap(
    (speciesBranch.data || []) as Array<Record<string, unknown>>,
    "species_taxon_id",
    sourceId,
  );
  const doiSourceIds = uniqueStrings(
    ((doiBranch.data || []) as Array<{ id: unknown }>).map((r) => r.id),
  ).filter((id) => id !== sourceId);

  // Union, ordered compound -> species -> DOI (matching the weight
  // coefficients 3 > 2; DOI hits are rare), then capped.
  const candidateIds: string[] = [];
  const seen = new Set<string>([sourceId]);
  for (const id of [
    ...compoundMap.keys(),
    ...speciesMap.keys(),
    ...doiSourceIds,
  ]) {
    if (seen.has(id)) continue;
    seen.add(id);
    candidateIds.push(id);
    if (candidateIds.length >= candidateLimit) break;
  }

  if (candidateIds.length === 0) {
    return {
      sourceId,
      edges: [],
      totalNeighbors: 0,
      elapsed: Date.now() - startedAt,
      sourceFound: true,
    };
  }

  // 4) Hydrate the candidates (title / doi / trust_tier).
  const { data: candidateRows, error: candidateErr } = await sb
    .from("research_sources")
    .select("id, title, doi, trust_tier")
    .in("id", candidateIds)
    .limit(candidateLimit);
  if (candidateErr) {
    logger.error(
      { err: candidateErr, ...baseLog },
      "citation_graph_candidates_failed",
    );
    return { ...EMPTY_RESULT, sourceId, elapsed: Date.now() - startedAt };
  }
  const candidates = (candidateRows || []) as Array<{
    id: string;
    title: string;
    doi: string | null;
    trust_tier: string;
  }>;

  if (candidates.length === 0) {
    return {
      sourceId,
      edges: [],
      totalNeighbors: 0,
      elapsed: Date.now() - startedAt,
      sourceFound: true,
    };
  }

  // 5) Compose the edges. A candidate with 0 shared compounds,
  //    0 shared species, and no DOI match is a false positive
  //    (e.g. it entered via the DOI branch but the hydrated `doi`
  //    no longer matches). Skip those — the OR-union widens the
  //    candidate set, it does not weaken the edge predicate.
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
