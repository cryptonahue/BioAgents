-- What is this paper's ingestion actually DOING right now?
--
-- Uploading ran the entire pipeline inside one HTTP request — parse, embed
-- every chunk, an LLM pass for claims, another for bioprospecting facts, then
-- anchoring. Two to five minutes of work behind a gateway that gives up after
-- one hundred seconds.
--
-- So the upload did not fail. It LIED. The browser was told "Failed to upload
-- paper" while the server quietly finished the job, and the paper turned up
-- anyway — with the user believing it had not.
--
-- The upload now returns as soon as the file is safe, and the pipeline runs
-- behind it, writing its stage here. The client asks what is happening and
-- says so. The progress the user wanted is not decoration: it is the mechanism
-- that fixes the bug.
ALTER TABLE public.research_sources
  ADD COLUMN IF NOT EXISTS ingest_stage TEXT,
  ADD COLUMN IF NOT EXISTS ingest_detail TEXT,
  ADD COLUMN IF NOT EXISTS ingest_error TEXT,
  ADD COLUMN IF NOT EXISTS ingest_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ingest_finished_at TIMESTAMPTZ;

COMMENT ON COLUMN public.research_sources.ingest_stage IS
  'queued | reading | indexing | claims | facts | verifying | done | failed';
