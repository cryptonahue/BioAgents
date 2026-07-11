/**
 * Read-side service module for the v1 knowledge graph.
 *
 * The module is a pure read-side helper: it does not insert, update,
 * or delete any row in `research_bioprospecting_facts`,
 * `research_compounds`, or the materialized view. The only mutation
 * surface is `refreshAggregates()`, which calls a soft-fail SQL
 * function and never throws.
 *
 * The read path is composed of:
 *   - `searchCompounds`     — alias-aware compound search over the
 *                             `research_graph_compound_aggregates`
 *                             matview + `research_compound_aliases`.
 *                             4-tier in-process ranking
 *                             (exact canonical > exact alias > prefix
 *                             canonical > substring). Optional
 *                             `expand: true` attaches the top-N
 *                             co-occurring compounds, geographies, and
 *                             bioactivities per hit (parallel RPCs).
 *   - `refreshAggregates`   — soft-fail wrapper around the
 *                             `public.refresh_compound_aggregates()`
 *                             SQL function. NEVER throws.
 *   - `getTopCoOccurring`   — top co-occurring compounds by shared
 *                             source count, via the
 *                             `public.graph_top_co_occurring` RPC.
 *   - `getTopGeographies`   — top geography strings by fact count, via
 *                             the `public.graph_top_string_field`
 *                             RPC.
 *   - `getTopBioactivities` — top bioactivity strings by fact count,
 *                             via the same RPC.
 *
 * Module-level TDZ guard: the Supabase client is wrapped in a Proxy
 * that defers the actual `getServiceClient()` call to first access
 * (mirrors `compoundAuthority.ts:44-53`). This avoids the Temporal
 * Dead Zone that module-level `getServiceClient()` would create in
 * worker processes (see project README "TDZ in Worker Processes").
 */

import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";
import { buildCitationGraph } from "./citationGraph";

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
// Exported types
// ---------------------------------------------------------------------------

/** Per-compound stat block, exposed in the matview rows. */
export type CompoundAggregateStats = {
  fact_count: number;
  source_count: number;
  claim_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

/** A single canonical compound row from the matview. */
export type CompoundAggregate = {
  compound_id: string;
  canonical_name: string;
  normalized_name: string;
  pubchem_cid: number | null;
  chebi_id: number | null;
  molecular_formula: string | null;
  stats: CompoundAggregateStats;
};

/** Top-N co-occurring compound hit. */
export type TopCompound = {
  compound_id: string;
  canonical_name: string;
  fact_count: number;
};

/** Top-N free-text bucket (geography / bioactivity). */
export type TopStringBucket = {
  value: string;
  fact_count: number;
};

export type SearchCompoundsParams = {
  query: string;
  /** Default 20, max 100. Larger values are silently clamped. */
  limit?: number;
  /** Default false. When true, attach the top-N co-occurring
   *  compounds, geographies, and bioactivities per hit. */
  expand?: boolean;
};

export type SearchCompoundsResult = {
  compound: CompoundAggregate;
  stats: CompoundAggregateStats;
  /** Present iff params.expand === true. */
  topCoOccurring?: TopCompound[];
  /** Present iff params.expand === true. */
  topGeographies?: TopStringBucket[];
  /** Present iff params.expand === true. */
  topBioactivities?: TopStringBucket[];
};

// ---------------------------------------------------------------------------
// KG v2 — entity mention graph types (LLM-free, read-only)
// ---------------------------------------------------------------------------

/** The three consultable entity kinds. Allowlist source of truth in TS. */
export type EntityKind = "bioactivity" | "application_area" | "assay_model";

/** Fixed allowlist mirroring the SQL RPCs' `p_kind IN (...)` guard. */
export const ENTITY_KINDS: readonly EntityKind[] = [
  "bioactivity",
  "application_area",
  "assay_model",
] as const;

/**
 * Thrown when a caller passes a `kind` outside {@link ENTITY_KINDS}.
 * The route layer maps this to HTTP 400 before any DB access, keeping a
 * clean 400-vs-500 boundary (a raw SQL `RAISE` would otherwise surface
 * as a generic RPC error -> 500).
 */
export class UnknownEntityKindError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(`unknown entity kind: ${kind}`);
    this.name = "UnknownEntityKindError";
    this.kind = kind;
  }
}

/** Narrowing guard for the entity-kind allowlist. */
export function isEntityKind(value: unknown): value is EntityKind {
  return (
    typeof value === "string" &&
    (ENTITY_KINDS as readonly string[]).includes(value)
  );
}

/** One entity node as returned by search.
 *  `{ kind, value, display }` is the stable identity triple; a future
 *  Approach-B canonical `entity_id?: string` is purely additive here. */
export type EntityNode = {
  kind: EntityKind;
  value: string; // normalized key (graph_normalize_entity output)
  display: string; // most frequent raw form, for UI
  compound_count: number;
  fact_count: number;
  source_count: number;
};

/** A compound linked to an expanded entity value. */
export type EntityExpandCompound = {
  id: string;
  canonical_name: string;
  fact_count: number;
};

/** A single fact linked to an expanded entity value (1-hop). */
export type EntityExpandFact = {
  id: string;
  source_id: string | null;
  compound_canonical_id: string | null;
  result_summary: string | null;
  quote: string | null;
  page: number | null;
  doi: string | null;
};

