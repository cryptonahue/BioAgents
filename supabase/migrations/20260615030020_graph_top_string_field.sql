-- Migration: graph_top_string_field — query-time groupby over a
-- free-text column on research_bioprospecting_facts. The supported
-- fields are 'geography' and 'bioactivity' (v1 contract).
--
-- Why a SQL function (not two hard-coded queries):
--   The field name is a column identifier, not a value, so it cannot
--   be parameterized with $1. We use format() with %I to safely
--   quote the identifier, and we validate the input against an
--   allowlist before constructing the SQL. This prevents SQL
--   injection via p_field.
--
-- Contract:
--   - Input: a field name ('geography' or 'bioactivity'), a compound
--     UUID, and a row limit.
--   - Output: at most `p_limit` rows of (value, fact_count) ordered
--     by fact_count DESC, then value ASC.
--   - Skips NULL and empty-string rows.

BEGIN;

CREATE OR REPLACE FUNCTION public.graph_top_string_field(
  p_field TEXT,         -- 'geography' or 'bioactivity'
  p_compound_id UUID,
  p_limit INTEGER
)
RETURNS TABLE (
  value TEXT,
  fact_count BIGINT
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  sql_body TEXT;
BEGIN
  IF p_field NOT IN ('geography', 'bioactivity') THEN
    RAISE EXCEPTION 'graph_top_string_field: invalid field %', p_field;
  END IF;

  sql_body := format(
    'SELECT %I::TEXT AS value, COUNT(*)::BIGINT AS fact_count
     FROM public.research_bioprospecting_facts
     WHERE compound_canonical_id = $1
       AND %I IS NOT NULL
       AND %I <> ''''
     GROUP BY %I
     ORDER BY fact_count DESC, value ASC
     LIMIT $2',
    p_field, p_field, p_field, p_field
  );
  RETURN QUERY EXECUTE sql_body USING p_compound_id, p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.graph_top_string_field(TEXT, UUID, INTEGER)
  TO anon, authenticated, service_role;

COMMIT;
