-- Add file_statuses JSONB column for per-file tracking in ingestion runs
-- This enables real-time progress updates and per-file status reporting

ALTER TABLE public.research_ingestion_runs
  ADD COLUMN IF NOT EXISTS file_statuses JSONB NOT NULL DEFAULT '[]';

-- Index for efficient status queries
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_status ON public.research_ingestion_runs (status);

COMMENT ON COLUMN public.research_ingestion_runs.file_statuses IS E'Array of per-file status objects: [{"filePath": "/path/to/file.pdf", "status": "processed", "chunksInserted": 12, "sourceId": "uuid"}, {"filePath": "/path/to/other.pdf", "status": "failed", "error": "PDF parse error", "attempts": 3}]';