/** A source doc linked to an expanded entity value. */
export type EntityExpandSource = {
  id: string;
  title: string;
  doi: string | null;
  url: string | null;
  fact_count: number;
};

/** The 1-hop neighborhood of one normalized entity value. */
export type EntityExpansion = {
  compounds: EntityExpandCompound[];
  facts: EntityExpandFact[];
  sources: EntityExpandSource[];
};

// ---------------------------------------------------------------------------
// clampLimit — defensive numeric guard shared across all read paths
// ---------------------------------------------------------------------------

/**
 * Clamp a `limit` parameter to `[1, max]`, applying `def` when the
 * input is `undefined`/`null`/non-finite. Truncates floats. Used by
 * every public read function to enforce the spec's bounds.
 */
function clampLimit(
  limit: number | undefined,
  def: number,
  max: number,
): number {
  if (limit == null) return def;
  if (!Number.isFinite(limit)) return def;
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}

// ---------------------------------------------------------------------------
// searchCompounds — alias-aware compound search
// ---------------------------------------------------------------------------

/**
 * Alias-aware compound search. Returns matches ordered by match
 * quality (exact canonical > exact alias > prefix > substring) with
 * ties broken by `fact_count DESC` then `canonical_name ASC`.
 *
 * Read-only. Default `limit` is 20, max 100 (larger values are
 * silently clamped; the route layer surfaces the applied limit).
 *
 * The query is implemented as a wide `ILIKE` candidate fetch (4x the
 * requested limit, mirroring `searchCompoundsByName` in
 * `compoundAuthority.ts:538`) plus a follow-up alias pass for tier-2
 * exact-alias detection. The match-quality ranking is computed
 * in-process so a substring hit can never steal a slot from a
 * higher-tier hit.
 *
 * When `params.expand === true`, the function additionally issues
 * three parallel RPCs per hit (`Promise.all`) and attaches the
 * results. The three expand fields are OMITTED (not present as empty
 * arrays) when `expand === false` so the default response stays
 * lightweight.
 */
export async function searchCompounds(
  params: SearchCompoundsParams,
): Promise<SearchCompoundsResult[]> {
  const safeLimit = clampLimit(params.limit, 20, 100);
  const trimmed = (params.query ?? "").trim();
  if (!trimmed) return [];

  // Fetch a wide candidate set; the in-process tier sort will narrow.
  const FETCH_WINDOW = safeLimit * 4;
  const escaped = trimmed.replace(/[%_]/g, (m) => `\\${m}`);
  const wildcard = `%${escaped}%`;

  // ---- 1) Candidate set from the matview (canonical + normalized) ----
  const { data, error } = await supabase
    .from("research_graph_compound_aggregates")
    .select(
      `
      compound_id,
      canonical_name,
      normalized_name,
      pubchem_cid,
      chebi_id,
      molecular_formula,
      fact_count,
      source_count,
      claim_count,
      first_seen_at,
      last_seen_at
    `,
    )
    .or(`canonical_name.ilike.${wildcard},normalized_name.ilike.${wildcard}`)
    .limit(FETCH_WINDOW);
  if (error) throw error;

  // ---- 2) Alias pass for tier-2 (exact alias) detection ----
  const ids = ((data ?? []) as Array<{ compound_id: string }>).map(
    (r) => r.compound_id,
  );
  let aliasRows: Array<{ compound_id: string; alias: string }> = [];
  if (ids.length > 0) {
    const { data: aData, error: aError } = await supabase
      .from("research_compound_aliases")
      .select("compound_id, alias")
      .in("compound_id", ids)
      .ilike("alias", wildcard)
      .limit(FETCH_WINDOW);
    if (aError) {
      logger.warn(
        { err: aError },
        "graph_service_alias_pass_failed",
      );
    } else {
      aliasRows = (aData ?? []) as Array<{
        compound_id: string;
        alias: string;
      }>;
    }
  }

  // ---- 3) Compute match tier per compound ----
  const queryLower = trimmed.toLowerCase();
  const aliasesByCompound = new Map<string, string[]>();
  for (const r of aliasRows) {
    const arr = aliasesByCompound.get(r.compound_id);
    if (arr) {
      arr.push(r.alias);
    } else {
      aliasesByCompound.set(r.compound_id, [r.alias]);
    }
  }

  type Row = {
    compound_id: string;
    canonical_name: string;
    normalized_name: string;
    pubchem_cid: number | null;
    chebi_id: number | null;
    molecular_formula: string | null;
    fact_count: number;
    source_count: number;
    claim_count: number;
    first_seen_at: string | null;
    last_seen_at: string | null;
  };

  type Ranked = {
    compound: CompoundAggregate;
    tier: 0 | 1 | 2 | 3;
  };

  const ranked: Ranked[] = [];
  for (const row of (data ?? []) as Row[]) {
    const canLower = row.canonical_name.toLowerCase();
    const aliases = aliasesByCompound.get(row.compound_id) ?? [];
    let tier: 0 | 1 | 2 | 3 = 3;
    if (canLower === queryLower) {
      tier = 0;
    } else if (aliases.some((a) => a.toLowerCase() === queryLower)) {
      tier = 1;
    } else if (canLower.startsWith(queryLower)) {
      tier = 2;
    } else if (
      canLower.includes(queryLower) ||
      aliases.some((a) => a.toLowerCase().includes(queryLower))
    ) {
      tier = 3;
    } else {
      // ILIKE matched a normalized form but not the canonical or any
      // alias in the candidate window — skip (defensive).
      continue;
    }
    ranked.push({
      compound: {
        compound_id: row.compound_id,
        canonical_name: row.canonical_name,
        normalized_name: row.normalized_name,
        pubchem_cid: row.pubchem_cid,
        chebi_id: row.chebi_id,
        molecular_formula: row.molecular_formula,
        stats: {
          fact_count: row.fact_count,
          source_count: row.source_count,
          claim_count: row.claim_count,
          first_seen_at: row.first_seen_at,
          last_seen_at: row.last_seen_at,
        },
      },
      tier,
    });
  }

  // ---- 4) Sort: tier ASC, fact_count DESC, canonical_name ASC ----
  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.compound.stats.fact_count !== b.compound.stats.fact_count) {
      return b.compound.stats.fact_count - a.compound.stats.fact_count;
    }
    return a.compound.canonical_name.localeCompare(b.compound.canonical_name);
  });
  const top = ranked.slice(0, safeLimit);

  // ---- 5) Optional expand: 3 parallel RPCs per hit ----
  if (params.expand === true) {
    return await Promise.all(
      top.map(async (hit) => {
        const [topCoOccurring, topGeographies, topBioactivities] =
          await Promise.all([
            getTopCoOccurring(hit.compound.compound_id, 5),
            getTopGeographies(hit.compound.compound_id, 5),
            getTopBioactivities(hit.compound.compound_id, 5),
          ]);
        return {
          compound: hit.compound,
          stats: hit.compound.stats,
          topCoOccurring,
          topGeographies,
          topBioactivities,
        };
      }),
    );
  }

  return top.map((hit) => ({
    compound: hit.compound,
    stats: hit.compound.stats,
  }));
}

