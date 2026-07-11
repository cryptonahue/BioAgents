-- Migration: KG v2 — entity mention graph (LLM-free, read-only, additive).
-- PR 2 of bioprospecting-knowledge-graph.
--
-- Makes the three free-text entity columns on
-- research_bioprospecting_facts — bioactivity, application_area,
-- assay_model — consultable as entity nodes, mirroring how v1 made
-- research_compounds consultable.
--
-- The whole surface is read-only, LLM-free, and purely additive:
--   - no ALTER/DROP/column-add on any existing table
--   - no extractor / write-path change, no refresh hook
--   - a LIVE view (NOT materialized), so the graph is always fresh
--
-- Unlike v1's materialized view + post-extraction refresh hook, v2
-- ships live SQL objects only: one live view, one immutable
-- normalizer, and two allowlisted RPCs. Promotion to a matview is a
-- deferred perf optimization that would NOT change the JSON contract.
--
-- Idempotent (CREATE OR REPLACE / IF NOT EXISTS), wrapped in a single
-- transaction, mirroring 20260615030000_graph_compound_aggregates.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) graph_normalize_entity — pure, IMMUTABLE, LLM-free normalizer.
--    Single source of truth for the search-key == expand-key invariant.
--    Steps, in order:
--      1) lower + trim
--      2) strip hyphens / unicode dashes (antifungal = anti-fungal)
--      3) collapse internal whitespace runs to a single space
--      4) conservative singularization: strip a trailing 's' ONLY when
--         it follows a consonant other than 's' (so 'antifungals' ->
--         'antifungal', 'assays' -> 'assay', but 'class'/'analysis'/
--         'virus' are untouched).
--    IMMUTABLE is load-bearing: the expression indexes below cannot be
--    created against a STABLE/VOLATILE function. PARALLEL SAFE lets the
--    live GROUP BY parallelize.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.graph_normalize_entity(p_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(
    regexp_replace(                                        -- 4) singularize
      regexp_replace(                                      -- 3) collapse ws
        regexp_replace(                                    -- 2) strip dashes
          lower(btrim(coalesce(p_value, ''))),             -- 1) lower + trim
          '[-‐‑‒–—]', '', 'g'
        ),
        '\s+', ' ', 'g'
      ),
      '([bcdfghjklmnpqrtvwxyz])s$', '\1'
    ),
  '');
$$;

-- ---------------------------------------------------------------------------
-- 2) research_graph_entities — live UNION node view (NOT materialized).
--    One node per (kind, normalized value). Counts are DISTINCT, not row
--    counts. display = most frequent raw form (ties -> lexicographically
--    smallest). Blank/NULL raw values produce no node.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.research_graph_entities AS
WITH mentions AS (
  SELECT 'bioactivity'::text AS kind, f.bioactivity AS raw,
         f.compound_canonical_id, f.id AS fact_id, f.source_id
  FROM public.research_bioprospecting_facts f
  WHERE f.bioactivity IS NOT NULL AND btrim(f.bioactivity) <> ''
  UNION ALL
  SELECT 'application_area'::text, f.application_area,
         f.compound_canonical_id, f.id, f.source_id
  FROM public.research_bioprospecting_facts f
  WHERE f.application_area IS NOT NULL AND btrim(f.application_area) <> ''
  UNION ALL
  SELECT 'assay_model'::text, f.assay_model,
         f.compound_canonical_id, f.id, f.source_id
  FROM public.research_bioprospecting_facts f
  WHERE f.assay_model IS NOT NULL AND btrim(f.assay_model) <> ''
),
normalized AS (
  SELECT m.kind,
         public.graph_normalize_entity(m.raw) AS value,
         m.raw,
         m.compound_canonical_id, m.fact_id, m.source_id
  FROM mentions m
)
SELECT
  n.kind,
  n.value,
  mode() WITHIN GROUP (ORDER BY n.raw)       AS display,       -- most frequent raw form
  COUNT(DISTINCT n.compound_canonical_id)    AS compound_count,
  COUNT(DISTINCT n.fact_id)                  AS fact_count,
  COUNT(DISTINCT n.source_id)                AS source_count
FROM normalized n
WHERE n.value IS NOT NULL AND n.value <> ''
GROUP BY n.kind, n.value;

-- ---------------------------------------------------------------------------
-- 3) graph_entity_search — allowlisted search RPC.
--    Reads the pre-aggregated live view and filters by the kind LITERAL
--    column (no dynamic column -> zero identifier-injection surface).
--    The :kind allowlist is still enforced (raise on unknown so the
--    route can map it to 400). The user's raw query is passed through
--    the SAME graph_normalize_entity() before the ILIKE, so 'Anti-Fungal',
--    'antifungals', and 'antifungal' all match the one node.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.graph_entity_search(
  p_kind  TEXT,
  p_query TEXT,
  p_limit INTEGER
)
RETURNS TABLE (
  kind TEXT, value TEXT, display TEXT,
  compound_count BIGINT, fact_count BIGINT, source_count BIGINT
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_norm  TEXT;
  v_limit INT := greatest(1, least(coalesce(p_limit, 20), 100));
BEGIN
  IF p_kind NOT IN ('bioactivity', 'application_area', 'assay_model') THEN
    RAISE EXCEPTION 'graph_entity_search: invalid kind %', p_kind
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_norm := public.graph_normalize_entity(coalesce(p_query, ''));

  RETURN QUERY
  SELECT e.kind, e.value, e.display,
         e.compound_count, e.fact_count, e.source_count
  FROM public.research_graph_entities e
  WHERE e.kind = p_kind
    AND (
      v_norm = ''  -- empty query -> list top nodes by fact_count
      OR e.value ILIKE '%' ||
         replace(replace(v_norm, '%', '\%'), '_', '\_') || '%'
    )
  ORDER BY e.fact_count DESC, e.value ASC
  LIMIT v_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4) graph_entity_expand — allowlisted %I expand RPC.
