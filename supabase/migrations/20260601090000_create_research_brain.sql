-- Research Brain evidence-first schema.
-- Stores citable sources, evidence chunks, extracted claims, and lightweight graph edges.

CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  CREATE TYPE public.research_source_kind AS ENUM (
    'paper',
    'dataset',
    'external_result',
    'artifact'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.research_trust_tier AS ENUM (
    'internal',
    'external'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.research_claim_status AS ENUM (
    'supported',
    'partial',
    'contradicted',
    'hypothesis',
    'open_question'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.research_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind public.research_source_kind NOT NULL,
  trust_tier public.research_trust_tier NOT NULL DEFAULT 'internal',
  source_scope TEXT NOT NULL DEFAULT 'global',
  title TEXT NOT NULL,
  doi TEXT,
  url TEXT,
  file_path TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'pending_extraction',
  extraction_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_research_sources_doi_unique
  ON public.research_sources (lower(doi))
  WHERE doi IS NOT NULL AND doi <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_research_sources_file_path_unique
  ON public.research_sources (file_path)
  WHERE file_path IS NOT NULL AND file_path <> '';

CREATE INDEX IF NOT EXISTS idx_research_sources_kind_trust
  ON public.research_sources (source_kind, trust_tier);

CREATE TABLE IF NOT EXISTS public.research_evidence_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES public.research_sources(id) ON DELETE CASCADE,
  document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  section TEXT,
  page INTEGER,
  chunk_index INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_research_evidence_source_chunk_unique
  ON public.research_evidence_chunks (source_id, chunk_index)
  WHERE chunk_index IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_research_evidence_source
  ON public.research_evidence_chunks (source_id);

CREATE TABLE IF NOT EXISTS public.research_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim TEXT NOT NULL,
  claim_type TEXT NOT NULL DEFAULT 'finding',
  status public.research_claim_status NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'low',
  source_id UUID REFERENCES public.research_sources(id) ON DELETE CASCADE,
  chunk_id UUID REFERENCES public.research_evidence_chunks(id) ON DELETE SET NULL,
  doi TEXT,
  trust_tier public.research_trust_tier NOT NULL DEFAULT 'internal',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_research_claims_status_trust
  ON public.research_claims (status, trust_tier);

CREATE INDEX IF NOT EXISTS idx_research_claims_source
  ON public.research_claims (source_id);

CREATE INDEX IF NOT EXISTS idx_research_claims_claim_fts
  ON public.research_claims
  USING gin (to_tsvector('english', claim));

CREATE TABLE IF NOT EXISTS public.research_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id UUID NOT NULL,
  from_type TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  to_id UUID NOT NULL,
  to_type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_research_edges_from
  ON public.research_edges (from_id, from_type);

CREATE INDEX IF NOT EXISTS idx_research_edges_to
  ON public.research_edges (to_id, to_type);

CREATE OR REPLACE FUNCTION public.update_research_brain_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_research_sources_updated_at ON public.research_sources;
CREATE TRIGGER trigger_update_research_sources_updated_at
  BEFORE UPDATE ON public.research_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.update_research_brain_updated_at();

DROP TRIGGER IF EXISTS trigger_update_research_claims_updated_at ON public.research_claims;
CREATE TRIGGER trigger_update_research_claims_updated_at
  BEFORE UPDATE ON public.research_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.update_research_brain_updated_at();

GRANT ALL ON TABLE public.research_sources TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.research_evidence_chunks TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.research_claims TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.research_edges TO anon, authenticated, service_role;
