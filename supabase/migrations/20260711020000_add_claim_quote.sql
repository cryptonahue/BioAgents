-- Add a verbatim `quote` column to public.research_claims.
--
-- Claim extraction (src/services/researchBrain/extractor.ts) now asks the LLM
-- for the exact supporting sentence/span from the source chunk. Together with
-- the chunk's newly-populated `page`, this lets the client text-search-highlight
-- the precise sentence on the correct PDF page. Pixel bbox is out of scope.
--
-- Non-destructive + safe to re-run: the column add is guarded with IF NOT
-- EXISTS. Existing rows get NULL (backfill requires re-extraction).

BEGIN;

ALTER TABLE public.research_claims
  ADD COLUMN IF NOT EXISTS quote TEXT;

COMMENT ON COLUMN public.research_claims.quote IS
  'Verbatim sentence/span from the linked evidence chunk that supports the claim. Used by the client to text-search-highlight the exact source text on the PDF page. NULL for claims extracted before this column existed (re-run extraction to backfill).';

COMMIT;
