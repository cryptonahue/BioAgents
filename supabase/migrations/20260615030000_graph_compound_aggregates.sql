-- Migration: Compound aggregate materialized view + soft-fail refresh function.
-- PR 1 of bioprospecting-knowledge-graph.
--
-- This migration is purely additive: it does not touch
-- research_bioprospecting_facts, research_bioprospecting_claims, or
-- research_sources. The new view is the read-side foundation for the
-- v1 knowledge graph.
--
-- The view is the source of truth for the search endpoint's compound
-- rows + per-compound stats. Co-occurring compounds, geographies, and
-- bioactivities are computed at request time (CTE) and live in their
-- own migration (20260615030010 / 20260615030020).
--
-- Why a materialized view (not a plain view):
--   O(1) on a single-row lookup; the planner does not re-aggregate the
--   full facts table on every request. Staleness is bounded by the
--   post-extraction refresh hook in
--   src/services/researchBrain/bioprospectingExtractor.ts.
--
-- Why the unique index is here:
--   REFRESH MATERIALIZED VIEW CONCURRENTLY requires a unique index.
--   Without it, the function's first concurrent refresh would fail.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) research_graph_compound_aggregates — one row per canonical compound.
--    Mirrors the spec schema exactly. 10 columns; LEFT JOIN keeps
--    zero-fact compounds in the view.
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS public.research_graph_compound_aggregates AS
SELECT
  c.id                              AS compound_id,
  c.canonical_name,
  c.normalized_name,
  c.pubchem_cid,
  c.chebi_id,
  c.molecular_formula,
  COUNT(DISTINCT f.id)              AS fact_count,
  COUNT(DISTINCT f.source_id)       AS source_count,
  COUNT(DISTINCT f.claim_id) FILTER (WHERE f.claim_id IS NOT NULL) AS claim_count,
  MAX(f.created_at)                 AS last_seen_at,
  MIN(f.created_at)                 AS first_seen_at
FROM public.research_compounds c
LEFT JOIN public.research_bioprospecting_facts f
  ON f.compound_canonical_id = c.id
GROUP BY
  c.id, c.canonical_name, c.normalized_name, c.pubchem_cid,
  c.chebi_id, c.molecular_formula;

-- ---------------------------------------------------------------------------
-- 2) Unique index — required for REFRESH ... CONCURRENTLY.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_research_graph_compound_aggregates_pk
  ON public.research_graph_compound_aggregates (compound_id);

-- ---------------------------------------------------------------------------
-- 3) Backs "top compounds by fact count" listings.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_research_graph_compound_aggregates_fact_count
  ON public.research_graph_compound_aggregates (fact_count DESC);

-- ---------------------------------------------------------------------------
-- 4) Backs "recently active compounds" listings.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_research_graph_compound_aggregates_last_seen
  ON public.research_graph_compound_aggregates (last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- 5) refresh_compound_aggregates — soft-fail wrapper around
--    REFRESH MATERIALIZED VIEW CONCURRENTLY. EXCEPTION WHEN OTHERS
--    absorbs the CONCURRENTLY-on-empty edge case so callers can run it
--    without their own try/catch.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_compound_aggregates()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY
    public.research_graph_compound_aggregates;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'refresh_compound_aggregates failed: %', SQLERRM;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6) GRANTs — mirror compound_authority / bioprospecting_dedup pattern.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.refresh_compound_aggregates()
  TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7) One-shot non-concurrent initial REFRESH so the view is populated
--    when the migration lands. CONCURRENTLY needs a prior version to
--    compare against; the migration's first populate is non-concurrent.
--    Idempotent: a re-run on a populated view is a no-op.
-- ---------------------------------------------------------------------------
REFRESH MATERIALIZED VIEW public.research_graph_compound_aggregates;

-- ---------------------------------------------------------------------------
-- 8) SELECT on the view so the API layer can read via the service role.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.research_graph_compound_aggregates
  TO anon, authenticated, service_role;

COMMIT;
