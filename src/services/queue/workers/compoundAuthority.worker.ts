/**
 * Compound Authority Worker
 *
 * Drives the periodic PubChem backfill. On each tick (BullMQ repeatable
 * `compound-authority` job) it calls
 * `normalizeBioprospectingCompounds`, which:
 *   - re-checks each pending fact against the in-memory alias map
 *   - on miss, calls PubChem at the env-configured rps (gate-enforced)
 *   - writes canonical/alias rows and stamps the fact with
 *     `verified` / `pending` / `failed`
 *
 * The worker runs with `concurrency: 1` so a single in-process gate
 * is sufficient for rate-limiting. BullMQ's built-in limiter is not
 * used — it cannot honor PubChem's per-response `Retry-After` header.
 *
 * Configuration is read once at worker startup via
 * `getCompoundAuthorityConfig()` (which reads
 * `COMPOUND_AUTHORITY_RATE_LIMIT_RPS` and
 * `COMPOUND_AUTHORITY_MAX_RETRIES` from `process.env`). The spec
 * mandates the read-once contract — env vars are NOT re-read
 * mid-cycle.
 *
 * Spawned from `src/worker.ts` alongside the other workers.
 */

import { Worker, Job } from "bullmq";
import { getBullMQConnection } from "../connection";
import type { CompoundAuthorityJobData, CompoundAuthorityJobResult } from "../types";
import logger from "../../../utils/logger";
import {
  normalizeBioprospectingCompounds,
  getCompoundAuthorityConfig,
} from "../../researchBrain/compoundAuthority";
import { isProviderDisabled } from "../../researchBrain/costService";

/**
 * Create and start the compound-authority worker. Returns the
 * Worker handle so the caller can wire it into graceful shutdown.
 */
export function createCompoundAuthorityWorker(): Worker<
  CompoundAuthorityJobData,
  CompoundAuthorityJobResult
> {
  const connection = getBullMQConnection();
  // Concurrency is fixed at 1 — the in-process RateGate enforces the
  // rps cap on PubChem, and multiple workers would defeat the
  // closure-based gate. Override via env for emergency scaling only.
  const concurrency = 1;
  // Read the env-driven config once at worker startup. The
  // spec mandates read-once — mid-cycle re-reads are not allowed.
  const config = getCompoundAuthorityConfig();

  const worker = new Worker<
    CompoundAuthorityJobData,
    CompoundAuthorityJobResult
  >("compound-authority", processCompoundAuthorityJob, {
    connection,
    concurrency,
    lockDuration: 300_000, // 5 minutes — backfill is synchronous and bounded
  });

  worker.on("completed", (job, result) => {
    logger.info(
      {
        jobId: job.id,
        result,
      },
      "compound_authority_worker_job_completed",
    );
  });

  worker.on("failed", (job, error) => {
    logger.error(
      {
        jobId: job?.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "compound_authority_worker_job_failed",
    );
  });

  worker.on("error", (error) => {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "compound_authority_worker_error",
    );
  });

  logger.info(
    { concurrency, rateLimitRps: config.rateLimitRps, maxRetries: config.maxRetries },
    "compound_authority_worker_started",
  );

  return worker;
}

export async function processCompoundAuthorityJob(
  job: Job<CompoundAuthorityJobData, CompoundAuthorityJobResult>,
): Promise<CompoundAuthorityJobResult> {
  logger.info({ jobId: job.id }, "compound_authority_job_started");
  try {
    // Pre-tick day-cap check. PubChem is free, but the daily request
    // cap (PUBCHEM_DAILY_REQUEST_CAP, default 200K) limits the number
    // of API calls per UTC day. When the cap is already exhausted in
    // this process, abort cleanly with `capHit: 'day'` and log
    // `pubchem_disabled_today` so operators can see why this pass
    // skipped facts. The next scheduler tick re-picks the same
    // `pending` facts — the cap will reset at UTC midnight.
    if (isProviderDisabled("pubchem")) {
      logger.warn(
        { event: "pubchem_disabled_today", reason: "cost_cap", jobId: job.id },
        "compound authority worker aborted: pubchem daily cap hit",
      );
      return {
        scannedFacts: 0,
        aliasHits: 0,
        pubchemHits: 0,
        pubchemMisses: 0,
        retriesScheduled: 0,
        failed: 0,
        elapsed: 0,
        capHit: "day",
      };
    }

    // Thread the env-driven config through to the driver. The
    // driver itself falls back to the module-level cached config
    // when params are absent, but we pass them explicitly so the
    // read-once contract is honored at this layer.
    const config = getCompoundAuthorityConfig();
    const summary = await normalizeBioprospectingCompounds({
      rps: config.rateLimitRps,
      maxRetries: config.maxRetries,
    });
    logger.info(
      {
        jobId: job.id,
        scannedFacts: summary.scannedFacts,
        aliasHits: summary.aliasHits,
        pubchemHits: summary.pubchemHits,
        pubchemMisses: summary.pubchemMisses,
        retriesScheduled: summary.retriesScheduled,
        failed: summary.failed,
        elapsedMs: summary.elapsed,
      },
      "compound_authority_run_summary",
    );
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { jobId: job.id, error: message },
      "compound_authority_job_failed",
    );
    throw err;
  }
}
