-- Migration: Library paper list — push the aggregation into the database.
--
-- WHY THIS EXISTS
--
-- `GET /api/library` was O(CHUNKS), not O(PAPERS). It called
-- `VectorSearchWithDocuments.listDocuments()`, which paged the ENTIRE
-- `documents` table in 1000-row ranges (PostgREST's `db-max-rows` cap)
-- and reconstructed the paper list in JS by grouping chunk rows by
-- title. On top of that it read EVERY `research_sources` row and EVERY
-- `research_bioprospecting_facts` row to enrich the list. A corpus of
-- 1000 papers x ~40 chunks means ~40k chunk rows crossed the wire on
-- every Library page load, of which ~25 were displayed.
--
-- Search, filtering, sorting and pagination cannot be layered on top of
-- that: paginating the JS array still transfers the whole corpus first.
-- So the grouping moves down here, and the API reads ONE PAGE.
--
-- WHAT THIS ADDS (all additive — no table is altered, no column added,
-- no row written; every object below can be dropped, see the rollback
-- block at the foot of this file)
--
--   1. Three IMMUTABLE filename parsers, mirroring the JS that
--      `src/routes/library.ts` and `client/src/pages/LibraryPage.tsx`
--      apply today.
--   2. `public.library_papers` — a LIVE view (deliberately NOT
--      materialized) with one row per paper: the chunk aggregate joined
--      to its research source, its claim count and its bioprospecting
--      taxa/geography.
--   3. `public.library_list_papers(...)` — the paged/filtered/sorted read
--      RPC. Returns `{ total, papers[] }` in one round trip.
--   4. `public.library_facets()` — the distinct taxa / geography / years /
--      trust tiers that the Library filter controls are populated from.
--
-- LIVE VIEW, NOT MATERIALIZED — AND WHY
--
-- A materialized view would make the read O(papers) on the server too,
-- but it needs a refresh hook on EVERY write path that touches
-- `documents`, `research_sources`, `research_claims` or
-- `research_bioprospecting_facts` — startup ingestion, the upload route,
-- the document-ingestion worker, the bioprospecting extractor and the
-- DELETE route. Miss one and a freshly uploaded paper is invisible in the
-- Library, or a deleted one lingers. That is a worse bug than a slow
-- query, so v1 stays live and always correct.
--
-- The scan is still O(chunks) INSIDE Postgres — but it is a HashAggregate
-- over a title-indexed heap, not 40k rows of JSON over the network, and
-- only the page is serialized. If the corpus ever grows past the point
-- where the aggregate is the bottleneck, promote `doc_stats` to a
-- materialized view with a refresh hook (the precedent is
-- `research_graph_compound_aggregates` +
-- `refresh_compound_aggregates()`, 20260615030000). That is a pure perf
-- change: the JSON contract of the two RPCs below does not move.
--
-- Idempotent (CREATE OR REPLACE / IF NOT EXISTS), single transaction,
-- mirroring 20260711000000_graph_entity_views.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Supporting index. The view groups `documents` by title; without this the
--    planner has nothing but a sequential scan to hash. `documents` is also
--    read by title on the per-paper RAG path (`getDocumentChunks`), which this
--    index serves too.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_documents_title
  ON public.documents (title);

-- ---------------------------------------------------------------------------
-- 2) Filename parsers.
--
-- Startup-ingested papers carry their metadata in the filename, e.g.
-- `Coral-Reef-Microbiome_2018_Springer-New-York-LLC.pdf`. These three
-- functions are the SQL port of `parseFilenameMeta()` (src/routes/library.ts)
-- and `displayTitle()` (client/src/pages/LibraryPage.tsx). They must be
-- IMMUTABLE so the view can be indexed against them later without a rewrite.
--
-- ONE DELIBERATE DIVERGENCE, documented rather than silently carried:
-- `parseFilenameMeta()` sliced the segment after the year and split it on `_`
-- ONLY, so the overwhelmingly common `..._2018_Springer-...` shape produced an
-- empty first segment and therefore a NULL publisher. That is a bug, not an
-- intent. `library_filename_publisher()` takes the first 2+-letter word after
-- the year regardless of which separator follows it. It can only ADD a
-- publisher where the old parser returned nothing; it never changes one that
-- structured metadata supplied (that still wins — see the view).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.library_filename_year(p_title TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT (regexp_match(
    regexp_replace(coalesce(p_title, ''), '\.[a-zA-Z0-9]+$', ''),
    '(?:^|[-_[:space:]])((?:19|20)[0-9]{2})(?=[-_[:space:]]|$)'
  ))[1]::integer;
$$;

CREATE OR REPLACE FUNCTION public.library_filename_publisher(p_title TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT (regexp_match(
    regexp_replace(coalesce(p_title, ''), '\.[a-zA-Z0-9]+$', ''),
    '(?:^|[-_[:space:]])(?:19|20)[0-9]{2}[-_[:space:]]+([A-Za-z]{2,})'
  ))[1];
$$;

-- The human-readable title used for SORTING and SEARCHING. Strips the
-- extension, drops the trailing `_YEAR_Publisher-...` tail, and turns the
-- separators into spaces. The API still returns the RAW title (the docId is
-- derived from it), so this is a derived column, not a replacement.
CREATE OR REPLACE FUNCTION public.library_display_title(p_title TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(
    NULLIF(
      btrim(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(coalesce(p_title, ''), '\.[a-zA-Z0-9]+$', ''),
              '[-_[:space:]]((?:19|20)[0-9]{2})[-_[:space:]].*$', ''
            ),
            '[-_]+', ' ', 'g'
          ),
          '[[:space:]]+', ' ', 'g'
        )
      ),
      ''
    ),
    coalesce(p_title, '')
  );
