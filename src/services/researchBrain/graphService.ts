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
