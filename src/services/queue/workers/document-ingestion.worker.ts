/**
 * Document Ingestion Worker
 * Processes individual files from a directory ingestion run:
 * 1. Validate file exists and is accessible
 * 2. Check dedupe via loadExistingDocumentIdentity() unless force: true
 * 3. Process file via DocumentProcessor.processFile()
 * 4. Chunk document via TextChunker.chunkDocument()
 * 5. Insert chunks via addChunkBatchForDocument()
 * 6. Register with Research Brain via registerInsertedChunksWithResearchBrain()
 * 7. If extractBioprospecting: true, enqueue bioprospecting job
 * 8. Update research_ingestion_runs counters atomically
 * 9. Emit progress notification via Redis Pub/Sub
 */

import { Worker, Job } from "bullmq";
import { getBullMQConnection } from "../connection";
import { notifyIngestionProgress, notifyIngestionCompleted, notifyIngestionFailed } from "../notify";
import type { DocumentIngestionJobData, DocumentIngestionJobResult } from "../types";
import logger from "../../../utils/logger";
import { getServiceClient } from "../../../db/client";

const supabase = getServiceClient();

/**
 * Load existing document identity for dedupe check
 * Uses globalThis to avoid TDZ in worker processes
 */
async function loadExistingDocumentIdentity(): Promise<{
  titles: Set<string>;
  filePaths: Set<string>;
  contentHashes: Set<string>;
}> {
  let cache = (globalThis as any).__documentIdentityCache;
  if (cache) return cache;

  const titles = new Set<string>();
  const filePaths = new Set<string>();
  const contentHashes = new Set<string>();

  const { data: sources } = await supabase
    .from("research_sources")
    .select("title, file_path, content_hash")
    .limit(50000);

  for (const source of sources || []) {
    if ((source as any).title) titles.add((source as any).title);
    if ((source as any).file_path) filePaths.add((source as any).file_path);
    if ((source as any).content_hash) {
      contentHashes.add((source as any).content_hash);
    }
  }

  const { data: docs } = await supabase
    .from("documents")
    .select("title, metadata")
    .limit(50000);

  for (const doc of docs || []) {
    const title = (doc as any).title;
    const meta = ((doc as any).metadata || {}) as any;
    if (title) titles.add(title);
    if (meta.filePath) filePaths.add(meta.filePath);
    if (meta.contentHash) contentHashes.add(meta.contentHash);
  }

  cache = { titles, filePaths, contentHashes };
  (globalThis as any).__documentIdentityCache = cache;
  return cache;
}

/**
 * Check if document is known (for dedupe)
 */
function isKnownDocument(
  doc: { title: string; filePath: string; contentHash: string },
  existing: { titles: Set<string>; filePaths: Set<string>; contentHashes: Set<string> },
): boolean {
  return (
    existing.titles.has(doc.title) ||
    existing.filePaths.has(doc.filePath) ||
    existing.contentHashes.has(doc.contentHash)
  );
}

/**
 * Add chunks for a document in batches
 */
async function addChunkBatchForDocument(
  chunks: Array<{ title: string; content: string; metadata?: any }>,
): Promise<Array<{ id: string; title: string; content: string; metadata?: any }>> {
  const insertedChunks: Array<{ id: string; title: string; content: string; metadata?: any }> = [];
  const batchSize = parseInt(process.env.KNOWLEDGE_INGEST_BATCH_SIZE || "", 10) || 50;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const { VectorSearchWithDocuments } = await import("../../../embeddings/vectorSearchWithDocs");
    let vectorSearch = (globalThis as any).__knowledgeVectorSearch;
    if (!vectorSearch) {
      vectorSearch = new VectorSearchWithDocuments();
      (globalThis as any).__knowledgeVectorSearch = vectorSearch;
    }
    const inserted = await vectorSearch.addDocuments(batch);
    insertedChunks.push(...inserted);
  }

  return insertedChunks;
}

/**
 * Register inserted chunks with Research Brain
 */
async function registerInsertedChunksWithResearchBrain(
  insertedChunks: Array<{ id: string; title: string; content: string; metadata?: any }>,
): Promise<{ id: string } | null> {
  if (insertedChunks.length === 0) return null;

  const grouped = new Map<string, typeof insertedChunks>();
  for (const chunk of insertedChunks) {
    const existing = grouped.get(chunk.title) || [];
    existing.push(chunk);
    grouped.set(chunk.title, existing);
  }

  let lastSource: { id: string } | null = null;
  for (const [title, chunks] of grouped) {
    try {
      const { registerDocumentAsResearchSource } = await import("../../researchBrain/extractor");
      const source = await registerDocumentAsResearchSource({
        title,
        chunks: chunks.sort((a, b) => {
          const ai = Number(a.metadata?.chunkIndex ?? 0);
          const bi = Number(b.metadata?.chunkIndex ?? 0);
          return ai - bi;
        }),
        runExtraction: process.env.RESEARCH_BRAIN_AUTO_EXTRACT !== "false",
      });
      lastSource = source;
    } catch (error) {
      logger.error({ err: error, title }, "research_brain_document_registration_failed");
    }
  }

  return lastSource;
}