// ---------------------------------------------------------------------------
// refreshAggregates — soft-fail RPC
// ---------------------------------------------------------------------------

/**
 * Refresh the `research_graph_compound_aggregates` matview. The
 * underlying SQL function `public.refresh_compound_aggregates()` is
 * itself a soft-fail wrapper (it absorbs errors with
 * `EXCEPTION WHEN OTHERS` and `RAISE WARNING`). This function adds
 * a second safety net: if the RPC errors at the transport level
 * (e.g. network failure, malformed response), we catch + log and
 * resolve successfully so callers can `await` it without their own
 * try/catch.
 *
 * MUST NOT throw.
 */
export async function refreshAggregates(): Promise<void> {
  try {
    const { error } = await supabase.rpc("refresh_compound_aggregates");
    if (error) {
      logger.warn(
        { err: error },
        "graph_refresh_compound_aggregates_failed_soft_fail",
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      "graph_refresh_compound_aggregates_failed_soft_fail",
    );
  }
}

// ---------------------------------------------------------------------------
// getTopCoOccurring — query-time CTE via RPC
// ---------------------------------------------------------------------------

/**
 * Top co-occurring compounds for the input `compoundId`, ranked by
 * the number of distinct shared source documents. Excludes the
 * input compound from the result set. Default limit is 5; larger
 * values are silently clamped to 100.
 */
export async function getTopCoOccurring(
  compoundId: string,
  limit: number = 5,
): Promise<TopCompound[]> {
  if (!compoundId) return [];
  const safeLimit = clampLimit(limit, 5, 100);
  const { data, error } = await supabase.rpc("graph_top_co_occurring", {
    p_compound_id: compoundId,
    p_limit: safeLimit,
  });
  if (error) throw error;
  return ((data ?? []) as Array<{
    compound_id: string;
    canonical_name: string;
    fact_count: number | string;
  }>).map((row) => ({
    compound_id: row.compound_id,
    canonical_name: row.canonical_name,
    fact_count: Number(row.fact_count),
  }));
}

// ---------------------------------------------------------------------------
// getTopGeographies / getTopBioactivities — shared RPC via topByStringField
// ---------------------------------------------------------------------------

/**
 * Top `geography` strings for a given compound, ranked by fact
 * count. NULL and empty-string values are excluded. Default limit
 * is 5; larger values are silently clamped to 100.
 */
export async function getTopGeographies(
  compoundId: string,
  limit: number = 5,
): Promise<TopStringBucket[]> {
  return topByStringField("geography", compoundId, limit);
}

/**
 * Top `bioactivity` strings for a given compound, ranked by fact
 * count. NULL and empty-string values are excluded. Default limit
 * is 5; larger values are silently clamped to 100.
 */
export async function getTopBioactivities(
  compoundId: string,
  limit: number = 5,
): Promise<TopStringBucket[]> {
  return topByStringField("bioactivity", compoundId, limit);
}

/**
 * Internal helper that issues the `graph_top_string_field` RPC. The
 * RPC uses dynamic SQL with an allowlist + `format('%I', ...)` for
 * safe identifier injection.
 */
async function topByStringField(
  field: "geography" | "bioactivity",
  compoundId: string,
  limit: number,
): Promise<TopStringBucket[]> {
  if (!compoundId) return [];
  const safeLimit = clampLimit(limit, 5, 100);
  const { data, error } = await supabase.rpc("graph_top_string_field", {
    p_field: field,
    p_compound_id: compoundId,
    p_limit: safeLimit,
  });
  if (error) throw error;
  return ((data ?? []) as Array<{
    value: string;
    fact_count: number | string;
  }>).map((row) => ({
    value: row.value,
    fact_count: Number(row.fact_count),
  }));
}

// ---------------------------------------------------------------------------
// KG v2 — searchEntities / expandEntity (entity mention graph)
// ---------------------------------------------------------------------------

/**
 * Search distinct normalized entity nodes within a kind, via the
 * `public.graph_entity_search` RPC (which reads the live
 * `research_graph_entities` UNION view). The optional `query` is
 * substring-filtered over the normalized value; passing an empty query
 * lists the top nodes by `fact_count`.
 *
 * `kind` is validated against {@link ENTITY_KINDS} up-front and throws a
 * typed {@link UnknownEntityKindError} (route -> 400) rather than relying
 * only on the SQL `RAISE`. Read-only. Default `limit` 20, max 100
 * (silently clamped; never throws for out-of-range). `BIGINT` counts
 * arrive as strings and are coerced via `Number(...)`, same as
 * {@link getTopCoOccurring}.
 */
export async function searchEntities(params: {
  kind: EntityKind;
  query?: string;
  limit?: number;
}): Promise<EntityNode[]> {
  if (!isEntityKind(params.kind)) {
    throw new UnknownEntityKindError(String(params.kind));
  }
  const safeLimit = clampLimit(params.limit, 20, 100);
  const query = (params.query ?? "").trim();

  const { data, error } = await supabase.rpc("graph_entity_search", {
    p_kind: params.kind,
    p_query: query,
    p_limit: safeLimit,
  });
  if (error) throw error;

  return ((data ?? []) as Array<{
    kind: EntityKind;
    value: string;
    display: string;
    compound_count: number | string;
    fact_count: number | string;
    source_count: number | string;
  }>).map((row) => ({
    kind: row.kind,
    value: row.value,
    display: row.display,
    compound_count: Number(row.compound_count),
    fact_count: Number(row.fact_count),
    source_count: Number(row.source_count),
  }));
}

/**
 * Expand one normalized entity `value` to its 1-hop neighborhood
 * (compounds / facts / sources) via the `public.graph_entity_expand`
 * RPC. The RPC returns a single `jsonb` `{ compounds, facts, sources }`.
 *
 * `value` is passed to the RPC VERBATIM — the service does NOT
 * re-normalize it. Normalization lives only in SQL
 * (`graph_normalize_entity`); re-normalizing here would risk
 * double-normalization drift and violate the single-source invariant.
 *
 * `kind` is validated against {@link ENTITY_KINDS} up-front and throws a
 * typed {@link UnknownEntityKindError} (route -> 400). A value that
 * matches nothing resolves to `{ compounds: [], facts: [], sources: [] }`
 * — it MUST NOT reject. Default `limit` 20, max 100 (silently clamped).
 */
export async function expandEntity(params: {
  kind: EntityKind;
  value: string;
  limit?: number;
}): Promise<EntityExpansion> {
  if (!isEntityKind(params.kind)) {
    throw new UnknownEntityKindError(String(params.kind));
  }
  const safeLimit = clampLimit(params.limit, 20, 100);

  const { data, error } = await supabase.rpc("graph_entity_expand", {
    p_kind: params.kind,
    p_value: params.value,
    p_limit: safeLimit,
  });
  if (error) throw error;

  const payload = (data ?? {}) as {
    compounds?: Array<{
      id: string;
      canonical_name: string;
      fact_count: number | string;
    }>;
    facts?: EntityExpandFact[];
    sources?: Array<{
      id: string;
      title: string;
      doi: string | null;
      url: string | null;
      fact_count: number | string;
    }>;
  };

  return {
    compounds: (payload.compounds ?? []).map((c) => ({
      id: c.id,
      canonical_name: c.canonical_name,
      fact_count: Number(c.fact_count),
    })),
    facts: (payload.facts ?? []).map((f) => ({
      id: f.id,
      source_id: f.source_id,
      compound_canonical_id: f.compound_canonical_id,
      result_summary: f.result_summary,
      quote: f.quote,
      page: f.page,
      doi: f.doi,
    })),
    sources: (payload.sources ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      doi: s.doi,
      url: s.url,
      fact_count: Number(s.fact_count),
    })),
  };
}

