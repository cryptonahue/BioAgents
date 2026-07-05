-- Backfill source bioprospecting status from already extracted facts.

WITH fact_counts AS (
  SELECT
    source_id,
    COUNT(*)::INTEGER AS fact_count,
    MAX(created_at) AS extracted_at
  FROM public.research_bioprospecting_facts
  WHERE source_id IS NOT NULL
  GROUP BY source_id
)
UPDATE public.research_sources AS sources
SET
  bioprospecting_status = 'extracted',
  bioprospecting_fact_count = fact_counts.fact_count,
  bioprospecting_extracted_at = fact_counts.extracted_at,
  bioprospecting_error = NULL
FROM fact_counts
WHERE sources.id = fact_counts.source_id;
