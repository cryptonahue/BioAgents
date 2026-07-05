-- Migration: Fix `get_contradiction_stats` RPC against current schema
--
-- The original migration `20260616000200_get_contradiction_stats_rpc.sql`
-- referenced columns and timestamps that don't exist on the
-- `research_bioprospecting_contradictions` table:
--
--   - `resolution_status`  -> column is named `status` (with the
--                            check constraint restricting values to
--                            'open' / 'resolved' / 'dismissed')
--   - `created_at`         -> column is named `detected_at`
--   - `dismissed_at`       -> there is no separate dismissed-at; a
--                            dismissed row is recorded by `status =
--                            'dismissed'` with `resolved_at` set to
--                            the dismiss timestamp (same shape as
--                            'resolved', distinguished by status).
--
-- This migration is `CREATE OR REPLACE FUNCTION` so:
--   - re-running it on a fresh DB that already executed the broken
--     migration replaces the broken function body with the fixed one,
--   - re-running it on a DB that did not execute the broken migration
--     creates the function from scratch.
--
-- Behavior preserved from the spec contract:
--   - Returns 2 rows (`1d` and `7d` window labels).
--   - Each row carries `found`, `resolved`, `dismissed`.
--   - Window filter is applied to `detected_at` (the row creation
--     timestamp on this table; `resolved_at` is the resolution
--     timestamp and would skew the window selection).
--
-- Permissions preserved: EXECUTE is restricted to `service_role`
-- (the route authenticates via `getServiceClient()`).
--
-- Spec: openspec/changes/bioprospecting-review-ui/specs/.../spec.md
--       "Stats endpoint shape (today + last 7d x 6 metrics)".

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
  -- 1d window
  SELECT
    '1d'::text AS window_label,
    COUNT(*)::bigint AS found,
    COUNT(*) FILTER (
      WHERE status = 'resolved' AND resolved_at >= NOW() - window_1d
    )::bigint AS resolved,
    COUNT(*) FILTER (
      WHERE status = 'dismissed' AND resolved_at >= NOW() - window_1d
    )::bigint AS dismissed
  FROM public.research_bioprospecting_contradictions
  WHERE detected_at >= NOW() - window_1d
  UNION ALL
  -- 7d window
  SELECT
    '7d'::text AS window_label,
    COUNT(*)::bigint AS found,
    COUNT(*) FILTER (
      WHERE status = 'resolved' AND resolved_at >= NOW() - window_7d
    )::bigint AS resolved,
    COUNT(*) FILTER (
      WHERE status = 'dismissed' AND resolved_at >= NOW() - window_7d
    )::bigint AS dismissed
  FROM public.research_bioprospecting_contradictions
  WHERE detected_at >= NOW() - window_7d;
$$;

-- Restrict execution to the service role. The route authenticates
-- via `getServiceClient()` (Postgres role `service_role`); the
-- anon and authenticated roles are intentionally excluded.
--
-- IMPORTANT: the original migration only revoked from PUBLIC, but
-- Postgres grants EXECUTE to PUBLIC on function creation by default.
-- REVOKE FROM PUBLIC alone does not strip the grant when the roles
-- have been granted independently. We explicitly revoke from PUBLIC,
-- anon, AND authenticated so the only role that retains EXECUTE is
-- service_role.
REVOKE ALL ON FUNCTION public.get_contradiction_stats(interval, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_contradiction_stats(interval, interval) FROM anon;
REVOKE ALL ON FUNCTION public.get_contradiction_stats(interval, interval) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_contradiction_stats(interval, interval) TO service_role;

-- Notify PostgREST so the schema cache picks up the new function body
-- without a service restart. Idempotent: re-running on a fresh DB
-- that already has the cached body is a no-op.
NOTIFY pgrst, 'reload schema';