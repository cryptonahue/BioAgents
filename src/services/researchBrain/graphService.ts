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
