-- Migration: get_contradiction_stats RPC
--
-- Postgres function that returns the activity snapshot for the new
-- admin-only `GET /api/research-brain/contradictions/stats` route. The
-- shape is 6 rows (3 metrics × 2 windows) computed via `COUNT(*) FILTER
-- (WHERE ...)` aggregations on the `research_bioprospecting_contradictions`
-- table. Supabase's `.from(view).select(...)` cannot express
-- `COUNT(*) FILTER`, so we expose this through a SECURITY DEFINER
-- function and grant EXECUTE to the `service_role` only (the route uses
-- `getServiceClient()` which authenticates as the service role).
--
-- Dedup metrics (merges, unmerges) are NOT computed here — they live
-- on `research_bioprospecting_fact_edges` and are read by the route
-- in a second round-trip (see design.md §"Stats query plan"). Mixing
-- them into this RPC would couple the function to the dedup soft-delete
-- columns added in the previous migration.
--
-- Idempotency: `CREATE OR REPLACE FUNCTION` is safe to re-run; the
-- `DROP GRANT` + `GRANT` pair is also idempotent.

CREATE OR REPLACE FUNCTION public.get_contradiction_stats(
  window_1d interval,
  window_7d interval
)
RETURNS TABLE (
  window_label text,
  found bigint,
  resolved bigint,
  dismissed bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    '1d'::text AS window_label,
    COUNT(*)::bigint AS found,
    COUNT(*) FILTER (
      WHERE resolution_status = 'resolved' AND resolved_at >= NOW() - window_1d
    )::bigint AS resolved,
    COUNT(*) FILTER (
      WHERE resolution_status = 'dismissed' AND resolved_at >= NOW() - window_1d
    )::bigint AS dismissed
  FROM public.research_bioprospecting_contradictions
  WHERE created_at >= NOW() - window_1d
  UNION ALL
  SELECT
    '7d'::text AS window_label,
    COUNT(*)::bigint AS found,
    COUNT(*) FILTER (
      WHERE resolution_status = 'resolved' AND resolved_at >= NOW() - window_7d
    )::bigint AS resolved,
    COUNT(*) FILTER (
      WHERE resolution_status = 'dismissed' AND resolved_at >= NOW() - window_7d
    )::bigint AS dismissed
  FROM public.research_bioprospecting_contradictions
  WHERE created_at >= NOW() - window_7d;
$$;

-- Restrict execution to the service role. The route authenticates
-- via `getServiceClient()` (Postgres role `service_role`); the
-- anon and authenticated roles are intentionally excluded.
REVOKE ALL ON FUNCTION public.get_contradiction_stats(interval, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_contradiction_stats(interval, interval) TO service_role;
