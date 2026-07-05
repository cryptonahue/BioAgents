/**
 * BullMQ Queue Definitions
 *
 * Defines chat and deep-research queues with retry configuration.
 * These queues are only initialized when USE_JOB_QUEUE=true.
 */

import { Queue } from "bullmq";
import { getBullMQConnection, isJobQueueEnabled } from "./connection";
import type {
  ChatJobData,
  ChatJobResult,
  DeepResearchJobData,
  DeepResearchJobResult,
  FileProcessJobData,
  FileProcessJobResult,
  PaperGenerationJobData,
  PaperGenerationJobResult,
  DocumentIngestionJobData,
  DocumentIngestionJobResult,
  BioprospectingJobData,
  CompoundAuthorityJobData,
  CompoundAuthorityJobResult,
  DiscoveryReevalJobData,
  DiscoveryReevalJobResult,
} from "./types";
import logger from "../../utils/logger";

// Queue instances (lazy initialized)
let chatQueueInstance: Queue<ChatJobData, ChatJobResult> | null = null;
let deepResearchQueueInstance: Queue<DeepResearchJobData, DeepResearchJobResult> | null = null;
let fileProcessQueueInstance: Queue<FileProcessJobData, FileProcessJobResult> | null = null;
let paperGenerationQueueInstance: Queue<PaperGenerationJobData, PaperGenerationJobResult> | null = null;
let documentIngestionQueueInstance: Queue<DocumentIngestionJobData, DocumentIngestionJobResult> | null = null;
let bioprospectingQueueInstance: Queue<BioprospectingJobData, any> | null = null;
let compoundAuthorityQueueInstance: Queue<CompoundAuthorityJobData, CompoundAuthorityJobResult> | null = null;
let discoveryReevalQueueInstance: Queue<DiscoveryReevalJobData, DiscoveryReevalJobResult> | null = null;

/** Sentinel: when true, we already attempted to register the
 * repeatable job for the compound-authority queue in this process.
 * Prevents double-registration when the queue getter is called from
 * multiple sites (e.g. worker.ts and a future /api trigger). */
let compoundAuthorityRepeatRegistered = false;

/** Same sentinel for the discovery-reeval queue. */
let discoveryReevalRepeatRegistered = false;

/**
 * Get or create the chat queue
 * Chat jobs typically complete in 1-2 minutes
 *
 * Retry config:
 * - 3 attempts with exponential backoff (1s → 2s → 4s)
 * - 3 minute timeout (hard limit)
 */
export function getChatQueue(): Queue<ChatJobData, ChatJobResult> {
  if (!isJobQueueEnabled()) {
    throw new Error("Job queue is not enabled. Set USE_JOB_QUEUE=true to use queues.");
  }

  if (!chatQueueInstance) {
    chatQueueInstance = new Queue<ChatJobData, ChatJobResult>("chat", {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        // Retry configuration
        attempts: 3, // Retry up to 3 times on failure
        backoff: {
          type: "exponential", // 1s, 2s, 4s delays
          delay: 1000,
        },
        // Timeout - chat should complete within 3 minutes
        // timeout: 180000, // 3 minutes hard limit - DISABLED for now, using worker lockDuration instead
        // Job cleanup
        removeOnComplete: {
          age: 3600, // Keep completed jobs for 1 hour
          count: 1000,
        },
        removeOnFail: {
          age: 86400, // Keep failed jobs for 24 hours
        },
      },
    });

    logger.info({ queue: "chat" }, "chat_queue_initialized");
  }

  return chatQueueInstance;
}

/**
 * Get or create the deep research queue
 * Deep research jobs can take 20-30+ minutes
 *
 * Retry config:
 * - 2 attempts with exponential backoff (5s → 10s)
 * - No timeout (let it run as long as needed)
 */
