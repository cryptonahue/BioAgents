/**
 * Discovery Re-evaluation Worker
 *
 * Drives the periodic "is this discovery still alive?" pass.
 * v1 (this PR) is LLM-free — the verdict is computed from SQL
 * joins against the existing fact and contradiction tables.
 *
 * On each tick (BullMQ repeatable `discovery-reeval` job), the
 * worker calls `runReevalPass`, which:
 *   1. atomically claims the due discovery set
 *      (UPDATE `* -> pending` with a row-locking RETURNING)
 *   2. for each row, counts new supporting facts and contradicting
 *      pairs via SQL
 *   3. computes a verdict (clean / extended / contradicted)
 *   4. writes the verdict on the row and an audit row
 *
 * The worker runs with `concurrency: 1` so the in-process claim
 * is sufficient. v2 (LLM pass) may raise it once contention is
 * understood.
 *
 * Configuration is read once at worker startup via
 * `getDiscoveryReevalConfig()` (which reads
 * `DISCOVERY_REEVAL_ENABLED`, `DISCOVERY_REEVAL_INTERVAL_HOURS`,
 * and `DISCOVERY_REEVAL_BATCH_SIZE` from `process.env`). The
 * env-driven values are stable for the lifetime of the worker.
 *
 * Spawned from `src/worker.ts` alongside the other workers.
 */

import { Worker, Job } from "bullmq";
import { getBullMQConnection } from "../connection";
import type { DiscoveryReevalJobData, DiscoveryReevalJobResult } from "../types";
import logger from "../../../utils/logger";
import {
  runReevalPass,
  getDiscoveryReevalConfig,
} from "../../researchBrain/discoveryReeval";

/**
 * Create and start the discovery-reeval worker. Returns the
 * Worker handle so the caller can wire it into graceful shutdown.
 */
export function createDiscoveryReevalWorker(): Worker<
  DiscoveryReevalJobData,
  DiscoveryReevalJobResult
> {
  const connection = getBullMQConnection();
  // Concurrency is fixed at 1 — the in-process claim
  // (`selectDueDiscoveries`) takes row-level locks via
  // UPDATE...RETURNING, and multiple workers would race for the
  // same set. Override via env for emergency scaling only.
  const concurrency = 1;
  const config = getDiscoveryReevalConfig();

  const worker = new Worker<
    DiscoveryReevalJobData,
    DiscoveryReevalJobResult
  >("discovery-reeval", processDiscoveryReevalJob, {
    connection,
    concurrency,
    // 10 minutes — a single tick can scan up to
    // DISCOVERY_REEVAL_BATCH_SIZE rows, and each row is two
    // count queries + one UPDATE + one INSERT. For 100 rows this
    // is well under a second; the lockDuration is a safety net
    // for a slow Supabase.
    lockDuration: 600_000,
  });

  worker.on("completed", (job, result) => {
    logger.info(
      {
        jobId: job.id,
        result,
      },
      "discovery_reeval_worker_job_completed",
    );
  });

  worker.on("failed", (job, error) => {
    logger.error(
      {
        jobId: job?.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "discovery_reeval_worker_job_failed",
    );
  });

  worker.on("error", (error) => {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "discovery_reeval_worker_error",
    );
  });

  logger.info(
    {
      concurrency,
      enabled: config.enabled,
      intervalHours: config.intervalHours,
      batchSize: config.batchSize,
    },
    "discovery_reeval_worker_started",
  );

  return worker;
}

export async function processDiscoveryReevalJob(
  job: Job<DiscoveryReevalJobData, DiscoveryReevalJobResult>,
): Promise<DiscoveryReevalJobResult> {
  logger.info({ jobId: job.id }, "discovery_reeval_job_started");
  try {
    const summary = await runReevalPass();
    logger.info(
      {
        jobId: job.id,
        scanned: summary.scanned,
        clean: summary.clean,
        extended: summary.extended,
        contradicted: summary.contradicted,
        errors: summary.errors,
        pendingRetained: summary.pendingRetained,
        elapsedMs: summary.elapsed,
      },
      "discovery_reeval_run_summary",
    );
    return {
      scanned: summary.scanned,
      clean: summary.clean,
      extended: summary.extended,
      contradicted: summary.contradicted,
      errors: summary.errors,
      pendingRetained: summary.pendingRetained,
      elapsed: summary.elapsed,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { jobId: job.id, error: message },
      "discovery_reeval_job_failed",
    );
    throw err;
  }
}
