-- Structured quantitative fields for bioprospecting facts.
-- These fields let the system compare reported values across papers without
-- parsing free-text result summaries at answer time.

ALTER TABLE public.research_bioprospecting_facts
  ADD COLUMN IF NOT EXISTS measurement_value NUMERIC,
  ADD COLUMN IF NOT EXISTS measurement_unit TEXT,
  ADD COLUMN IF NOT EXISTS measurement_direction TEXT,
  ADD COLUMN IF NOT EXISTS measurement_min NUMERIC,
  ADD COLUMN IF NOT EXISTS measurement_max NUMERIC,
  ADD COLUMN IF NOT EXISTS timepoint TEXT,
  ADD COLUMN IF NOT EXISTS condition TEXT,
  ADD COLUMN IF NOT EXISTS p_value NUMERIC,
  ADD COLUMN IF NOT EXISTS sample_size INTEGER,
  ADD COLUMN IF NOT EXISTS statistical_test TEXT;

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_measurement_value
  ON public.research_bioprospecting_facts (measurement_value)
  WHERE measurement_value IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_measurement_direction
  ON public.research_bioprospecting_facts (lower(measurement_direction))
  WHERE measurement_direction IS NOT NULL AND measurement_direction <> '';

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_condition
  ON public.research_bioprospecting_facts (lower(condition))
  WHERE condition IS NOT NULL AND condition <> '';