export function getDeepResearchQueue(): Queue<DeepResearchJobData, DeepResearchJobResult> {
  if (!isJobQueueEnabled()) {
    throw new Error("Job queue is not enabled. Set USE_JOB_QUEUE=true to use queues.");
  }

  if (!deepResearchQueueInstance) {
    deepResearchQueueInstance = new Queue<DeepResearchJobData, DeepResearchJobResult>("deep-research", {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        // Retry configuration (fewer retries for long jobs)
        attempts: 2, // Retry up to 2 times
        backoff: {
          type: "exponential", // 5s, 10s delays
          delay: 5000,
        },
        // NO TIMEOUT - deep research can take 20-30+ minutes
        // timeout: undefined,
        // Job cleanup
        removeOnComplete: {
          age: 86400, // Keep for 24 hours
          count: 500,
        },
        removeOnFail: {
          age: 604800, // Keep failed for 7 days
        },
      },
    });

    logger.info({ queue: "deep-research" }, "deep_research_queue_initialized");
  }

  return deepResearchQueueInstance;
}

/**
 * Get or create the file process queue
 * File processing jobs typically complete in 10-60 seconds
 *
 * Retry config:
 * - 3 attempts with exponential backoff (1s → 2s → 4s)
 * - 2 minute timeout
 */
export function getFileProcessQueue(): Queue<FileProcessJobData, FileProcessJobResult> | null {
  if (!isJobQueueEnabled()) {
    return null;
  }

  if (!fileProcessQueueInstance) {
    fileProcessQueueInstance = new Queue<FileProcessJobData, FileProcessJobResult>("file-process", {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1000,
        },
        removeOnComplete: {
          age: 3600, // Keep for 1 hour
          count: 500,
        },
        removeOnFail: {
          age: 86400, // Keep failed for 24 hours
        },
      },
    });

    logger.info({ queue: "file-process" }, "file_process_queue_initialized");
  }

  return fileProcessQueueInstance;
}

/**
 * Get or create the paper generation queue
 * Paper generation can take 5-15+ minutes depending on complexity
 *
 * Config:
 * - NO RETRY: Paper gen has internal fallback strategies for LaTeX compilation
 * - NO TIMEOUT: Allow indefinite execution (like deep research)
 */
export function getPaperGenerationQueue(): Queue<PaperGenerationJobData, PaperGenerationJobResult> {
  if (!isJobQueueEnabled()) {
    throw new Error("Job queue is not enabled. Set USE_JOB_QUEUE=true to use queues.");
  }

  if (!paperGenerationQueueInstance) {
    paperGenerationQueueInstance = new Queue<PaperGenerationJobData, PaperGenerationJobResult>("paper-generation", {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        // NO RETRY - paper gen has internal fallback strategies
        attempts: 1,
        // NO TIMEOUT - let it run as long as needed
        // Job cleanup
        removeOnComplete: {
          age: 86400, // Keep for 24 hours
          count: 500,
        },
        removeOnFail: {
          age: 604800, // Keep failed for 7 days
        },
      },
    });

    logger.info({ queue: "paper-generation" }, "paper_generation_queue_initialized");
  }

  return paperGenerationQueueInstance;
}

/**
 * Get or create the document ingestion queue
 * Processes individual files from a directory ingestion run
 *
 * Retry config:
 * - 3 attempts with exponential backoff (1s → 2s → 4s)
 * - 2 minute lock duration
 */
export function getDocumentIngestionQueue(): Queue<DocumentIngestionJobData, DocumentIngestionJobResult> {
  if (!isJobQueueEnabled()) {
    throw new Error("Job queue is not enabled. Set USE_JOB_QUEUE=true to use queues.");
  }

  if (!documentIngestionQueueInstance) {
    documentIngestionQueueInstance = new Queue<DocumentIngestionJobData, DocumentIngestionJobResult>("document-ingestion", {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1000,
        },
        removeOnComplete: {
          age: 3600,
          count: 500,
        },
        removeOnFail: {
          age: 86400,
        },
      },
    });

    logger.info({ queue: "document-ingestion" }, "document_ingestion_queue_initialized");
  }

  return documentIngestionQueueInstance;
}

/**
 * Get or create the bioprospecting queue
 * Extracts bioprospecting facts from processed sources
 *
 * Retry config:
 * - 3 attempts with exponential backoff (1s → 2s → 4s)
 * - No timeout (LLM calls can be slow)
 */
