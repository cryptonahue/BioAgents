-- Migration: graph_top_co_occurring — query-time CTE that returns the
-- top co-occurring compounds (by shared source count) for a given
-- input compound.
--
-- This function reads from research_bioprospecting_facts (the source
-- of truth), NOT from the compound-aggregates matview, because
-- co-occurrence is a per-fact operation.
--
-- In v1 the CTE is computed at request time. The v1 corpus is small
-- enough that this is cheap. v3 may promote it to a
-- research_graph_compound_co_occurrences table without changing the
-- API contract.
--
-- Contract:
--   - Input: a compound UUID + a row limit (default caller, no default
--     in the SQL function).
--   - Output: at most `p_limit` rows of (compound_id, canonical_name,
--     fact_count) ordered by shared-source count DESC, then
--     canonical_name ASC.
--   - Excludes the input compound from the result set (a compound
--     does not co-occur with itself).

BEGIN;

CREATE OR REPLACE FUNCTION public.graph_top_co_occurring(
  p_compound_id UUID,
  p_limit INTEGER
)
RETURNS TABLE (
  compound_id UUID,
  canonical_name TEXT,
  fact_count BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH shared_sources AS (
    SELECT DISTINCT f.source_id
    FROM public.research_bioprospecting_facts f
    WHERE f.compound_canonical_id = p_compound_id
      AND f.source_id IS NOT NULL
  ),
  cooccurring AS (
    SELECT
      f2.compound_canonical_id AS other_id,
      c.canonical_name,
      COUNT(DISTINCT f2.source_id) AS shared_source_count
    FROM public.research_bioprospecting_facts f2
    JOIN shared_sources ss ON ss.source_id = f2.source_id
    JOIN public.research_compounds c ON c.id = f2.compound_canonical_id
    WHERE f2.compound_canonical_id IS NOT NULL
      AND f2.compound_canonical_id <> p_compound_id
    GROUP BY f2.compound_canonical_id, c.canonical_name
  )
  SELECT
    other_id AS compound_id,
    canonical_name,
    shared_source_count::BIGINT AS fact_count
  FROM cooccurring
  ORDER BY shared_source_count DESC, canonical_name ASC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.graph_top_co_occurring(UUID, INTEGER)
  TO anon, authenticated, service_role;

COMMIT;
