-- Migration: Multi-page table merge (chain FK + override table).
-- PR #1 of bioprospecting-multipage-table-merge.
--
-- Why this migration exists:
--   Tables that physically span multiple PDF pages are persisted as N
--   independent rows today; the LLM sees N unrelated `tables:` blocks,
--   the viewer shows N disjoint bboxes with no navigation, and the
--   quality gate counts fragments as separate tables. This migration
--   adds a self-FK on `research_evidence_tables` so a chain of fragments
--   can be linked end-to-end, plus a per-pair override table that lets
--   admins force-merge or force-unmerge a specific pair (regardless of
--   detector score).
--
-- The column is nullable and uses `ON DELETE SET NULL` so the migration
-- is non-blocking on existing rows and deleting a chain head simply
--   unlinks its tail (the tail becomes a fresh chain head, which is
--   the v1 backfill recovery behavior).
--
-- The override table is per-pair only in v1 (YAGNI — per-source mode
-- pin is deferred to v2). The `(table_id, other_table_id)` index makes
-- the detector's pre-merge lookup an O(1) hash probe; the override
-- history is preserved by allowing multiple rows for the same pair
-- (idempotency is enforced at the admin-API layer, not the DB).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Self-FK on research_evidence_tables: chain head is NULL,
--    every tail fragment points to the previous fragment's id.
-- ---------------------------------------------------------------------------
ALTER TABLE public.research_evidence_tables
  ADD COLUMN IF NOT EXISTS continues_from_id UUID
    REFERENCES public.research_evidence_tables(id) ON DELETE SET NULL;

-- Partial index: only the tails are interesting for the chain-walk
-- hot path; the head row (NULL) is the common case and skipping it
-- keeps the index compact.
CREATE INDEX IF NOT EXISTS idx_evidence_tables_chain
  ON public.research_evidence_tables (continues_from_id)
  WHERE continues_from_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Override table: per-pair force_merge / force_unmerge.
--    The detector consults this BEFORE scoreMergeCandidate and respects
--    the action unconditionally. The CHECK on `action` is the only
--    enum gate; idempotency (force_merge re-call returns 200 not 201)
--    is enforced at the admin API layer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.research_evidence_table_merges_override (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES public.research_sources(id) ON DELETE CASCADE,
  table_id UUID NOT NULL REFERENCES public.research_evidence_tables(id) ON DELETE CASCADE,
  other_table_id UUID NOT NULL REFERENCES public.research_evidence_tables(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('force_merge', 'force_unmerge')),
  confidence_score NUMERIC(4,3) CHECK (confidence_score >= 0 AND confidence_score <= 1),
  reason TEXT NOT NULL,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite index on (table_id, other_table_id) makes the detector's
-- per-pair pre-merge lookup an index probe regardless of which side
-- of the pair the FK is anchored to.
CREATE INDEX IF NOT EXISTS idx_evidence_tables_override_pair
  ON public.research_evidence_table_merges_override (table_id, other_table_id);

-- ---------------------------------------------------------------------------
-- 3. Grants (mirror research_evidence_tables — the override table is
--    manipulated by the admin API in PR #3 but read by the detector
--    in PR #1, so both anon and service_role need access now).
-- ---------------------------------------------------------------------------
GRANT ALL ON TABLE public.research_evidence_table_merges_override
  TO anon, authenticated, service_role;

COMMIT;