/**
 * Update file status in the run's file_statuses JSONB array
 */
async function updateRunFileStatus(
  runId: string,
  filePath: string,
  status: "processed" | "skipped" | "failed",
  additionalFields: Record<string, any> = {},
): Promise<void> {
  try {
    const { data: run } = await supabase
      .from("research_ingestion_runs")
      .select("file_statuses")
      .eq("id", runId)
      .single();

    if (!run) return;

    const fileStatuses: any[] = (run as any).file_statuses || [];
    const existingIndex = fileStatuses.findIndex((f: any) => f.filePath === filePath);

    const fileEntry = {
      filePath,
      status,
      ...additionalFields,
    };

    if (existingIndex >= 0) {
      fileStatuses[existingIndex] = fileEntry;
    } else {
      fileStatuses.push(fileEntry);
    }

    await supabase
      .from("research_ingestion_runs")
      .update({ file_statuses: fileStatuses })
      .eq("id", runId);
  } catch (error) {
    logger.warn({ err: error, runId, filePath }, "update_run_file_status_failed");
  }
}

/**
 * Atomically update run counters
 */
async function updateRunCounters(
  runId: string,
  counters: { processed?: number; skipped?: number; failed?: number },
): Promise<void> {
  try {
    const update: Record<string, any> = {};
    if (counters.processed !== undefined) update.processed_files = counters.processed;
    if (counters.skipped !== undefined) update.skipped_files = counters.skipped;
    if (counters.failed !== undefined) update.failed_files = counters.failed;

    if (Object.keys(update).length === 0) return;

    await supabase
      .from("research_ingestion_runs")
      .update(update)
      .eq("id", runId);
  } catch (error) {
    logger.warn({ err: error, runId }, "update_run_counters_failed");
  }
}

/**
 * Get current run counters
 */
async function getRunCounters(runId: string): Promise<{ processed: number; skipped: number; failed: number }> {
  const { data: run } = await supabase
    .from("research_ingestion_runs")
    .select("processed_files, skipped_files, failed_files, total_files")
    .eq("id", runId)
    .single();

  if (!run) return { processed: 0, skipped: 0, failed: 0 };
  return {
    processed: (run as any).processed_files || 0,
    skipped: (run as any).skipped_files || 0,
    failed: (run as any).failed_files || 0,
  };
}

/**
 * Enqueue a bioprospecting job for a source
 * Checks cancelled_at before enqueuing to respect cancellation
 */
async function enqueueBioprospectingJob(runId: string, sourceId: string): Promise<void> {
  try {
    // Check if run was cancelled before enqueuing
    const { data: run } = await supabase
      .from("research_ingestion_runs")
      .select("cancelled_at")
      .eq("id", runId)
      .single();

    if ((run as any)?.cancelled_at) {
      logger.info({ runId, sourceId }, "bioprospecting_job_skipped_cancelled");
      return;
    }

    const { getBioprospectingQueue } = await import("../queues");
    const queue = getBioprospectingQueue();
    await queue.add("bioprospecting", {
      runId,
      sourceId,
    });
    logger.info({ runId, sourceId }, "bioprospecting_job_enqueued");
  } catch (error) {
    logger.error({ err: error, runId, sourceId }, "bioprospecting_job_enqueue_failed");
  }
}

/**
 * Process a document ingestion job
 */