export function getBioprospectingQueue(): Queue<BioprospectingJobData, any> {
  if (!isJobQueueEnabled()) {
    throw new Error("Job queue is not enabled. Set USE_JOB_QUEUE=true to use queues.");
  }

  if (!bioprospectingQueueInstance) {
    bioprospectingQueueInstance = new Queue<BioprospectingJobData, any>("bioprospecting", {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1000,
        },
        removeOnComplete: {
          age: 3600,
          count: 500,
        },
        removeOnFail: {
          age: 86400,
        },
      },
    });

    logger.info({ queue: "bioprospecting" }, "bioprospecting_queue_initialized");
  }

  return bioprospectingQueueInstance;
}

/**
 * Get or create the compound-authority queue.
 *
 * The queue drives a scheduled PubChem backfill pass on the
 * `research_bioprospecting_facts` table. The repeat interval is
 * driven by `COMPOUND_AUTHORITY_INTERVAL_HOURS` (default 6).
 *
 * Disable switches:
 *   - `COMPOUND_AUTHORITY_ENABLED=false` — skip repeat registration
 *     entirely (the queue is still created and queryable, so an admin
 *     can still enqueue a one-shot via Bull Board)
 *   - `COMPOUND_AUTHORITY_INTERVAL_HOURS=0` — same as disabled
 *
 * The queue uses `attempts: 1` because each per-fact retry is
 * handled inside the worker (the `compound_authority_at` re-check
 * window), not by BullMQ's delayed-jobs machinery.
 */
export function getCompoundAuthorityQueue(): Queue<
  CompoundAuthorityJobData,
  CompoundAuthorityJobResult
> {
  if (!isJobQueueEnabled()) {
    throw new Error("Job queue is not enabled. Set USE_JOB_QUEUE=true to use queues.");
  }

  if (!compoundAuthorityQueueInstance) {
    compoundAuthorityQueueInstance = new Queue<
      CompoundAuthorityJobData,
      CompoundAuthorityJobResult
    >("compound-authority", {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        // The worker already handles per-fact retry via the
        // `compound_authority_at` re-check window. We do NOT want
        // BullMQ to retry the whole job on a single bad fact.
        attempts: 1,
        removeOnComplete: {
          age: 3600,
          count: 100,
        },
        removeOnFail: {
          age: 86400,
        },
      },
    });

    logger.info({ queue: "compound-authority" }, "compound_authority_queue_initialized");
  }

  // Idempotent repeat registration: only the first call per process
  // schedules the repeat. Subsequent calls re-use the existing
  // repeatable. Safe across worker.ts / API server restarts because
  // BullMQ persists repeat metadata in Redis.
  if (!compoundAuthorityRepeatRegistered) {
    compoundAuthorityRepeatRegistered = true;
    const enabled = process.env.COMPOUND_AUTHORITY_ENABLED !== "false";
    const intervalHoursRaw = process.env.COMPOUND_AUTHORITY_INTERVAL_HOURS;
    const intervalHours = intervalHoursRaw ? Number(intervalHoursRaw) : 6;
    if (!enabled) {
      logger.info(
        { queue: "compound-authority" },
        "compound_authority_repeat_disabled_by_env",
      );
    } else if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
      logger.info(
        { queue: "compound-authority", intervalHoursRaw },
        "compound_authority_repeat_disabled_zero_interval",
      );
    } else {
      const everyMs = Math.floor(intervalHours * 60 * 60 * 1000);
      // Fire-and-forget: the registration is durable (BullMQ persists
      // it) so we do not block the caller. We log on rejection.
      void compoundAuthorityQueueInstance
        .add(
          "compound-authority-tick",
          {},
          { repeat: { every: everyMs } },
        )
        .then(() => {
          logger.info(
            { queue: "compound-authority", everyMs, intervalHours },
            "compound_authority_repeat_registered",
          );
        })
        .catch((err: unknown) => {
          logger.error(
            { err, queue: "compound-authority", everyMs },
            "compound_authority_repeat_registration_failed",
          );
        });
    }
  }

  return compoundAuthorityQueueInstance;
}

