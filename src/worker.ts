/**
 * BullMQ Worker Entry Point
 *
 * This is a separate process that runs the chat and deep-research workers.
 * Start with: bun run worker
 *
 * The worker process connects to Redis and processes jobs from the queues.
 * Multiple worker instances can run in parallel for horizontal scaling.
 */

// Must be first - polyfills for pdf-parse/pdfjs-dist
import "./utils/canvas-polyfill";

import { startChatWorker } from "./services/queue/workers/chat.worker";
import { startDeepResearchWorker } from "./services/queue/workers/deep-research.worker";
import { createFileProcessWorker } from "./services/queue/workers/file-process.worker";
import { startPaperGenerationWorker } from "./services/queue/workers/paper-generation.worker";
import { createDocumentIngestionWorker } from "./services/queue/workers/document-ingestion.worker";
import { createBioprospectingWorker } from "./services/queue/workers/bioprospecting.worker";
import { createCompoundAuthorityWorker } from "./services/queue/workers/compoundAuthority.worker";
import { createDiscoveryReevalWorker } from "./services/queue/workers/discoveryReeval.worker";
import { closeConnections } from "./services/queue/connection";
import { startDailyApiUsageGc } from "./services/queue/dailyApiUsageGc";
import { getCompoundAuthorityQueue, getDiscoveryReevalQueue } from "./services/queue/queues";
import logger from "./utils/logger";