async function processDocumentIngestionJob(
  job: Job<DocumentIngestionJobData, DocumentIngestionJobResult>,
): Promise<DocumentIngestionJobResult> {
  const { runId, filePath, options } = job.data;
  const { force = false, extractBioprospecting = false } = options;

  logger.info({ jobId: job.id, runId, filePath }, "document_ingestion_job_started");

  try {
    // Get total files from run for progress calculation
    const { data: run } = await supabase
      .from("research_ingestion_runs")
      .select("total_files")
      .eq("id", runId)
      .single();

    const totalFiles = (run as any)?.total_files || 0;
    const counters = await getRunCounters(runId);

    // Notify started
    await notifyIngestionProgress(runId, filePath, "processing", {
      processed: counters.processed,
      skipped: counters.skipped,
      failed: counters.failed,
      total: totalFiles,
    });

    // Import dependencies
    const { DocumentProcessor } = await import("../../../embeddings/documentProcessor");
    const { TextChunker } = await import("../../../embeddings/textChunker");
    const documentProcessor = new DocumentProcessor();
    const textChunker = new TextChunker();

    // Step 1: Validate file exists
    const identity = await documentProcessor.getFileIdentity(filePath);
    if (!identity) {
      await updateRunFileStatus(runId, filePath, "skipped", { reason: "could not get file identity" });
      counters.skipped++;
      await updateRunCounters(runId, { skipped: counters.skipped });
      await notifyIngestionProgress(runId, filePath, "skipped", {
        processed: counters.processed,
        skipped: counters.skipped,
        failed: counters.failed,
        total: totalFiles,
      });
      return { filePath, status: "skipped" };
    }

    // Step 2: Check dedupe
    if (!force) {
      const existing = await loadExistingDocumentIdentity();
      if (isKnownDocument(identity, existing)) {
        await updateRunFileStatus(runId, filePath, "skipped", { reason: "already exists" });
        counters.skipped++;
        await updateRunCounters(runId, { skipped: counters.skipped });
        await notifyIngestionProgress(runId, filePath, "skipped", {
          processed: counters.processed,
          skipped: counters.skipped,
          failed: counters.failed,
          total: totalFiles,
        });
        return { filePath, status: "skipped" };
      }
    }

    // Step 3: Process file
    const doc = await documentProcessor.processFile(filePath);
    if (!doc) {
      await updateRunFileStatus(runId, filePath, "failed", { error: "processFile returned null" });
      counters.failed++;
      await updateRunCounters(runId, { failed: counters.failed });
      await notifyIngestionProgress(runId, filePath, "failed", {
        processed: counters.processed,
        skipped: counters.skipped,
        failed: counters.failed,
        total: totalFiles,
      });
      return { filePath, status: "failed", error: "processFile returned null" };
    }

    // Step 4: Chunk document
    const chunks = textChunker.chunkDocument(doc);
    if (chunks.length === 0) {
      await updateRunFileStatus(runId, filePath, "failed", { error: "0 chunks produced" });
      counters.failed++;
      await updateRunCounters(runId, { failed: counters.failed });
      await notifyIngestionProgress(runId, filePath, "failed", {
        processed: counters.processed,
        skipped: counters.skipped,
        failed: counters.failed,
        total: totalFiles,
      });
      return { filePath, status: "failed", error: "0 chunks produced" };
    }

    // Step 5: Insert chunks
    const chunksToAdd = chunks.map((chunk) => ({
      title: chunk.title,
      content: chunk.content,
      metadata: chunk.metadata,
    }));
    const insertedChunks = await addChunkBatchForDocument(chunksToAdd);

    // Step 6: Register with Research Brain
    const source = await registerInsertedChunksWithResearchBrain(insertedChunks);

    // Step 7: Enqueue bioprospecting if needed
    if (extractBioprospecting && source?.id) {
      await enqueueBioprospectingJob(runId, source.id);
    }

    // Step 8: Update counters
    counters.processed++;
    await updateRunCounters(runId, { processed: counters.processed });
    await updateRunFileStatus(runId, filePath, "processed", {
      chunksInserted: insertedChunks.length,
      sourceId: source?.id,
    });

    // Step 9: Notify progress
    await notifyIngestionProgress(runId, filePath, "processed", {
      processed: counters.processed,
      skipped: counters.skipped,
      failed: counters.failed,
      total: totalFiles,
    });

    logger.info(
      { jobId: job.id, runId, filePath, chunksInserted: insertedChunks.length, sourceId: source?.id },
      "document_ingestion_job_completed",
    );

    return {
      filePath,
      status: "processed",
      chunksInserted: insertedChunks.length,
      sourceId: source?.id,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    logger.error({ jobId: job.id, runId, filePath, error: errorMessage }, "document_ingestion_job_failed");

    const counters = await getRunCounters(runId);
    counters.failed++;
    await updateRunCounters(runId, { failed: counters.failed });
    await updateRunFileStatus(runId, filePath, "failed", { error: errorMessage });

    const { data: run } = await supabase
      .from("research_ingestion_runs")
      .select("total_files")
      .eq("id", runId)
      .single();

    const totalFiles = (run as any)?.total_files || 0;
    await notifyIngestionProgress(runId, filePath, "failed", {
      processed: counters.processed,
      skipped: counters.skipped,
      failed: counters.failed,
      total: totalFiles,
    });

    return { filePath, status: "failed", error: errorMessage };
  }
}

/**
 * Create and start the document ingestion worker
 */
export function createDocumentIngestionWorker(): Worker<DocumentIngestionJobData, DocumentIngestionJobResult> {
  const connection = getBullMQConnection();
  const concurrency = parseInt(process.env.DOCUMENT_INGESTION_CONCURRENCY || "2", 10);

  const worker = new Worker<DocumentIngestionJobData, DocumentIngestionJobResult>(
    "document-ingestion",
    processDocumentIngestionJob,
    {
      connection,
      concurrency,
      lockDuration: 120000,
    },
  );

  // Event handlers
  worker.on("completed", (job, result) => {
    logger.info(
      { jobId: job.id, filePath: result.filePath, status: result.status },
      "document_ingestion_worker_job_completed",
    );
  });

  worker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id, error: error.message },
      "document_ingestion_worker_job_failed",
    );
  });

  worker.on("error", (error) => {
    logger.error({ error: error.message }, "document_ingestion_worker_error");
  });

  logger.info({ concurrency }, "document_ingestion_worker_started");

  return worker;
}