$$;

-- ---------------------------------------------------------------------------
-- 3) library_papers — ONE ROW PER PAPER.
--
-- `doc_stats` is the aggregate that used to run in JS. The source join is a
-- LATERAL with the SAME precedence the route applied by hand: match
-- `research_sources` by title first, fall back to the document's stored
-- `metadata.filePath`.
--
-- `evidence_count` is the Research Brain claim count — the signal that answers
-- "can the agent actually cite this paper?". It is 0, never NULL, so a
-- zero-evidence paper is a VISIBLE state rather than a missing field.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.library_papers AS
SELECT
  p.*,
  lower(
    concat_ws(
      ' ',
      p.title,
      p.display_title,
      p.meta_title,
      p.publisher,
      array_to_string(p.taxa, ' '),
      array_to_string(p.geography, ' ')
    )
  ) AS search_text
FROM (
  SELECT
    ds.title,
    public.library_display_title(ds.title)          AS display_title,
    ds.chunk_count,
    NULLIF(btrim(ds.metadata ->> 'type'), '')       AS type,
    CASE
      WHEN ds.metadata ->> 'size' ~ '^[0-9]+$'
      THEN (ds.metadata ->> 'size')::bigint
    END                                             AS size,
    NULLIF(btrim(ds.metadata ->> 'filePath'), '')   AS file_path,
    NULLIF(btrim(ds.metadata ->> 'lastModified'), '') AS last_modified,
    s.id                                            AS research_source_id,
    NULLIF(btrim(s.doi), '')                        AS doi,
    s.trust_tier::text                              AS trust_tier,
    s.bioprospecting_fact_count,
    NULLIF(btrim(s.metadata ->> 'title'), '')       AS meta_title,
    COALESCE(
      CASE
        WHEN s.metadata ->> 'year' ~ '^(19|20)[0-9]{2}$'
        THEN (s.metadata ->> 'year')::integer
      END,
      public.library_filename_year(ds.title)
    )                                               AS year,
    COALESCE(
      NULLIF(btrim(s.metadata ->> 'journal'), ''),
      NULLIF(btrim(s.metadata ->> 'publisher'), ''),
      public.library_filename_publisher(ds.title)
    )                                               AS publisher,
    COALESCE(ca.evidence_count, 0)                  AS evidence_count,
    COALESCE(fa.taxa, ARRAY[]::text[])              AS taxa,
    COALESCE(fa.geography, ARRAY[]::text[])         AS geography
  FROM (
    SELECT
      d.title,
      count(*)::bigint AS chunk_count,
      (array_agg(d.metadata ORDER BY d.created_at NULLS LAST))[1] AS metadata
    FROM public.documents d
    GROUP BY d.title
  ) ds
  LEFT JOIN LATERAL (
    SELECT rs.*
    FROM public.research_sources rs
    WHERE rs.title = ds.title
       OR (
         NULLIF(btrim(ds.metadata ->> 'filePath'), '') IS NOT NULL
         AND rs.file_path = ds.metadata ->> 'filePath'
       )
    -- Title match wins, exactly like the route's `sourceByTitle ?? sourceByPath`.
    ORDER BY (rs.title = ds.title) DESC, rs.created_at ASC
    LIMIT 1
  ) s ON TRUE
  LEFT JOIN (
    SELECT c.source_id, count(*)::bigint AS evidence_count
    FROM public.research_claims c
    WHERE c.source_id IS NOT NULL
    GROUP BY c.source_id
  ) ca ON ca.source_id = s.id
  LEFT JOIN (
    SELECT
      f.source_id,
      array_remove(
        array_agg(DISTINCT COALESCE(
          NULLIF(btrim(f.species), ''),
          NULLIF(btrim(f.genus), '')
        )),
        NULL
      ) AS taxa,
      array_remove(array_agg(DISTINCT NULLIF(btrim(f.geography), '')), NULL)
        AS geography
    FROM public.research_bioprospecting_facts f
    GROUP BY f.source_id
  ) fa ON fa.source_id = s.id
) p;

