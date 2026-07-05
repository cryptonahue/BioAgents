-- Local taxonomy/entity normalization for bioprospecting facts.
-- This is intentionally source-agnostic so later WoRMS/GBIF/NCBI identifiers
-- can be attached without changing existing fact records.

CREATE TABLE IF NOT EXISTS public.research_taxa (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rank TEXT NOT NULL CHECK (rank IN ('species', 'genus', 'family', 'higher_taxon')),
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  parent_id UUID REFERENCES public.research_taxa(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'local',
  external_ids JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rank, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_research_taxa_rank_name
  ON public.research_taxa (rank, normalized_name);

CREATE INDEX IF NOT EXISTS idx_research_taxa_parent
  ON public.research_taxa (parent_id);

CREATE TABLE IF NOT EXISTS public.research_taxon_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  taxon_id UUID NOT NULL REFERENCES public.research_taxa(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'local_extraction',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (taxon_id, normalized_alias)
);

CREATE INDEX IF NOT EXISTS idx_research_taxon_aliases_normalized
  ON public.research_taxon_aliases (normalized_alias);

ALTER TABLE public.research_bioprospecting_facts
  ADD COLUMN IF NOT EXISTS species_taxon_id UUID REFERENCES public.research_taxa(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS genus_taxon_id UUID REFERENCES public.research_taxa(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS family_taxon_id UUID REFERENCES public.research_taxa(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_species_taxon
  ON public.research_bioprospecting_facts (species_taxon_id);

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_genus_taxon
  ON public.research_bioprospecting_facts (genus_taxon_id);

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_family_taxon
  ON public.research_bioprospecting_facts (family_taxon_id);

DROP TRIGGER IF EXISTS trigger_update_research_taxa_updated_at
  ON public.research_taxa;

CREATE TRIGGER trigger_update_research_taxa_updated_at
  BEFORE UPDATE ON public.research_taxa
  FOR EACH ROW
  EXECUTE FUNCTION public.update_research_brain_updated_at();

GRANT ALL ON TABLE public.research_taxa TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.research_taxon_aliases TO anon, authenticated, service_role;