// ---------------------------------------------------------------------------
// KG v3 — neighborhood composition (de-star the graph)
// ---------------------------------------------------------------------------
//
// `composeNeighborhood` returns, for one focus node, its 1-hop neighborhood
// PLUS the induced subgraph among those neighbors — the edges that make the
// ego graph a graph instead of a star.
//
// Composed ON THE FLY from three existing read helpers:
//   `expandEntity` (entity -> compounds/sources), `getTopCoOccurring`
//   (compound <-> compound) and `buildCitationGraph` (source <-> source),
// plus three batched hydration helpers below. No new table, no stored edge,
// no refresh hook, no LLM, no write.
//
// Edge yield is bounded by canonical-id coverage: `co_occurs_with` and
// `related_source` are derived from `compound_canonical_id` /
// `species_taxon_id`, so a corpus where those are mostly NULL yields a star
// no matter what this code does. Measure before concluding (see the coverage
// SQL in `citationGraph.ts`'s header and design.md Part 4).

/** Node kinds in a neighborhood payload. Facts stay EDGES, never nodes. */
export type GraphNodeType = "entity" | "compound" | "source";

/** Closed set of neighborhood edge types. */
export type GraphEdgeType =
  | "has_compound" // focus entity  -> compound        (spoke)
  | "has_source" // focus entity  -> source          (spoke)
  | "reports" // compound     <-> source          (fact-backed)
  | "co_occurs_with" // compound     <-> compound        (shared sources)
  | "related_source"; // source       <-> source          (citation graph)

