/**
 * Bioprospecting Worker
 * Extracts bioprospecting facts from a processed source using LLM analysis.
 * Called after document ingestion completes for a file.
 */

import { Worker, Job } from "bullmq";
import { getBullMQConnection } from "../connection";
import { notifyIngestionProgress, notifyIngestionCompleted, notifyIngestionFailed, notifyRunCancelled } from "../notify";
import type { BioprospectingJobData, ContradictionDetectionJobData } from "../types";
import logger from "../../../utils/logger";
import { getServiceClient } from "../../../db/client";
import { recordLlmCall, calculateCost } from "../../researchBrain/llm-cost";
import { resolveResearchBrainLLM } from "../../researchBrain/llm";

const supabase = getServiceClient();

/**
 * Check if run was cancelled
 */
async function isRunCancelled(runId: string): Promise<boolean> {
  const { data: run } = await supabase
    .from("research_ingestion_runs")
    .select("cancelled_at")
    .eq("id", runId)
    .single();

  return !!(run as any)?.cancelled_at;
}

/**
 * Process a bioprospecting job
 * Shape-based routing: jobs without maxChunks/batchSize are contradiction detection jobs.
 */
async function processBioprospectingJob(
  job: Job<BioprospectingJobData | ContradictionDetectionJobData, any>,
): Promise<any> {
  const { runId, sourceId } = job.data;

  // Shape-based routing: no maxChunks/batchSize means contradiction detection job
  const isContradictionJob =
    job.data.maxChunks === undefined && job.data.batchSize === undefined;

  if (isContradictionJob) {
    return processContradictionDetectionJob(
      job as Job<ContradictionDetectionJobData, any>,
    );
  }

  return processExtractionJob(job as Job<BioprospectingJobData, any>);
}

/**
 * Process a bioprospecting extraction job
 */
async function processExtractionJob(job: Job<BioprospectingJobData, any>): Promise<any> {
  const { runId, sourceId, options } = job.data;

  logger.info({ jobId: job.id, runId, sourceId }, "bioprospecting_job_started");

  // Check if run was cancelled before starting
  if (await isRunCancelled(runId)) {
    logger.info({ jobId: job.id, runId, sourceId }, "bioprospecting_job_skipped_cancelled");
    await notifyRunCancelled(runId);
    return { sourceId, status: "cancelled" };
  }

  const startTime = Date.now();

  try {
    // Extract bioprospecting facts from the source. The `runId` is
    // threaded into the extractor so the cost-cap layer
    // (`pdfTableExtractor` → `MistralTableExtractionProvider` →
    // `costService`) can attribute Mistral OCR / PubChem spend to
    // the right ingestion run.
    //
    // The extractor itself emits a `run:api_call` notification
    // (fire-and-forget) once `ensureTablesForSource` returns, so
    // the WebSocket consumer sees the Mistral / PubChem delta
    // without the worker waiting for a follow-up DB read.
    const { extractBioprospectingFactsForSource } = await import("../../../services/researchBrain");
    await extractBioprospectingFactsForSource(sourceId, { runId });

    // Record LLM cost estimate
    const { providerName, model } = resolveResearchBrainLLM();
    if (providerName && model) {
      const elapsed = Date.now() - startTime;
      // Estimate ~500 tokens input + ~800 tokens output per extraction (typical for this task)
      const inputTokens = 500;
      const outputTokens = 800;
      const { costUsd } = calculateCost(providerName, model, inputTokens, outputTokens);
      await recordLlmCall(runId, {
        provider: providerName,
        model,
        inputTokens,
        outputTokens,
        costUsd,
        latencyMs: elapsed,
        timestamp: new Date().toISOString(),
      });
    }

    // Run contradiction detection after extraction (flag-gated, async)
    if (process.env.BIOPROSPECTING_CONTRADICTION_DETECTION === "true") {
      const { runContradictionDetection } = await import(
        "../../../services/researchBrain"
      );
      await runContradictionDetection({ sourceId, runId });
    }

    logger.info({ jobId: job.id, runId, sourceId }, "bioprospecting_job_completed");

    return { sourceId, status: "completed" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    logger.error({ jobId: job.id, runId, sourceId, error: errorMessage }, "bioprospecting_job_failed");

    return { sourceId, status: "failed", error: errorMessage };
  }
}

/**
 * Process a contradiction detection job (no extraction, only detection)
 */
async function processContradictionDetectionJob(
  job: Job<ContradictionDetectionJobData, any>,
): Promise<any> {
  const { runId, sourceId, options } = job.data;
  const force = options?.force ?? false;

  logger.info(
    { jobId: job.id, runId, sourceId, force },
    "contradiction_detection_job_started",
  );

  try {
    const { runContradictionDetection } = await import("../../../services/researchBrain");
    const result = await runContradictionDetection({ sourceId, runId, options: { force } });

    logger.info({ jobId: job.id, runId, sourceId }, "contradiction_detection_job_completed");

    return { sourceId, status: "completed", ...result };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    logger.error(
      { jobId: job.id, runId, sourceId, error: errorMessage },
      "contradiction_detection_job_failed",
    );

    return { sourceId, status: "failed", error: errorMessage };
  }
}

/**
 * Create and start the bioprospecting worker
 */
export function createBioprospectingWorker(): Worker<BioprospectingJobData | ContradictionDetectionJobData, any> {
  const connection = getBullMQConnection();
  const concurrency = parseInt(process.env.BIOPROSPECTING_CONCURRENCY || "1", 10);

  const worker = new Worker<BioprospectingJobData | ContradictionDetectionJobData, any>(
    "bioprospecting",
    processBioprospectingJob,
    {
      connection,
      concurrency,
      lockDuration: 300000, // 5 minutes for LLM extraction
    },
  );

  // Event handlers
  worker.on("completed", (job, result) => {
    logger.info(
      { jobId: job.id, sourceId: result.sourceId, status: result.status },
      "bioprospecting_worker_job_completed",
    );
  });

  worker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id, error: error.message },
      "bioprospecting_worker_job_failed",
    );
  });

  worker.on("error", (error) => {
    logger.error({ error: error.message }, "bioprospecting_worker_error");
  });

  logger.info({ concurrency }, "bioprospecting_worker_started");

  return worker;
}
