-- Migration: unique natural key on `research_bioprospecting_contradictions`.
--
-- Why (contradiction-detection-fix, PR2):
-- The table has NO unique index, and the writer (`contradictionDb.ts`) did a
-- SELECT-then-INSERT. Two concurrent detections — or the new corpus-wide
-- cross-source sweep re-run against a corpus that has not changed — could
-- therefore duplicate rows and flood the operator review queue. The natural key
-- is (fact_a_id, fact_b_id, conflict_type): that is exactly the triple the
-- writer's existence check already used, so the index encodes a rule the code
-- was already trying (and failing, under races) to enforce.
--
-- With this index in place the writer switches to a real
-- `INSERT ... ON CONFLICT DO UPDATE`, which makes a re-run a DB-level no-op.
--
-- Safety:
--   * Guarded: no-op when the table does not exist (fresh chains where the
--     bioprospecting migrations were skipped).
--   * Idempotent: `IF NOT EXISTS` on the index; re-running is a no-op.
--   * Pre-existing duplicates are collapsed FIRST (keeping the oldest row),
--     otherwise CREATE UNIQUE INDEX would abort. The live table is empty today
--     (the feature flag has always been off), so this is expected to delete
--     nothing — it exists so the migration cannot fail on a database where the
--     flag WAS on.
--   * A resolved/dismissed row always wins over a newer duplicate, because the
--     oldest row is the one an operator would have acted on.

DO $$
BEGIN
  IF to_regclass('public.research_bioprospecting_contradictions') IS NULL THEN
    RETURN;
  END IF;

  -- 1. Collapse duplicates on the natural key, keeping the oldest row
  --    (tie-broken by id, so the survivor is deterministic).
  DELETE FROM public.research_bioprospecting_contradictions AS dup
  USING public.research_bioprospecting_contradictions AS keep
  WHERE dup.fact_a_id = keep.fact_a_id
    AND dup.fact_b_id = keep.fact_b_id
    AND dup.conflict_type = keep.conflict_type
    AND (keep.detected_at, keep.id) < (dup.detected_at, dup.id);

  -- 2. The natural key. Also the ON CONFLICT target PostgREST requires for the
  --    `upsert(..., { onConflict: "fact_a_id,fact_b_id,conflict_type" })` call
  --    in `upsertBioprospectingContradictionRow`.
  EXECUTE $ix$
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_contradictions_fact_pair_type
      ON public.research_bioprospecting_contradictions
      (fact_a_id, fact_b_id, conflict_type)
  $ix$;
END $$;

-- Let PostgREST see the new constraint without a service restart.
NOTIFY pgrst, 'reload schema';
