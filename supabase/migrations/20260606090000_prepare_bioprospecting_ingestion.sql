-- Prepare Research Brain for large corpus ingestion and marine bioprospecting.
-- This keeps the existing evidence-first tables intact and adds:
-- - file identity fields for dedupe/resume on large paper corpora
-- - ingestion run bookkeeping
-- - structured species/compound/activity facts grounded in evidence chunks

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE public.research_sources
  ADD COLUMN IF NOT EXISTS content_hash TEXT,
  ADD COLUMN IF NOT EXISTS file_size BIGINT,
  ADD COLUMN IF NOT EXISTS last_modified_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_research_sources_content_hash_unique
  ON public.research_sources (content_hash)
  WHERE content_hash IS NOT NULL AND content_hash <> '';

CREATE INDEX IF NOT EXISTS idx_research_sources_extraction_status
  ON public.research_sources (extraction_status);

CREATE TABLE IF NOT EXISTS public.research_ingestion_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  docs_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  total_files INTEGER NOT NULL DEFAULT 0,
  processed_files INTEGER NOT NULL DEFAULT 0,
  skipped_files INTEGER NOT NULL DEFAULT 0,
  failed_files INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_research_ingestion_runs_status_started
  ON public.research_ingestion_runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS public.research_bioprospecting_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES public.research_sources(id) ON DELETE CASCADE,
  chunk_id UUID REFERENCES public.research_evidence_chunks(id) ON DELETE SET NULL,
  claim_id UUID REFERENCES public.research_claims(id) ON DELETE SET NULL,

  species TEXT,
  genus TEXT,
  family TEXT,
  higher_taxon TEXT,
  organism_group TEXT,
  geography TEXT,
  ecosystem TEXT,
  organism_part TEXT,

  compound TEXT,
  compound_class TEXT,
  molecule_type TEXT,
  bioactivity TEXT,
  application_area TEXT,
  assay_model TEXT,
  result_summary TEXT,
  evidence_type TEXT,

  relation_type TEXT NOT NULL DEFAULT 'reported_activity',
  status public.research_claim_status NOT NULL DEFAULT 'supported',
  confidence TEXT NOT NULL DEFAULT 'low',
  quote TEXT,
  doi TEXT,
  page INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_source
  ON public.research_bioprospecting_facts (source_id);

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_chunk
  ON public.research_bioprospecting_facts (chunk_id);

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_species
  ON public.research_bioprospecting_facts (lower(species))
  WHERE species IS NOT NULL AND species <> '';

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_genus
  ON public.research_bioprospecting_facts (lower(genus))
  WHERE genus IS NOT NULL AND genus <> '';

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_compound
  ON public.research_bioprospecting_facts (lower(compound))
  WHERE compound IS NOT NULL AND compound <> '';

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_bioactivity
  ON public.research_bioprospecting_facts (lower(bioactivity))
  WHERE bioactivity IS NOT NULL AND bioactivity <> '';

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_application
  ON public.research_bioprospecting_facts (lower(application_area))
  WHERE application_area IS NOT NULL AND application_area <> '';

DROP TRIGGER IF EXISTS trigger_update_research_bioprospecting_updated_at
  ON public.research_bioprospecting_facts;

CREATE TRIGGER trigger_update_research_bioprospecting_updated_at
  BEFORE UPDATE ON public.research_bioprospecting_facts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_research_brain_updated_at();

GRANT ALL ON TABLE public.research_ingestion_runs TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.research_bioprospecting_facts TO anon, authenticated, service_role;
