/**
 * What the ingestion is doing, right now, in words a person can read.
 *
 * WHY THIS EXISTS
 *
 * Uploading a paper ran the whole pipeline inside one HTTP request: parse the
 * PDF, embed every chunk, an LLM pass for claims, another for bioprospecting
 * facts, then anchoring. Two to five minutes of work behind a gateway that
 * gives up after a hundred seconds.
 *
 * So the upload did not fail. It LIED. The browser was told "Failed to upload
 * paper" while the server quietly finished the job, and the paper appeared in
 * the library anyway — with the user believing it had not. A failure message
 * over a success is worse than either, because it teaches the user to distrust
 * what they are looking at.
 *
 * The upload now returns the moment the file is safe, and the pipeline runs
 * behind it, writing its stage here. The client asks what is happening and says
 * so out loud.
 *
 * And there is a second reason, which is not about the bug at all. One of these
 * stages is "Verifying citations against the PDF". Watching that go by tells
 * the user something no marketing copy can: that this system checks its own
 * work.
 */
import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";

export type IngestStage =
  | "queued"
  | "reading"
  | "indexing"
  | "claims"
  | "facts"
  | "verifying"
  | "done"
  | "failed";

/** Human-readable, in the order they happen. The client renders these. */
export const STAGE_LABELS: Record<IngestStage, string> = {
  queued: "Queued",
  reading: "Reading the PDF",
  indexing: "Indexing the text",
  claims: "Extracting claims",
  facts: "Extracting bioprospecting data",
  verifying: "Verifying citations against the PDF",
  done: "Ready",
  failed: "Failed",
};

/** The pipeline, in order — so the UI can show what is still to come. */
export const STAGE_ORDER: IngestStage[] = [
  "queued",
  "reading",
  "indexing",
  "claims",
  "facts",
  "verifying",
  "done",
];

/**
 * Record the stage. Never throws: a failure to report progress must not take
 * down the work it is reporting on.
 */
export async function setIngestStage(
  sourceId: string,
  stage: IngestStage,
  detail?: string | null,
): Promise<void> {
  if (!sourceId) return;
  try {
    const patch: Record<string, unknown> = {
      ingest_stage: stage,
      ingest_detail: detail ?? null,
    };
    if (stage === "queued") {
      patch.ingest_started_at = new Date().toISOString();
      patch.ingest_finished_at = null;
      patch.ingest_error = null;
    }
    if (stage === "done" || stage === "failed") {
      patch.ingest_finished_at = new Date().toISOString();
    }
    await getServiceClient()
      .from("research_sources")
      .update(patch)
      .eq("id", sourceId);
  } catch (error) {
    logger.warn({ err: error, sourceId, stage }, "ingest_stage_update_failed");
  }
}

export async function setIngestFailed(
  sourceId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (!sourceId) return;
  try {
    await getServiceClient()
      .from("research_sources")
      .update({
        ingest_stage: "failed",
        ingest_error: message,
        ingest_finished_at: new Date().toISOString(),
      })
      .eq("id", sourceId);
  } catch (e) {
    logger.warn({ err: e, sourceId }, "ingest_stage_fail_update_failed");
  }
}
