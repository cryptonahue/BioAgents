-- Migration: Research evidence tables & figures.
-- PR #1 of bioprospecting-pdf-provenance-viewer.
--
-- Why this migration exists:
--   Persists PDF table and figure extraction output as a source of
--   truth for the bioprospecting prompt-injection step. The
--   research_bioprospecting_facts table gains two nullable FK columns
--   so individual facts can link to a specific extracted table or
--   figure row. Re-extraction is idempotent: the
--   (source_id, page, table_index) unique constraint is the
--   authoritative guard, and PG 23505 collisions are treated as a
--   cache hit by the application.
--
-- The tables are append-only from the extractor; nothing here
-- cascades updates back to the source row, only deletes (via the
-- ON DELETE CASCADE on source_id).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. research_evidence_tables: one row per detected table.
--    `headers` and `rows` are JSONB (string[] and string[][] respectively)
--    so we can carry multi-level header intent without a second table.
--    `bbox` is the union of every cell's geometry in PDF point space
--    (origin bottom-left, units = pt). `markdown` is the rendered
--    pipe-table for the LLM prompt — always populated, even when the
--    structured rows are empty (Mistral markdown-only case).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.research_evidence_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES public.research_sources(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  table_index INTEGER NOT NULL,
  headers JSONB NOT NULL DEFAULT '[]'::jsonb,
  rows JSONB NOT NULL DEFAULT '[]'::jsonb,
  markdown TEXT NOT NULL,
  bbox JSONB NOT NULL,
  extraction_provider TEXT NOT NULL CHECK (extraction_provider IN ('local', 'mistral')),
  extraction_confidence NUMERIC(4,3) NOT NULL CHECK (extraction_confidence >= 0 AND extraction_confidence <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT research_evidence_tables_unique
    UNIQUE (source_id, page, table_index)
);

CREATE INDEX IF NOT EXISTS idx_evidence_tables_source_page
  ON public.research_evidence_tables (source_id, page);

-- ---------------------------------------------------------------------------
-- 2. research_evidence_figures: one row per detected figure.
--    Mirrors the tables table for the figure counterpart. The local
--    provider does not currently detect figures (Mistral does), so
--    this table is sparse in practice but kept symmetric so the
--    provenance-viewer endpoint can query both with the same shape.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.research_evidence_figures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES public.research_sources(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  figure_index INTEGER NOT NULL,
  bbox JSONB NOT NULL,
  caption TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT research_evidence_figures_unique
    UNIQUE (source_id, page, figure_index)
);

CREATE INDEX IF NOT EXISTS idx_evidence_figures_source_page
  ON public.research_evidence_figures (source_id, page);

-- ---------------------------------------------------------------------------
-- 3. Add evidence_table_id and evidence_figure_id FK columns to
--    research_bioprospecting_facts. Both nullable; both SET NULL on
--    parent row delete (so deleting a source or its evidence row
--    preserves the fact but unlinks the bbox reference).
-- ---------------------------------------------------------------------------
ALTER TABLE public.research_bioprospecting_facts
  ADD COLUMN IF NOT EXISTS evidence_table_id UUID
    REFERENCES public.research_evidence_tables(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS evidence_figure_id UUID
    REFERENCES public.research_evidence_figures(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bioprospecting_facts_evidence_table
  ON public.research_bioprospecting_facts (evidence_table_id)
  WHERE evidence_table_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bioprospecting_facts_evidence_figure
  ON public.research_bioprospecting_facts (evidence_figure_id)
  WHERE evidence_figure_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. updated_at triggers (consistent with the rest of the research_brain
--    tables — see 20260601090000_create_research_brain.sql).
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_update_research_evidence_tables_updated_at
  ON public.research_evidence_tables;

-- The tables don't strictly need an updated_at column (they are
-- append-only), but if a future migration adds one, this trigger
-- will start working. The create_research_brain.sql helper function
-- is the standard one used by every research_brain table.

GRANT ALL ON TABLE public.research_evidence_tables
  TO anon, authenticated, service_role;

GRANT ALL ON TABLE public.research_evidence_figures
  TO anon, authenticated, service_role;

COMMIT;
