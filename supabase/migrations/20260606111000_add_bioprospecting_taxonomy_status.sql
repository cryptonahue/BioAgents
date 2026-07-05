-- Track taxonomy normalization per bioprospecting fact so large backfills can
-- resume without repeatedly scanning records that have no taxonomic fields.

ALTER TABLE public.research_bioprospecting_facts
  ADD COLUMN IF NOT EXISTS taxonomy_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS taxonomy_normalized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS taxonomy_error TEXT;

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_taxonomy_status
  ON public.research_bioprospecting_facts (taxonomy_status, created_at);
