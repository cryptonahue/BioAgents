-- Migration: Scope the identity_key partial unique index to canonical rows.
-- PR 2 of bioprospecting-semantic-dedup. Builds on
-- 20260610060000_bioprospecting_dedup.sql (PR 1).
--
-- Why this migration exists:
--   PR 1 added a partial unique index on
--   research_bioprospecting_facts(identity_key) WHERE identity_key <> '||||'.
--   That index prevents two CANONICAL rows from sharing the same key, but
--   it ALSO blocks the inline-merge scenario where a single extraction run
--   produces K >= 2 facts with the same identity_key: the source-wipe
--   invariant requires all K rows to persist in the table, with K - 1 of
--   them marked as merged siblings. With the strict index, K - 1 sibling
--   inserts fail with 23505 and the invariant breaks.
--
-- Fix: denormalize the canonical -> merged pointer onto the fact row
-- itself as `merged_into_fact_id`, and scope the unique index to rows
-- where merged_into_fact_id IS NULL. Canonical rows (no pointer) must
-- have unique identity keys; merged siblings (pointer set) may share
-- the canonical's key without violating the index.
--
-- The application keeps both the column and the edge table in sync.
-- The edge table remains the authoritative lineage source for the
-- read-only helpers (findMergedFactIds, getDuplicateGroup) and for
-- PR 3's search filter; the column is a denormalization that exists
-- solely to relax the unique index for the inline-merge case.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Add merged_into_fact_id column on research_bioprospecting_facts
--    Nullable FK to self. NULL = canonical or standalone fact; non-NULL =
--    merged sibling pointing at its canonical. Application writes this
--    atomically with the corresponding edge row in
--    research_bioprospecting_fact_edges; the edge table stays the
--    source of truth for lineage queries.
-- ---------------------------------------------------------------------------
ALTER TABLE public.research_bioprospecting_facts
  ADD COLUMN IF NOT EXISTS merged_into_fact_id UUID
  REFERENCES public.research_bioprospecting_facts(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 2. Index for reverse lookups: "which siblings point to this canonical?"
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_bioprospecting_facts_merged_into
  ON public.research_bioprospecting_facts (merged_into_fact_id);

-- ---------------------------------------------------------------------------
-- 3. Replace the strict partial unique index with a canonical-only variant.
--    Rows with merged_into_fact_id IS NULL must have unique identity keys
--    (excluding the all-blank '||||' tuple); rows with merged_into_fact_id
--    IS NOT NULL may share their canonical's key — that's the source-wipe
--    invariant in action.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_bioprospecting_facts_identity_key_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bioprospecting_facts_identity_key_canonical_unique
  ON public.research_bioprospecting_facts (identity_key)
  WHERE identity_key IS NOT NULL
    AND identity_key <> '||||'
    AND merged_into_fact_id IS NULL;

COMMIT;
