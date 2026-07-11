-- Migration: Create bioprospecting contradictions table for tracking fact conflicts
-- Stores detected contradictions between bioprospecting facts from the same extraction run

CREATE TABLE IF NOT EXISTS public.research_bioprospecting_contradictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_a_id UUID NOT NULL REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  fact_b_id UUID NOT NULL REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  conflict_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  explanation TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  resolution_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',

  CONSTRAINT no_self_reference CHECK (
    fact_a_id != fact_b_id
  ),
  CONSTRAINT status_values CHECK (
    status IN ('open', 'resolved', 'dismissed')
  )
);

CREATE INDEX IF NOT EXISTS idx_contradictions_fact_a
  ON public.research_bioprospecting_contradictions (fact_a_id);

CREATE INDEX IF NOT EXISTS idx_contradictions_fact_b
  ON public.research_bioprospecting_contradictions (fact_b_id);

CREATE INDEX IF NOT EXISTS idx_contradictions_type
  ON public.research_bioprospecting_contradictions (conflict_type);

CREATE INDEX IF NOT EXISTS idx_contradictions_status
  ON public.research_bioprospecting_contradictions (status);

GRANT ALL ON TABLE public.research_bioprospecting_contradictions
  TO anon, authenticated, service_role;