export type NeighborhoodNode = {
  /** `entity:{kind}:{value}` | `compound:{uuid}` | `source:{uuid}` */
  id: string;
  type: GraphNodeType;
  label: string;
  meta?: {
    kind?: string;
    value?: string;
    factCount?: number;
    doi?: string | null;
    url?: string | null;
  };
};

export type NeighborhoodEdge = {
  /** Node id. */
  source: string;
  /** Node id. */
  target: string;
  type: GraphEdgeType;
  /**
   * Higher = stronger. Comparable WITHIN a type only: a `related_source`
   * 11 (`3*compounds + 2*species + 5*doi`) and a `co_occurs_with` 11
   * (shared-source count) are different units. The client normalizes per
   * type; faking a global scale here would be a lie.
   */
  weight: number;
  label?: string;
};

export type NeighborhoodResult = {
  focus: NeighborhoodNode;
  nodes: NeighborhoodNode[];
  edges: NeighborhoodEdge[];
  meta: {
    limit: number;
    fanout: number;
    elapsed: number;
    counts: { nodes: number; edges: number };
  };
};

export type NeighborhoodFocusParams =
  | { type: "entity"; kind: EntityKind; value: string }
  | { type: "compound"; id: string }
  | { type: "source"; id: string };

export type ComposeNeighborhoodParams = NeighborhoodFocusParams & {
  /** Neighbors per class. Default 20, max 100 (silently clamped). */
  limit?: number;
  /** Neighbor expansions used for induced edges. Default 3, max 5. */
  fanout?: number;
};

/** Default / max neighbors per class. */
export const NEIGHBORHOOD_DEFAULT_LIMIT = 20;
export const NEIGHBORHOOD_MAX_LIMIT = 100;
/**
 * Default / max fan-out: how many neighbors get expanded to find induced
 * edges. This is the N+1 guard — `buildCitationGraph` is ~4 round trips
 * each, so the cap keeps the worst case bounded (see design.md Part 2).
 */
export const NEIGHBORHOOD_DEFAULT_FANOUT = 3;
export const NEIGHBORHOOD_MAX_FANOUT = 5;

/** Hard cap on fact rows scanned by {@link getFactLinks}. */
export const FACT_LINK_SCAN_CAP = 5000;

/**
 * Thrown when a `compound` / `source` focus id does not resolve to a row.
 * The route layer maps this to HTTP 404 (an unmatched *entity* value is
 * NOT an error — it resolves to an empty neighborhood, per `expandEntity`).
 */
export class FocusNotFoundError extends Error {
  readonly focusType: "compound" | "source";
  readonly id: string;
  constructor(focusType: "compound" | "source", id: string) {
    super(`${focusType} not found: ${id}`);
    this.name = "FocusNotFoundError";
    this.focusType = focusType;
    this.id = id;
  }
}

/** One compound<->source fact link. Both endpoints are always non-null. */
export type FactLink = {
  fact_id: string;
  source_id: string;
  compound_canonical_id: string;
};

/** Minimal source row for graph hydration. */
export type GraphSourceRow = {
  id: string;
  title: string;
  doi: string | null;
  url: string | null;
};

/** Minimal canonical-compound row for graph hydration. */
export type GraphCompoundRow = {
  id: string;
  canonical_name: string;
  fact_count: number;
};

// --- Batched hydration helpers ---------------------------------------------

/**
 * Batched fact-link read: every `(source_id, compound_canonical_id)` pair
 * matching the given id sets, in ONE query. Passing both sets ANDs them —
 * that is exactly the `reports` induced-edge query (links whose BOTH
 * endpoints are in the neighbor set). Facts with a NULL compound or source
 * are skipped: they cannot be an edge.
 *
 * Read-only. Returns `[]` when both id sets are empty (no query issued).
 */
export async function getFactLinks(params: {
  compoundIds?: string[];
  sourceIds?: string[];
  limit?: number;
}): Promise<FactLink[]> {
  const compoundIds = distinct(params.compoundIds ?? []);
  const sourceIds = distinct(params.sourceIds ?? []);
  if (compoundIds.length === 0 && sourceIds.length === 0) return [];

  let q = supabase
    .from("research_bioprospecting_facts")
    .select("id, source_id, compound_canonical_id")
    .not("compound_canonical_id", "is", null)
    .not("source_id", "is", null);
  if (compoundIds.length > 0) q = q.in("compound_canonical_id", compoundIds);
  if (sourceIds.length > 0) q = q.in("source_id", sourceIds);

  const { data, error } = await q.limit(
    clampLimit(params.limit, FACT_LINK_SCAN_CAP, FACT_LINK_SCAN_CAP),
  );
  if (error) throw error;

  const out: FactLink[] = [];
  for (const row of (data ?? []) as Array<{
    id: string;
    source_id: string | null;
    compound_canonical_id: string | null;
  }>) {
    if (!row.source_id || !row.compound_canonical_id) continue;
    out.push({
      fact_id: row.id,
      source_id: row.source_id,
      compound_canonical_id: row.compound_canonical_id,
    });
  }
  return out;
}

