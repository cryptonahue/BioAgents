-- WHEN did we last verify this source's citations?
--
-- Without this column the UI cannot tell two completely different things
-- apart, because both look like a NULL bbox:
--
--   we ran the anchor and the quote is NOT IN THE PAPER  -> a fabrication
--   we never ran the anchor                              -> we do not know
--
-- It shipped conflating them, and a freshly uploaded paper — never anchored —
-- had every one of its claims accused of being invented. A confident verdict
-- about something we never checked: exactly the failure this whole feature
-- exists to prevent, committed by the feature itself.
--
-- NULL here means "not verified yet". It is not an accusation. It is an
-- admission.
ALTER TABLE public.research_sources
  ADD COLUMN IF NOT EXISTS evidence_anchored_at TIMESTAMPTZ;

COMMENT ON COLUMN public.research_sources.evidence_anchored_at IS
  'When the anchor pass last ran. NULL = citations not verified yet (NOT "not found").';
