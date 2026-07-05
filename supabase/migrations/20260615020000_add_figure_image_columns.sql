-- 20260615020000_add_figure_image_columns.sql
-- Adds 5 nullable columns to research_evidence_figures so the figure-image-
-- extraction pipeline (figure-image-extraction change, PR #1) can persist
-- extracted image bytes alongside the existing bbox + caption row.
--
-- All 5 columns are nullable: existing rows keep NULL on all five, and the
-- viewer degrades to bbox-only (pre-change behavior) for any row whose
-- storage_path is null. The 5 new columns are purely additive — no other
-- column or constraint on research_evidence_figures is touched.

BEGIN;

ALTER TABLE public.research_evidence_figures
  ADD COLUMN IF NOT EXISTS storage_path TEXT,
  ADD COLUMN IF NOT EXISTS mime_type    TEXT,
  ADD COLUMN IF NOT EXISTS width        INT,
  ADD COLUMN IF NOT EXISTS height       INT,
  ADD COLUMN IF NOT EXISTS byte_size    BIGINT;

COMMENT ON COLUMN public.research_evidence_figures.storage_path IS
  'S3 object key: figures/{sourceId}/{figureIndex}.{format}. NULL = bbox-only (no image extracted).';
COMMENT ON COLUMN public.research_evidence_figures.mime_type IS
  'IANA MIME type for the extracted image (image/png or image/jpeg). Drives proxy Content-Type.';
COMMENT ON COLUMN public.research_evidence_figures.width IS
  'Pixel width of the encoded image (PNG width tag).';
COMMENT ON COLUMN public.research_evidence_figures.height IS
  'Pixel height of the encoded image (PNG height tag).';
COMMENT ON COLUMN public.research_evidence_figures.byte_size IS
  'Total bytes of the encoded image (= length of the S3 object). NULL = bbox-only.';

-- Grants: mirror the table's existing grants. The service_role
-- writes the columns; anon and authenticated read them through
-- the existing /api/research-brain/sources/:id/evidence route.
GRANT SELECT, INSERT, UPDATE ON public.research_evidence_figures TO anon;
GRANT SELECT, INSERT, UPDATE ON public.research_evidence_figures TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.research_evidence_figures TO service_role;

COMMIT;