/** Batched `research_sources` hydration. Read-only; `[]` for an empty input. */
export async function getSourcesByIds(
  ids: string[],
): Promise<GraphSourceRow[]> {
  const unique = distinct(ids);
  if (unique.length === 0) return [];
  const { data, error } = await supabase
    .from("research_sources")
    .select("id, title, doi, url")
    .in("id", unique);
  if (error) throw error;
  return ((data ?? []) as Array<{
    id: string;
    title: string | null;
    doi: string | null;
    url: string | null;
  }>).map((row) => ({
    id: row.id,
    title: row.title ?? "",
    doi: row.doi ?? null,
    url: row.url ?? null,
  }));
}

/**
 * Batched canonical-compound hydration off the aggregates matview (it
 * carries `fact_count`, which doubles as the node weight). A compound with
 * zero facts is absent from the matview — and absent from a fact-derived
 * graph by definition.
 *
 * Read-only; `[]` for an empty input.
 */
export async function getCompoundsByIds(
  ids: string[],
): Promise<GraphCompoundRow[]> {
  const unique = distinct(ids);
  if (unique.length === 0) return [];
  const { data, error } = await supabase
    .from("research_graph_compound_aggregates")
    .select("compound_id, canonical_name, fact_count")
    .in("compound_id", unique);
  if (error) throw error;
  return ((data ?? []) as Array<{
    compound_id: string;
    canonical_name: string | null;
    fact_count: number | string | null;
  }>).map((row) => ({
    id: row.compound_id,
    canonical_name: row.canonical_name ?? "",
    fact_count: Number(row.fact_count ?? 0),
  }));
}

// --- Pure id/format helpers -------------------------------------------------

