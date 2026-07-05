-- Migration: research_bioprospecting_dedup_audit table
--
-- Records every unmerge (and reserved 'merge') event on a bioprospecting
-- fact edge. The table is append-only and mirrors the contract of
-- `compound_authority_audit`: the `event_type` enum stays open for a
-- future change that wants to audit inline merges, but only the
-- unmerge flow writes to this table today.
--
-- Idempotency: every CREATE statement uses IF NOT EXISTS, so re-running
-- this migration against an already-migrated database is a no-op.
--
-- Spec: openspec/changes/bioprospecting-review-ui/specs/.../spec.md
--       "research_bioprospecting_dedup_audit Schema"

CREATE TABLE IF NOT EXISTS public.research_bioprospecting_dedup_audit (
  id                  BIGSERIAL PRIMARY KEY,
  fact_id             UUID NOT NULL
                        REFERENCES public.research_bioprospecting_facts(id)
                        ON DELETE CASCADE,
  event_type          TEXT NOT NULL
                        CHECK (event_type IN ('merge', 'unmerge')),
  old_canonical_id    UUID
                        REFERENCES public.research_bioprospecting_facts(id)
                        ON DELETE SET NULL,
  new_canonical_id    UUID
                        REFERENCES public.research_bioprospecting_facts(id)
                        ON DELETE SET NULL,
  user_id             TEXT,
  reason              TEXT,
  reason_category     TEXT
                        CHECK (reason_category IN (
                          'false_positive',
                          'different_compound',
                          'measurement_error',
                          'other'
                        )),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-fact timeline query: "show me all unmerges of fact X, newest first".
CREATE INDEX IF NOT EXISTS idx_dedup_audit_fact_created
  ON public.research_bioprospecting_dedup_audit (fact_id, created_at DESC);

-- Global timeline query: "show me all unmerges in the last 7 days".
CREATE INDEX IF NOT EXISTS idx_dedup_audit_created
  ON public.research_bioprospecting_dedup_audit (created_at DESC);

-- Filtered category breakdown: "how many false_positive unmerges in
-- the last month?". The partial index keeps the footprint small since
-- `reason_category IS NULL` rows (system-originated) are excluded.
CREATE INDEX IF NOT EXISTS idx_dedup_audit_reason_category
  ON public.research_bioprospecting_dedup_audit (reason_category)
  WHERE reason_category IS NOT NULL;