--    Expand needs per-fact rows, so it reads the raw column dynamically.
--    Reuses v1's graph_top_string_field pattern: allowlist first, %I for
--    the identifier, parameters ($1/$2) for values (never interpolated).
--    Returns a single jsonb { compounds, facts, sources } so one
--    round-trip yields the whole 1-hop neighborhood. A non-matching
--    p_value returns the empty-arrays payload (200 empty, NOT an error).
-- ---------------------------------------------------------------------------
-- p_value is normalized here (graph_normalize_entity($1)) rather than
-- compared raw, so a caller passing the normalized key emitted by
-- search OR a raw variant (e.g. 'Anti-Fungal') both resolve to the same
-- node. Normalization stays 100% in SQL (the single-source invariant);
-- the service/route pass the value verbatim. The function is idempotent,
-- so an already-normalized key still matches unchanged.
CREATE OR REPLACE FUNCTION public.graph_entity_expand(
  p_kind  TEXT,
  p_value TEXT,      -- a normalized key (from search) OR a raw variant
  p_limit INTEGER
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_col    TEXT;
  v_limit  INT := greatest(1, least(coalesce(p_limit, 20), 100));
  v_result jsonb;
BEGIN
  IF p_kind NOT IN ('bioactivity', 'application_area', 'assay_model') THEN
    RAISE EXCEPTION 'graph_entity_expand: invalid kind %', p_kind
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_col := p_kind;  -- allowlisted; quoted via %I below

  EXECUTE format($q$
    WITH matched AS (
      SELECT f.id AS fact_id, f.source_id, f.compound_canonical_id,
             f.result_summary, f.quote, f.page, f.doi
      FROM public.research_bioprospecting_facts f
      WHERE public.graph_normalize_entity(f.%1$I) = public.graph_normalize_entity($1)
    ),
    compounds AS (
      SELECT c.id, c.canonical_name,
             COUNT(DISTINCT m.fact_id) AS fact_count
      FROM matched m
      JOIN public.research_compounds c ON c.id = m.compound_canonical_id
      WHERE m.compound_canonical_id IS NOT NULL
      GROUP BY c.id, c.canonical_name
      ORDER BY fact_count DESC, c.canonical_name ASC
      LIMIT $2
    ),
    facts AS (
      SELECT m.fact_id AS id, m.source_id, m.compound_canonical_id,
             m.result_summary, m.quote, m.page, m.doi
      FROM matched m
      ORDER BY m.fact_id
      LIMIT $2
    ),
    sources AS (
      SELECT s.id, s.title, s.doi, s.url,
             COUNT(DISTINCT m.fact_id) AS fact_count
      FROM matched m
      JOIN public.research_sources s ON s.id = m.source_id
      GROUP BY s.id, s.title, s.doi, s.url
      ORDER BY fact_count DESC, s.title ASC
      LIMIT $2
    )
    SELECT jsonb_build_object(
      'compounds', COALESCE((SELECT jsonb_agg(to_jsonb(compounds)) FROM compounds), '[]'::jsonb),
      'facts',     COALESCE((SELECT jsonb_agg(to_jsonb(facts))     FROM facts),     '[]'::jsonb),
      'sources',   COALESCE((SELECT jsonb_agg(to_jsonb(sources))   FROM sources),   '[]'::jsonb)
    )
  $q$, v_col)
  INTO v_result
  USING p_value, v_limit;

  RETURN COALESCE(
    v_result,
    jsonb_build_object('compounds', '[]'::jsonb,
                       'facts',     '[]'::jsonb,
                       'sources',   '[]'::jsonb)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) Partial expression indexes (keep the live view fast without
--    materializing). One per kind. These are the reason
--    graph_normalize_entity is IMMUTABLE — they turn expand's lookup
--    into an index scan rather than a per-row function eval.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_bioprospecting_norm_bioactivity
  ON public.research_bioprospecting_facts (public.graph_normalize_entity(bioactivity))
  WHERE bioactivity IS NOT NULL AND bioactivity <> '';

CREATE INDEX IF NOT EXISTS idx_bioprospecting_norm_application_area
  ON public.research_bioprospecting_facts (public.graph_normalize_entity(application_area))
  WHERE application_area IS NOT NULL AND application_area <> '';

CREATE INDEX IF NOT EXISTS idx_bioprospecting_norm_assay_model
  ON public.research_bioprospecting_facts (public.graph_normalize_entity(assay_model))
  WHERE assay_model IS NOT NULL AND assay_model <> '';

-- ---------------------------------------------------------------------------
-- 6) GRANTs — mirror v1 (graph_compound_aggregates / graph_top_string_field).
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.research_graph_entities
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.graph_normalize_entity(TEXT)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.graph_entity_search(TEXT, TEXT, INTEGER)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.graph_entity_expand(TEXT, TEXT, INTEGER)
  TO anon, authenticated, service_role;

COMMIT;
