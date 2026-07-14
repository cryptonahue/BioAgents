-- Persist WHERE a claim's or a fact's quote actually is in the PDF.
--
-- Until now the location was recomputed in the browser on every click: the
-- viewer scanned the document's text layer looking for the quote, which costs
-- a second on a paper and fifteen on a book, and — being ephemeral — could
-- never be measured. Nobody could ask "how many of this paper's facts can we
-- actually point at?" before a user clicked one and found out.
--
-- Anchoring at ingestion answers that question once, stores the answer, and
-- makes the click instant.
--
-- `anchor_bbox` is the viewer's contract verbatim: PDF points, origin at the
-- TOP-LEFT, y measured DOWNWARD from the page top. NOT the PDF's native
-- bottom-left convention. Storing it any other way has already shipped once
-- and drew every highlight mirrored through the page height.
--
-- NULL is a first-class value here and means "we could not find this text in
-- the PDF". It is an answer, not a gap: the viewer has a `text-only` badge to
-- say it with. Never backfill a NULL with a guess — a box drawn in the wrong
-- place costs the credibility of every box we draw.

ALTER TABLE public.research_claims
  ADD COLUMN IF NOT EXISTS anchor_page INTEGER,
  ADD COLUMN IF NOT EXISTS anchor_bbox JSONB;

ALTER TABLE public.research_bioprospecting_facts
  ADD COLUMN IF NOT EXISTS anchor_page INTEGER,
  ADD COLUMN IF NOT EXISTS anchor_bbox JSONB;

COMMENT ON COLUMN public.research_claims.anchor_page IS
  'Page the claim''s verbatim quote was located on. NULL = not found; degrade to text-only.';
COMMENT ON COLUMN public.research_claims.anchor_bbox IS
  'Bbox of the quote in PDF points, TOP-LEFT origin (y measured down from the page top).';
COMMENT ON COLUMN public.research_bioprospecting_facts.anchor_page IS
  'Page the fact''s verbatim quote was located on. NULL = not found; degrade to text-only.';
COMMENT ON COLUMN public.research_bioprospecting_facts.anchor_bbox IS
  'Bbox of the quote in PDF points, TOP-LEFT origin (y measured down from the page top).';
