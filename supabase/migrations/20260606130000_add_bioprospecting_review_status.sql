-- Human review workflow for extracted bioprospecting facts.
-- These fields let reviewers verify, flag, or quarantine facts without losing
-- the original extracted evidence.

ALTER TABLE public.research_bioprospecting_facts
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'unreviewed',
  ADD COLUMN IF NOT EXISTS review_note TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

ALTER TABLE public.research_bioprospecting_facts
  DROP CONSTRAINT IF EXISTS research_bioprospecting_facts_review_status_check;

ALTER TABLE public.research_bioprospecting_facts
  ADD CONSTRAINT research_bioprospecting_facts_review_status_check
  CHECK (
    review_status IN (
      'unreviewed',
      'verified',
      'needs_review',
      'incorrect',
      'quarantined'
    )
  );

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_review_status
  ON public.research_bioprospecting_facts (review_status, reviewed_at DESC);
