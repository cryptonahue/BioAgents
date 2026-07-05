-- Migration: soft-delete columns on research_bioprospecting_fact_edges
--
-- Adds three soft-delete columns so an unmerge is reversible and does
-- not require touching the `identity_key` partial unique index on
-- `research_bioprospecting_facts`.
--
-- The unmerge flow is a soft-delete (`is_active = false`) rather than
-- a hard delete: the row stays, the `merged_fact_id` row in
-- `research_bioprospecting_facts` keeps its `merged_into_fact_id`
-- cache value, and the `identity_key` partial unique index is NOT
-- touched. The previously-merged fact remains eligible to re-merge
-- into a different canonical via the normal inline-merge path.
--
-- Idempotency: `ADD COLUMN IF NOT EXISTS` is safe to re-run; PostgreSQL
-- 11+ also backfills the new `NOT NULL DEFAULT TRUE` column for
-- existing rows in a single pass.
--
-- Spec: openspec/changes/bioprospecting-review-ui/specs/.../spec.md
--       "Soft-Delete Columns on fact_edges"

ALTER TABLE public.research_bioprospecting_fact_edges
  ADD COLUMN IF NOT EXISTS is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS unmerged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unmerged_by TEXT;

-- Partial read index for the lineage helpers (`getDuplicateGroup`,
-- `findMergedFactIds`) and the unmerge CAS guard (`WHERE is_active =
-- true` on the UPDATE). The composite (canonical_fact_id, is_active)
-- shape covers the typical "active edges for a canonical" lookup.
CREATE INDEX IF NOT EXISTS idx_dedup_edge_active_canonical
  ON public.research_bioprospecting_fact_edges (canonical_fact_id, is_active);
