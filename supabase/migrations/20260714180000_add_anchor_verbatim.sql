-- Was the quote found in the PDF WORD FOR WORD, or only in substance?
--
-- The anchor already records WHERE a quote is. This records how faithful it
-- was, because the two failures are different and the user deserves to know
-- which one they are looking at:
--
--   anchor_bbox IS NOT NULL, anchor_verbatim = true
--       The paper says exactly this. Show it and get out of the way.
--
--   anchor_bbox IS NOT NULL, anchor_verbatim = false
--       The passage is right; the wording is not. The assistant paraphrased.
--       Measured on the corpus: one claim in twelve.
--
--   anchor_bbox IS NULL
--       The quote is NOT IN THE PAPER. The assistant invented it — one fact
--       in twenty-five did — and no other layer of this system can tell.
--       Draw no box, and say so plainly.
--
-- That third state is the whole reason this column exists. A product whose
-- business is evidence must be able to say "my own assistant made this up"
-- before the user finds out on their own.

ALTER TABLE public.research_claims
  ADD COLUMN IF NOT EXISTS anchor_verbatim BOOLEAN;

ALTER TABLE public.research_bioprospecting_facts
  ADD COLUMN IF NOT EXISTS anchor_verbatim BOOLEAN;

COMMENT ON COLUMN public.research_claims.anchor_verbatim IS
  'True when the quote was found word-for-word. False = right passage, paraphrased wording. NULL alongside a NULL bbox = not in the paper at all.';
COMMENT ON COLUMN public.research_bioprospecting_facts.anchor_verbatim IS
  'True when the quote was found word-for-word. False = right passage, paraphrased wording. NULL alongside a NULL bbox = not in the paper at all.';
