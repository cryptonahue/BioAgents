-- Track structured bioprospecting extraction status per source.

ALTER TABLE public.research_sources
  ADD COLUMN IF NOT EXISTS bioprospecting_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS bioprospecting_error TEXT,
  ADD COLUMN IF NOT EXISTS bioprospecting_fact_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bioprospecting_extracted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_research_sources_bioprospecting_status
  ON public.research_sources (bioprospecting_status, created_at DESC);