/**
 * Get or create the discovery-reeval queue.
 *
 * The queue drives a scheduled "is this discovery still alive?"
 * pass on the `research_discoveries` table. v1 (this PR) is
 * LLM-free — the verdict (clean / extended / contradicted) is
 * computed from SQL joins. The repeat interval is driven by
 * `DISCOVERY_REEVAL_INTERVAL_HOURS` (default 24).
 *
 * Disable switches (mirrors the compound-authority pattern):
 *   - `DISCOVERY_REEVAL_ENABLED=false` — skip repeat registration
 *     entirely (the queue is still created and queryable, so an
 *     admin can still enqueue a one-shot via Bull Board).
 *   - `DISCOVERY_REEVAL_INTERVAL_HOURS=0` — same as disabled.
 *
 * The queue uses `attempts: 1` because the per-row retry is
 * handled inside the worker (`pendingRetained` summary field).
 * BullMQ does not need to retry the whole job on a single
 * bad row.
 */
export function getDiscoveryReevalQueue(): Queue<
  DiscoveryReevalJobData,
  DiscoveryReevalJobResult
> {
  if (!isJobQueueEnabled()) {
    throw new Error("Job queue is not enabled. Set USE_JOB_QUEUE=true to use queues.");
  }

  if (!discoveryReevalQueueInstance) {
    discoveryReevalQueueInstance = new Queue<
      DiscoveryReevalJobData,
      DiscoveryReevalJobResult
    >("discovery-reeval", {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        // Per-row retry is handled inside the worker. A whole-job
        // retry would re-claim rows that may already be in
        // `pending` (a duplicate of work the previous attempt
        // already did). Same pattern as compound-authority.
        attempts: 1,
        removeOnComplete: {
          age: 3600,
          count: 100,
        },
        removeOnFail: {
          age: 86400,
        },
      },
    });

    logger.info(
      { queue: "discovery-reeval" },
      "discovery_reeval_queue_initialized",
    );
  }

  if (!discoveryReevalRepeatRegistered) {
    discoveryReevalRepeatRegistered = true;
    const enabled = process.env.DISCOVERY_REEVAL_ENABLED !== "false";
    const intervalHoursRaw = process.env.DISCOVERY_REEVAL_INTERVAL_HOURS;
    const intervalHours = intervalHoursRaw ? Number(intervalHoursRaw) : 24;
    if (!enabled) {
      logger.info(
        { queue: "discovery-reeval" },
        "discovery_reeval_repeat_disabled_by_env",
      );
    } else if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
      logger.info(
        { queue: "discovery-reeval", intervalHoursRaw },
        "discovery_reeval_repeat_disabled_zero_interval",
      );
    } else {
      const everyMs = Math.floor(intervalHours * 60 * 60 * 1000);
      void discoveryReevalQueueInstance
        .add(
          "discovery-reeval-tick",
          {},
          { repeat: { every: everyMs } },
        )
        .then(() => {
          logger.info(
            { queue: "discovery-reeval", everyMs, intervalHours },
            "discovery_reeval_repeat_registered",
          );
        })
        .catch((err: unknown) => {
          logger.error(
            { err, queue: "discovery-reeval", everyMs },
            "discovery_reeval_repeat_registration_failed",
          );
        });
    }
  }

  return discoveryReevalQueueInstance;
}

/**
 * Close all queue instances (for graceful shutdown)
 */
export async function closeQueues(): Promise<void> {
  const queues = [
    chatQueueInstance,
    deepResearchQueueInstance,
    fileProcessQueueInstance,
    paperGenerationQueueInstance,
    documentIngestionQueueInstance,
    bioprospectingQueueInstance,
    compoundAuthorityQueueInstance,
    discoveryReevalQueueInstance,
  ];

  await Promise.all(
    queues
      .filter((q): q is Queue => q !== null)
      .map((q) => q.close()),
  );

  chatQueueInstance = null;
  deepResearchQueueInstance = null;
  fileProcessQueueInstance = null;
  paperGenerationQueueInstance = null;
  documentIngestionQueueInstance = null;
  bioprospectingQueueInstance = null;
  compoundAuthorityQueueInstance = null;
  discoveryReevalQueueInstance = null;
  // Note: we do NOT reset `compoundAuthorityRepeatRegistered` or
  // `discoveryReevalRepeatRegistered` here — in a graceful shutdown
  // the process is exiting; if the queue is recreated in the same
  // process, repeat is still durable in Redis and we want a stable
  // "registered once" contract.

  logger.info("queues_closed");
}