/** Distinct, non-empty strings, first-seen order. */
function distinct(values: Array<string | null | undefined>): string[] {
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

/** `entity:{kind}:{value}` — matches the client's existing id convention. */
export function entityNodeId(kind: string, value: string): string {
  return `entity:${kind}:${value}`;
}
/** `compound:{uuid}` */
export function compoundNodeId(id: string): string {
  return `compound:${id}`;
}
/** `source:{uuid}` */
export function sourceNodeId(id: string): string {
  return `source:${id}`;
}

/** Undirected, per-type edge key. `a-b` and `b-a` collapse to one edge. */
function edgeKey(edge: {
  source: string;
  target: string;
  type: GraphEdgeType;
}): string {
  return `${edge.type}|${[edge.source, edge.target].sort().join("|")}`;
}

// --- composeNeighborhood ----------------------------------------------------

type NeighborCompound = { id: string; label: string; factCount: number };
type NeighborSource = {
  id: string;
  label: string;
  doi: string | null;
  url: string | null;
  factCount: number;
};

/**
 * Compose the 1-hop neighborhood of a focus node PLUS the induced subgraph
 * among its neighbors.
 *
 * Steps (see design.md Part 2):
 *   1. Resolve the focus and its neighbor sets (`N_c` compounds, `N_s` sources).
 *   2. Emit the focus->neighbor spokes.
 *   3. Induced edges, each pruned to endpoints that are BOTH in the neighbor
 *      set — that pruning is what makes the subgraph *induced*:
 *        a. `reports`        — one batched `getFactLinks({N_c, N_s})`
 *        b. `co_occurs_with` — `getTopCoOccurring` on the top-`fanout` of N_c
 *        c. `related_source` — `buildCitationGraph` on the top-`fanout` of N_s
 *      Each class short-circuits when it has < 2 neighbors (nothing can be
 *      induced between fewer than two nodes).
 *   4. Dedupe (nodes by id, edges by type + unordered pair, max weight wins),
 *      sort by weight desc.
 *
 * Read-only. No LLM. Throws {@link UnknownEntityKindError} (-> 400) and
 * {@link FocusNotFoundError} (-> 404); an entity value that matches nothing
 * resolves to a focus-only neighborhood (200, empty-not-error).
 */
export async function composeNeighborhood(
  params: ComposeNeighborhoodParams,
): Promise<NeighborhoodResult> {
  const startedAt = Date.now();
  const limit = clampLimit(
    params.limit,
    NEIGHBORHOOD_DEFAULT_LIMIT,
    NEIGHBORHOOD_MAX_LIMIT,
  );
  const fanout = clampLimit(
    params.fanout,
    NEIGHBORHOOD_DEFAULT_FANOUT,
    NEIGHBORHOOD_MAX_FANOUT,
  );

  const nodes = new Map<string, NeighborhoodNode>();
  const edges = new Map<string, NeighborhoodEdge>();

  /** First write wins (the focus is written first). */
  const addNode = (node: NeighborhoodNode): void => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };
  /** Undirected dedupe per type; on collision the max weight wins. */
  const addEdge = (edge: NeighborhoodEdge): void => {
    if (edge.source === edge.target) return;
    const key = edgeKey(edge);
    const prev = edges.get(key);
    if (!prev) {
      edges.set(key, edge);
      return;
    }
    if (edge.weight > prev.weight) {
      edges.set(key, { ...prev, weight: edge.weight, label: edge.label ?? prev.label });
    }
  };

  const compoundNeighbors = new Map<string, NeighborCompound>();
  const sourceNeighbors = new Map<string, NeighborSource>();
  /**
   * Source focus only: facts joining the focus source to each neighbor
   * compound. That count — not the compound's global `fact_count` — is the
   * weight of the `reports` spoke.
   */
  let focusLinkCount = new Map<string, number>();

  // --- 1) Resolve the focus + its neighbor sets ------------------------------
  let focus: NeighborhoodNode;

  if (params.type === "entity") {
    // `value` is passed to expandEntity VERBATIM — normalization lives in SQL.
    const expansion = await expandEntity({
      kind: params.kind,
      value: params.value,
      limit,
    });
    focus = {
      id: entityNodeId(params.kind, params.value),
      type: "entity",
      label: params.value,
      meta: { kind: params.kind, value: params.value },
    };
    for (const c of expansion.compounds) {
      compoundNeighbors.set(c.id, {
        id: c.id,
        label: c.canonical_name,
        factCount: c.fact_count,
      });
    }
    for (const s of expansion.sources) {
      sourceNeighbors.set(s.id, {
        id: s.id,
        label: s.title,
        doi: s.doi,
        url: s.url,
        factCount: s.fact_count,
      });
    }
  } else if (params.type === "compound") {
    const [row] = await getCompoundsByIds([params.id]);
    if (!row) throw new FocusNotFoundError("compound", params.id);
    focus = {
      id: compoundNodeId(row.id),
      type: "compound",
      label: row.canonical_name,
      meta: { factCount: row.fact_count },
    };

    const [coOccurring, links] = await Promise.all([
      getTopCoOccurring(params.id, limit),
      getFactLinks({ compoundIds: [params.id] }),
    ]);
    for (const c of coOccurring) {
      compoundNeighbors.set(c.compound_id, {
        id: c.compound_id,
        label: c.canonical_name,
        factCount: c.fact_count,
      });
    }
    const linkCount = countBySource(links);
    const sourceIds = [...linkCount.keys()]
      .sort((a, b) => (linkCount.get(b) ?? 0) - (linkCount.get(a) ?? 0))
      .slice(0, limit);
    for (const s of await getSourcesByIds(sourceIds)) {
      sourceNeighbors.set(s.id, {
        id: s.id,
        label: s.title,
        doi: s.doi,
        url: s.url,
        factCount: linkCount.get(s.id) ?? 0,
      });
    }
  } else {
    const [row] = await getSourcesByIds([params.id]);
    if (!row) throw new FocusNotFoundError("source", params.id);
    focus = {
      id: sourceNodeId(row.id),
      type: "source",
      label: row.title,
      meta: { doi: row.doi, url: row.url },
    };

    const [links, citation] = await Promise.all([
      getFactLinks({ sourceIds: [params.id] }),
      buildCitationGraph({ sourceId: params.id, limit }),
    ]);
    focusLinkCount = countByCompound(links);
    const compoundIds = [...focusLinkCount.keys()]
      .sort(
        (a, b) => (focusLinkCount.get(b) ?? 0) - (focusLinkCount.get(a) ?? 0),
      )
      .slice(0, limit);
    for (const c of await getCompoundsByIds(compoundIds)) {
      compoundNeighbors.set(c.id, {
        id: c.id,
        label: c.canonical_name,
        factCount: c.fact_count,
      });
    }
    for (const e of citation.edges) {
      if (e.otherSourceId === params.id) continue;
      sourceNeighbors.set(e.otherSourceId, {
        id: e.otherSourceId,
        label: e.otherTitle,
        doi: e.otherDoi,
        url: null,
        // The citation weight IS this neighbor's strength; there is no
        // fact_count in the citation payload.
        factCount: e.weight,
      });
      addEdge({
        source: focus.id,
        target: sourceNodeId(e.otherSourceId),
        type: "related_source",
        weight: e.weight,
        label: e.kinds.join(", "),
      });
    }
  }

  addNode(focus);
  for (const c of compoundNeighbors.values()) {
    addNode({
      id: compoundNodeId(c.id),
      type: "compound",
      label: c.label,
      meta: { factCount: c.factCount },
    });
  }
  for (const s of sourceNeighbors.values()) {
    addNode({
      id: sourceNodeId(s.id),
      type: "source",
      label: s.label,
      meta: { factCount: s.factCount, doi: s.doi, url: s.url },
    });
  }

  // --- 2) Spokes: focus -> neighbor ----------------------------------------
  //
  // Spoke TYPE follows the focus type: an entity links to its compounds and
  // sources structurally (`has_compound` / `has_source`), while a compound
  // focus links to a source through facts (`reports`) and to another compound
  // through shared sources (`co_occurs_with`). A source focus's spokes to
  // other sources are citation edges (`related_source`, emitted above).
  if (params.type === "entity") {
    for (const c of compoundNeighbors.values()) {
      addEdge({
        source: focus.id,
        target: compoundNodeId(c.id),
        type: "has_compound",
        weight: c.factCount,
      });
    }
    for (const s of sourceNeighbors.values()) {
      addEdge({
        source: focus.id,
        target: sourceNodeId(s.id),
        type: "has_source",
        weight: s.factCount,
      });
    }
  } else if (params.type === "compound") {
    for (const c of compoundNeighbors.values()) {
      addEdge({
        source: focus.id,
        target: compoundNodeId(c.id),
        type: "co_occurs_with",
        weight: c.factCount,
      });
    }
    for (const s of sourceNeighbors.values()) {
      addEdge({
        source: focus.id,
        target: sourceNodeId(s.id),
        type: "reports",
        weight: s.factCount,
      });
    }
  } else {
    for (const c of compoundNeighbors.values()) {
      addEdge({
        source: compoundNodeId(c.id),
        target: focus.id,
        type: "reports",
        weight: focusLinkCount.get(c.id) ?? 1,
      });
    }
  }

  // --- 3) Induced subgraph among the neighbors ------------------------------
  const neighborCompoundIds = [...compoundNeighbors.keys()];
  const neighborSourceIds = [...sourceNeighbors.keys()];

  // 3a) reports — compound <-> source, fact-backed. ONE batched query; the
  //     AND of both id sets means every returned link already has BOTH
  //     endpoints inside the neighbor set.
  if (neighborCompoundIds.length > 0 && neighborSourceIds.length > 0) {
    const links = await getFactLinks({
      compoundIds: neighborCompoundIds,
      sourceIds: neighborSourceIds,
    });
    const pairCounts = new Map<string, number>();
    for (const link of links) {
      const key = `${link.compound_canonical_id}|${link.source_id}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of pairCounts) {
      const [compoundId, sourceId] = key.split("|");
      addEdge({
        source: compoundNodeId(compoundId),
        target: sourceNodeId(sourceId),
        type: "reports",
        weight: count,
      });
    }
  }

  // 3b) co_occurs_with — compound <-> compound. Fan-out bounded: only the
  //     top-`fanout` neighbor compounds are expanded, in one Promise.all wave.
  if (neighborCompoundIds.length >= 2) {
    const seeds = topBy([...compoundNeighbors.values()], fanout);
    const results = await Promise.all(
      seeds.map((seed) => getTopCoOccurring(seed.id, limit)),
    );
    seeds.forEach((seed, i) => {
      for (const hit of results[i] ?? []) {
        // INDUCED: keep only edges whose other endpoint is a neighbor too.
        if (!compoundNeighbors.has(hit.compound_id)) continue;
        addEdge({
          source: compoundNodeId(seed.id),
          target: compoundNodeId(hit.compound_id),
          type: "co_occurs_with",
          weight: hit.fact_count,
        });
      }
    });
  }

  // 3c) related_source — source <-> source. Same fan-out bound;
  //     `buildCitationGraph` is the expensive term (~4 round trips each).
  if (neighborSourceIds.length >= 2) {
    const seeds = topBy([...sourceNeighbors.values()], fanout);
    const results = await Promise.all(
      seeds.map((seed) => buildCitationGraph({ sourceId: seed.id, limit })),
    );
    seeds.forEach((seed, i) => {
      for (const edge of results[i]?.edges ?? []) {
        // INDUCED: keep only edges whose other endpoint is a neighbor too.
        if (!sourceNeighbors.has(edge.otherSourceId)) continue;
        addEdge({
          source: sourceNodeId(seed.id),
          target: sourceNodeId(edge.otherSourceId),
          type: "related_source",
          weight: edge.weight,
          label: edge.kinds.join(", "),
        });
      }
    });
  }

  // --- 4) Emit --------------------------------------------------------------
  // Defensive: an edge must never reference an id absent from `nodes`.
  const emittedEdges = [...edges.values()]
    .filter((e) => nodes.has(e.source) && nodes.has(e.target))
    .sort((a, b) => b.weight - a.weight);
  const emittedNodes = [...nodes.values()];

  return {
    focus,
    nodes: emittedNodes,
    edges: emittedEdges,
    meta: {
      limit,
      fanout,
      elapsed: Date.now() - startedAt,
      counts: { nodes: emittedNodes.length, edges: emittedEdges.length },
    },
  };
}

/** Count fact links per `source_id`. Pure. */
function countBySource(links: FactLink[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of links) m.set(l.source_id, (m.get(l.source_id) ?? 0) + 1);
  return m;
}

/** Count fact links per `compound_canonical_id`. Pure. */
function countByCompound(links: FactLink[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of links) {
    m.set(
      l.compound_canonical_id,
      (m.get(l.compound_canonical_id) ?? 0) + 1,
    );
  }
  return m;
}

/** Top-N neighbors by `factCount` desc, id asc for a stable tie-break. Pure. */
function topBy<T extends { id: string; factCount: number }>(
  items: T[],
  n: number,
): T[] {
  return [...items]
    .sort((a, b) =>
      b.factCount !== a.factCount
        ? b.factCount - a.factCount
        : a.id.localeCompare(b.id),
    )
    .slice(0, n);
}