async function main() {
  logger.info("Starting BullMQ workers...");

  // Initialize the compound-authority queue on worker boot so the
  // repeatable tick (`compound-authority-tick` every
  // COMPOUND_AUTHORITY_INTERVAL_HOURS) is registered with BullMQ.
  // Without this, the queue is only created on first call from a
  // route handler — which never happens automatically, so the
  // compound-authority worker would silently idle forever.
  //
  // Calling getCompoundAuthorityQueue() is a no-op when
  // COMPOUND_AUTHORITY_ENABLED=false (the function returns a queue
  // instance but skips repeat registration).
  if (process.env.COMPOUND_AUTHORITY_ENABLED !== "false") {
    try {
      const compoundAuthorityQueue = getCompoundAuthorityQueue();
      logger.info(
        { queue: "compound-authority" },
        "compound_authority_queue_initialized_at_worker_boot",
      );
      // Touch the instance so the repeat registration side-effect fires
      // (queues.ts registers the repeat inside getCompoundAuthorityQueue).
      void compoundAuthorityQueue;
    } catch (err) {
      logger.warn(
        { err },
        "compound_authority_queue_init_failed_continuing",
      );
    }
  }

  // Same bootstrap pattern for the discovery-reeval queue.
  // Gated by DISCOVERY_REEVAL_ENABLED (default true). The
  // repeatable interval is DISCOVERY_REEVAL_INTERVAL_HOURS
  // (default 24). Without this call, the queue would only be
  // created lazily on the first trigger (which v1 does not have
  // — the worker is the only entry point), so the worker would
  // idle forever.
  if (process.env.DISCOVERY_REEVAL_ENABLED !== "false") {
    try {
      const discoveryReevalQueue = getDiscoveryReevalQueue();
      logger.info(
        { queue: "discovery-reeval" },
        "discovery_reeval_queue_initialized_at_worker_boot",
      );
      void discoveryReevalQueue;
    } catch (err) {
      logger.warn(
        { err },
        "discovery_reeval_queue_init_failed_continuing",
      );
    }
  }

  // Start workers
  const chatWorker = startChatWorker();
  const deepResearchWorker = startDeepResearchWorker();
  const fileProcessWorker = createFileProcessWorker();
  const paperGenerationWorker = startPaperGenerationWorker();
  const documentIngestionWorker = createDocumentIngestionWorker();
  const bioprospectingWorker = createBioprospectingWorker();
  // Compound-authority worker is gated by COMPOUND_AUTHORITY_ENABLED
  // (default true). When disabled, the worker is NOT created at all
  // — mirrors the queue layer's repeat-skip behavior and satisfies
  // the spec's "the worker does not start" contract.
  const compoundAuthorityEnabled =
    process.env.COMPOUND_AUTHORITY_ENABLED !== "false";
  const compoundAuthorityWorker = compoundAuthorityEnabled
    ? createCompoundAuthorityWorker()
    : null;
  if (!compoundAuthorityEnabled) {
    logger.info(
      { env: "COMPOUND_AUTHORITY_ENABLED=false" },
      "compound_authority_worker_disabled",
    );
  }

  // Discovery-reeval worker is gated by DISCOVERY_REEVAL_ENABLED
  // (default true). When disabled, the worker is NOT created at
  // all — same contract as compound-authority.
  const discoveryReevalEnabled =
    process.env.DISCOVERY_REEVAL_ENABLED !== "false";
  const discoveryReevalWorker = discoveryReevalEnabled
    ? createDiscoveryReevalWorker()
    : null;
  if (!discoveryReevalEnabled) {
    logger.info(
      { env: "DISCOVERY_REEVAL_ENABLED=false" },
      "discovery_reeval_worker_disabled",
    );
  }

  // Nightly GC for the `daily_api_usage` table. The spec mandates a
  // 35-day retention window (2 full 30-day cap windows + 5-day clock
  // skew buffer). Gated by `COST_GUARD_GC_ENABLED` (default true).
  // Failures are logged and NEVER crash the worker — the next tick
  // retries.
  startDailyApiUsageGc();

  logger.info(
    {
      chatConcurrency: process.env.CHAT_QUEUE_CONCURRENCY || 5,
      deepResearchConcurrency: process.env.DEEP_RESEARCH_QUEUE_CONCURRENCY || 3,
      fileProcessConcurrency: process.env.FILE_PROCESS_CONCURRENCY || 5,
      paperGenerationConcurrency: process.env.PAPER_GENERATION_CONCURRENCY || 1,
      documentIngestionConcurrency: process.env.DOCUMENT_INGESTION_CONCURRENCY || 2,
      bioprospectingConcurrency: process.env.BIOPROSPECTING_CONCURRENCY || 1,
      compoundAuthorityConcurrency: 1,
      discoveryReevalConcurrency: 1,
      redisUrl: process.env.REDIS_URL ? "[REDACTED]" : "redis://localhost:6379",
    },
    "workers_started",
  );

  // Graceful shutdown handler
  // Workers will finish their current jobs before stopping
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutdown_signal_received_waiting_for_jobs_to_finish");

    // Close workers - this waits for current jobs to complete
    const closePromises = [
      chatWorker.close().then(() => logger.info("chat_worker_closed")),
      deepResearchWorker.close().then(() => logger.info("deep_research_worker_closed")),
      fileProcessWorker.close().then(() => logger.info("file_process_worker_closed")),
      paperGenerationWorker.close().then(() => logger.info("paper_generation_worker_closed")),
      documentIngestionWorker.close().then(() => logger.info("document_ingestion_worker_closed")),
      bioprospectingWorker.close().then(() => logger.info("bioprospecting_worker_closed")),
    ];
    if (compoundAuthorityWorker) {
      closePromises.push(
        compoundAuthorityWorker
          .close()
          .then(() => logger.info("compound_authority_worker_closed")),
      );
    }
    if (discoveryReevalWorker) {
      closePromises.push(
        discoveryReevalWorker
          .close()
          .then(() => logger.info("discovery_reeval_worker_closed")),
      );
    }

    logger.info("waiting_for_all_workers_to_finish_current_jobs");
    await Promise.all(closePromises);

    logger.info("all_workers_closed_cleaning_up_connections");
    await closeConnections();

    logger.info("graceful_shutdown_complete");
    process.exit(0);
  };

  // Handle shutdown signals
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    logger.error({ error }, "uncaught_exception_in_worker");
    shutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandled_rejection_in_worker");
    // Don't exit on unhandled rejection, just log it
  });
}

// Run the worker
main().catch((error) => {
  logger.error({ error }, "worker_startup_failed");
  process.exit(1);
});