-- ---------------------------------------------------------------------------
-- 4) library_list_papers — the paged read.
--
-- Every argument is a VALUE, never an identifier: the sort key and direction
-- are matched against a fixed allowlist and applied through CASE expressions,
-- so there is no dynamic SQL and no injection surface (unlike
-- `graph_entity_expand`, which needs %I because it reads a dynamic COLUMN).
--
-- SEARCH is token-AND containment, not a single LIKE. "caribbean coral" matches
-- a paper whose title says Caribbean and whose taxa say coral — which is how a
-- researcher actually recalls a paper ("the Caribbean coral one"), and what a
-- single `%caribbean coral%` LIKE would miss. `strpos()` takes the needle as a
-- VALUE, so no wildcard escaping is needed at all.
--
-- Returns `{ total, papers[] }`: `total` is the count BEFORE the page window,
-- which is what the pagination control needs and what a `.range()` on a view
-- would have needed a second round trip to get.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.library_list_papers(
  p_search     TEXT    DEFAULT NULL,
  p_taxon      TEXT    DEFAULT NULL,
  p_geography  TEXT    DEFAULT NULL,
  p_year       INTEGER DEFAULT NULL,
  p_trust_tier TEXT    DEFAULT NULL,
  p_sort       TEXT    DEFAULT 'year',
  p_dir        TEXT    DEFAULT 'desc',
  p_limit      INTEGER DEFAULT 25,
  p_offset     INTEGER DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_sort   TEXT   := lower(coalesce(p_sort, 'year'));
  v_dir    TEXT   := lower(coalesce(p_dir, 'desc'));
  v_limit  INT    := greatest(1, least(coalesce(p_limit, 25), 100));
  v_offset INT    := greatest(0, coalesce(p_offset, 0));
  v_taxon  TEXT   := NULLIF(btrim(coalesce(p_taxon, '')), '');
  v_geo    TEXT   := NULLIF(btrim(coalesce(p_geography, '')), '');
  v_tier   TEXT   := NULLIF(btrim(coalesce(p_trust_tier, '')), '');
  v_tokens TEXT[] := CASE
                       WHEN btrim(coalesce(p_search, '')) = '' THEN NULL
                       ELSE regexp_split_to_array(
                              lower(btrim(p_search)), '[[:space:]]+')
                     END;
  v_result jsonb;
BEGIN
  IF v_sort NOT IN ('year', 'evidence', 'title') THEN v_sort := 'year'; END IF;
  IF v_dir NOT IN ('asc', 'desc') THEN v_dir := 'desc'; END IF;

  WITH filtered AS (
    SELECT lp.*
    FROM public.library_papers lp
    WHERE (
        v_tokens IS NULL
        OR (SELECT bool_and(strpos(lp.search_text, tok) > 0)
            FROM unnest(v_tokens) AS tok)
      )
      AND (v_taxon IS NULL OR lp.taxa @> ARRAY[v_taxon])
      AND (v_geo   IS NULL OR lp.geography @> ARRAY[v_geo])
      AND (p_year  IS NULL OR lp.year = p_year)
      AND (v_tier  IS NULL OR lp.trust_tier = v_tier)
  ),
  page AS (
    SELECT f.*, row_number() OVER () AS rn
    FROM (
      SELECT *
      FROM filtered
      ORDER BY
        CASE WHEN v_sort = 'year'     AND v_dir = 'desc' THEN year           END DESC NULLS LAST,
        CASE WHEN v_sort = 'year'     AND v_dir = 'asc'  THEN year           END ASC  NULLS LAST,
        CASE WHEN v_sort = 'evidence' AND v_dir = 'desc' THEN evidence_count END DESC,
        CASE WHEN v_sort = 'evidence' AND v_dir = 'asc'  THEN evidence_count END ASC,
        CASE WHEN v_sort = 'title'    AND v_dir = 'desc' THEN display_title  END DESC,
        CASE WHEN v_sort = 'title'    AND v_dir = 'asc'  THEN display_title  END ASC,
        -- Stable tiebreak: without it a page boundary can repeat or skip a row.
        display_title ASC, title ASC
      LIMIT v_limit OFFSET v_offset
    ) f
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM filtered),
    'papers', COALESCE(
      (SELECT jsonb_agg((to_jsonb(x) - 'search_text' - 'rn') ORDER BY x.rn)
       FROM page x),
      '[]'::jsonb
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) library_facets — the filter vocabulary.
--
-- A marine-bioprospecting corpus is navigated by ORGANISM and PLACE, so taxa
-- and geography are the primary axes; year and trust tier are secondary. Each
-- facet carries its paper count so the control can show "Porites (14)" and a
-- researcher can see where the corpus is dense before spending a click.
--
-- Facets are GLOBAL (they do not narrow as other filters are applied). That is
-- deliberate for v1: cross-filtered facets need one aggregate per axis per
-- request, and the payoff — greying out combinations that yield nothing — is
-- small next to the cost. The counts are honest about the whole corpus.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.library_facets()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'taxa', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('value', t.value, 'count', t.n)
                       ORDER BY t.n DESC, t.value ASC)
      FROM (
        SELECT tx AS value, count(*)::int AS n
        FROM public.library_papers lp, unnest(lp.taxa) AS tx
        GROUP BY tx
        ORDER BY count(*) DESC, tx ASC
        LIMIT 100
      ) t
    ), '[]'::jsonb),
    'geography', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('value', g.value, 'count', g.n)
                       ORDER BY g.n DESC, g.value ASC)
      FROM (
        SELECT gx AS value, count(*)::int AS n
        FROM public.library_papers lp, unnest(lp.geography) AS gx
        GROUP BY gx
        ORDER BY count(*) DESC, gx ASC
        LIMIT 100
      ) g
    ), '[]'::jsonb),
    'years', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('value', y.value, 'count', y.n)
                       ORDER BY y.value DESC)
      FROM (
        SELECT lp.year AS value, count(*)::int AS n
        FROM public.library_papers lp
        WHERE lp.year IS NOT NULL
        GROUP BY lp.year
      ) y
    ), '[]'::jsonb),
    'trustTiers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('value', tt.value, 'count', tt.n)
                       ORDER BY tt.n DESC, tt.value ASC)
      FROM (
        SELECT lp.trust_tier AS value, count(*)::int AS n
        FROM public.library_papers lp
        WHERE lp.trust_tier IS NOT NULL
        GROUP BY lp.trust_tier
      ) tt
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- 6) GRANTs — mirror graph_entity_views / graph_compound_aggregates.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.library_papers
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.library_filename_year(TEXT)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.library_filename_publisher(TEXT)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.library_display_title(TEXT)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.library_list_papers(
  TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, INTEGER, INTEGER)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.library_facets()
  TO anon, authenticated, service_role;

COMMIT;

-- ---------------------------------------------------------------------------
-- ROLLBACK (nothing here is destructive; dropping these restores the previous
-- schema exactly, since no existing object was modified):
--
--   DROP FUNCTION IF EXISTS public.library_facets();
--   DROP FUNCTION IF EXISTS public.library_list_papers(
--     TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, INTEGER, INTEGER);
--   DROP VIEW IF EXISTS public.library_papers;
--   DROP FUNCTION IF EXISTS public.library_display_title(TEXT);
--   DROP FUNCTION IF EXISTS public.library_filename_publisher(TEXT);
--   DROP FUNCTION IF EXISTS public.library_filename_year(TEXT);
--   DROP INDEX IF EXISTS public.idx_documents_title;
-- ---------------------------------------------------------------------------
