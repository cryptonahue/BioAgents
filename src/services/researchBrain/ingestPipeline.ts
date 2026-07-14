/**
 * Ingest a paper BEHIND the HTTP response, reporting each stage as it goes.
 *
 * The upload used to do all of this inline — parse, embed every chunk, an LLM
 * pass for claims, another for bioprospecting facts, then anchoring — inside a
 * single request. Two to five minutes of work behind a gateway that gives up
 * after a hundred seconds.
 *
 * So the upload did not fail. It LIED: the browser was told "Failed to upload
 * paper" while the server quietly finished the job, and the paper appeared in
 * the library anyway, with the user believing it had not. A failure message
 * over a success is worse than either — it teaches the user to distrust what
 * they are looking at.
 *
 * NO QUEUE IS INVOLVED, deliberately. This deployment runs in-process and has
 * no worker; introducing Redis to fix a progress bar would be a poor trade. The
 * pipeline is simply not awaited, and it writes its stage to the source row as
 * it advances. If the process dies mid-run the row says so, which is more than
 * the old code managed while claiming to have failed.
 */
import path from "node:path";

import logger from "../../utils/logger";
import {
  setIngestFailed,
  setIngestStage,
  STAGE_LABELS,
  STAGE_ORDER,
  type IngestStage,
} from "./ingestStage";
import { getServiceClient } from "../../db/client";

export interface IngestStarted {
  sourceId: string | null;
  title: string;
}

export interface IngestStatus {
  sourceId: string;
  stage: IngestStage;
  label: string;
  detail: string | null;
  error: string | null;
  done: boolean;
  failed: boolean;
  /** 0..1 — how far through the pipeline, for a progress bar. */
  progress: number;
  stages: Array<{ stage: IngestStage; label: string; state: string }>;
}

/**
 * Kick off ingestion and return immediately with the source id the client can
 * watch.
 *
 * The source row is created FIRST, synchronously, so the caller always has
 * something to poll. An upload that returns an id which does not exist yet is
 * an upload the user cannot follow.
 */
export async function runIngestPipeline(
  filePath: string,
  originalName: string,
): Promise<IngestStarted> {
  const title = path.basename(originalName);
  const sb = getServiceClient();

  // Create (or find) the source row up front. `upsertResearchSource` runs
  // inside the pipeline too, and is idempotent on title.
  const { data: existing } = await sb
    .from("research_sources")
    .select("id")
    .eq("title", title)
    .maybeSingle();

  let sourceId: string | null = existing?.id ?? null;
  if (!sourceId) {
    const { data, error } = await sb
      .from("research_sources")
      .insert({ title, file_path: filePath, extraction_status: "pending_extraction" })
      .select("id")
      .single();
    if (error) throw error;
    sourceId = (data as any).id;
  }

  await setIngestStage(sourceId!, "queued", title);

  // Deliberately NOT awaited. The response goes out now; the work continues.
  void ingest(sourceId!, filePath, title).catch(async (error) => {
    logger.error({ err: error, sourceId, filePath }, "ingest_pipeline_failed");
    await setIngestFailed(sourceId!, error);
  });

  return { sourceId, title };
}

async function ingest(
  sourceId: string,
  filePath: string,
  title: string,
): Promise<void> {
  await setIngestStage(sourceId, "reading", title);

  const { VectorSearchWithDocuments } = await import(
    "../../embeddings/vectorSearchWithDocs"
  );
  let vectorSearch = (globalThis as any).__knowledgeVectorSearch;
  if (!vectorSearch) {
    vectorSearch = new VectorSearchWithDocuments();
    (globalThis as any).__knowledgeVectorSearch = vectorSearch;
  }

  // addFile parses, chunks, embeds, registers the source, and (per the env
  // flags) extracts claims, facts, and anchors. The stages it passes through
  // are reported from inside it — see registerDocumentAsResearchSource.
  await setIngestStage(sourceId, "indexing", "Embedding the text");
  const added = await vectorSearch.addFile(filePath);

  await setIngestStage(
    sourceId,
    "done",
    `${added.chunkCount ?? 0} fragments indexed`,
  );
  logger.info(
    { sourceId, title, chunkCount: added.chunkCount },
    "ingest_pipeline_completed",
  );
}

/** Where a paper's ingestion is, in a shape the modal can render directly. */
export async function getIngestStatus(
  sourceId: string,
): Promise<IngestStatus | null> {
  const { data, error } = await getServiceClient()
    .from("research_sources")
    .select("id,ingest_stage,ingest_detail,ingest_error")
    .eq("id", sourceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const stage = ((data as any).ingest_stage ?? "queued") as IngestStage;
  const failed = stage === "failed";
  const done = stage === "done";
  const idx = STAGE_ORDER.indexOf(stage);
  const progress = failed
    ? 0
    : done
      ? 1
      : Math.max(0, idx) / (STAGE_ORDER.length - 1);

  return {
    sourceId,
    stage,
    label: STAGE_LABELS[stage] ?? stage,
    detail: (data as any).ingest_detail ?? null,
    error: (data as any).ingest_error ?? null,
    done,
    failed,
    progress,
    // Every stage, with where we are — so the modal can show what is still to
    // come instead of a spinner that says nothing.
    stages: STAGE_ORDER.filter((s) => s !== "done").map((s) => {
      const i = STAGE_ORDER.indexOf(s);
      return {
        stage: s,
        label: STAGE_LABELS[s],
        state: done || i < idx ? "done" : i === idx ? "active" : "pending",
      };
    }),
  };
}
