-- Migration: Create bioprospecting contradictions table for tracking fact conflicts
-- Stores detected contradictions between bioprospecting facts from the same extraction run

CREATE TABLE IF NOT EXISTS public.research_bioprospecting_contradictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES public.research_sources(id) ON DELETE CASCADE,
  source_fact_id UUID REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  conflicting_fact_id UUID REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  contradiction_type TEXT NOT NULL,
  evidence_pack JSONB NOT NULL DEFAULT '{}',
  rule_version TEXT,
  llm_version TEXT,
  resolution_status TEXT NOT NULL DEFAULT 'unresolved',
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT no_self_reference CHECK (
    source_fact_id != conflicting_fact_id
  )
);

CREATE INDEX IF NOT EXISTS idx_contradictions_source
  ON public.research_bioprospecting_contradictions (source_id);

CREATE INDEX IF NOT EXISTS idx_contradictions_fact_a
  ON public.research_bioprospecting_contradictions (source_fact_id);

CREATE INDEX IF NOT EXISTS idx_contradictions_fact_b
  ON public.research_bioprospecting_contradictions (conflicting_fact_id);

CREATE INDEX IF NOT EXISTS idx_contradictions_type
  ON public.research_bioprospecting_contradictions (contradiction_type);

CREATE INDEX IF NOT EXISTS idx_contradictions_status
  ON public.research_bioprospecting_contradictions (resolution_status);

DROP TRIGGER IF EXISTS trigger_update_research_bioprospecting_contradictions_updated_at
  ON public.research_bioprospecting_contradictions;

CREATE TRIGGER trigger_update_research_bioprospecting_contradictions_updated_at
  BEFORE UPDATE ON public.research_bioprospecting_contradictions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_research_brain_updated_at();

GRANT ALL ON TABLE public.research_bioprospecting_contradictions
  TO anon, authenticated, service_role;