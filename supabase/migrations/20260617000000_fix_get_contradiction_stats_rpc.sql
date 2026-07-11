-- Migration: Reconcile `research_bioprospecting_contradictions` with the
-- live schema, then fix the `get_contradiction_stats` RPC against it.
--
-- ---------------------------------------------------------------------------
-- PART 0 — schema reconciliation (added by `contradiction-detection-fix`)
-- ---------------------------------------------------------------------------
--
-- `20260610000000_create_bioprospecting_contradictions.sql` creates the table
-- with the ORIGINAL spec column names (`source_fact_id`, `conflicting_fact_id`,
-- `contradiction_type`, `evidence_pack`, `resolution_status`, `created_at`).
-- The live database, however, carries the renamed columns this migration and
-- ALL backend code (`contradictionDb.ts`, `reviewService.ts`,
-- `types.ts:ResearchBioprospectingContradiction`) actually use:
-- `fact_a_id`, `fact_b_id`, `conflict_type`, `severity`, `explanation`,
-- `status` ('open' | 'resolved' | 'dismissed'), `detected_at`,
-- `resolution_note`, `metadata`.
--
-- That rename was never captured in a migration, so the repo could NOT rebuild
-- the live DB: a from-scratch `supabase db reset` failed right here, because
-- Postgres validates a LANGUAGE sql function body at CREATE time and the body
-- below references `status` / `detected_at`, columns the migration chain had
-- not yet produced.
--
-- The reconciliation is placed in THIS file — the one that already documents
-- the divergence — deliberately:
--   * It must run BEFORE the CREATE OR REPLACE below, so a later migration
--     could not fix the from-scratch rebuild (the chain dies before reaching
--     it). Ordering, not preference, forces the placement.
--   * This migration is already applied on the live DB, so it will NOT be
--     re-executed there: the change is a strict no-op for production.
--   * Every statement is guarded against `information_schema`, so it is also
--     a no-op on any database that already has the live shape.
-- The applied `20260610` migration is intentionally left untouched; this is a
-- forward-only rename, not a rewrite of history.

DO $$
BEGIN
  IF to_regclass('public.research_bioprospecting_contradictions') IS NULL THEN
    RETURN;
  END IF;

  -- 1. Column renames (old spec name -> live name).
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'research_bioprospecting_contradictions'
               AND column_name = 'source_fact_id') THEN
    ALTER TABLE public.research_bioprospecting_contradictions
      RENAME COLUMN source_fact_id TO fact_a_id;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'research_bioprospecting_contradictions'
               AND column_name = 'conflicting_fact_id') THEN
    ALTER TABLE public.research_bioprospecting_contradictions
      RENAME COLUMN conflicting_fact_id TO fact_b_id;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'research_bioprospecting_contradictions'
               AND column_name = 'contradiction_type') THEN
    ALTER TABLE public.research_bioprospecting_contradictions
      RENAME COLUMN contradiction_type TO conflict_type;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'research_bioprospecting_contradictions'
               AND column_name = 'evidence_pack') THEN
    ALTER TABLE public.research_bioprospecting_contradictions
      RENAME COLUMN evidence_pack TO metadata;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'research_bioprospecting_contradictions'
               AND column_name = 'resolution_status') THEN
    ALTER TABLE public.research_bioprospecting_contradictions
      RENAME COLUMN resolution_status TO status;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'research_bioprospecting_contradictions'
               AND column_name = 'created_at') THEN
    ALTER TABLE public.research_bioprospecting_contradictions
      RENAME COLUMN created_at TO detected_at;
  END IF;

  -- 2. Columns the backend writes that the original schema never had.
  ALTER TABLE public.research_bioprospecting_contradictions
    ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'medium',
    ADD COLUMN IF NOT EXISTS explanation TEXT,
    ADD COLUMN IF NOT EXISTS resolution_note TEXT,
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open',
    ADD COLUMN IF NOT EXISTS detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

  -- 3. The unresolved state is spelled 'open' on the live DB.
  UPDATE public.research_bioprospecting_contradictions
    SET status = 'open'
    WHERE status = 'unresolved';

  ALTER TABLE public.research_bioprospecting_contradictions
    ALTER COLUMN status SET DEFAULT 'open';

  -- 4. Check constraints (idempotent: only added when absent).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'research_bioprospecting_contradictions_status_check') THEN
    ALTER TABLE public.research_bioprospecting_contradictions
      ADD CONSTRAINT research_bioprospecting_contradictions_status_check
      CHECK (status IN ('open', 'resolved', 'dismissed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'research_bioprospecting_contradictions_severity_check') THEN
    ALTER TABLE public.research_bioprospecting_contradictions
      ADD CONSTRAINT research_bioprospecting_contradictions_severity_check
      CHECK (severity IN ('low', 'medium', 'high'));
  END IF;
END $$;

-- 5. Indexes on the live column names (the 20260610 indexes followed the
--    old names and were carried along by the RENAMEs above; these are the
--    from-scratch safety net).
CREATE INDEX IF NOT EXISTS idx_contradictions_fact_a_id
  ON public.research_bioprospecting_contradictions (fact_a_id);
CREATE INDEX IF NOT EXISTS idx_contradictions_fact_b_id
  ON public.research_bioprospecting_contradictions (fact_b_id);
CREATE INDEX IF NOT EXISTS idx_contradictions_status_col
  ON public.research_bioprospecting_contradictions (status);
CREATE INDEX IF NOT EXISTS idx_contradictions_detected_at
  ON public.research_bioprospecting_contradictions (detected_at DESC);

-- ---------------------------------------------------------------------------
-- PART 1 — Fix `get_contradiction_stats` RPC against the schema above
-- ---------------------------------------------------------------------------
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