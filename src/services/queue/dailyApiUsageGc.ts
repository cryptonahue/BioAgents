/**
 * Nightly GC for `daily_api_usage`
 * (api-cost-guard-rails PR #3, task 3.16).
 *
 * The 35-day retention window preserves two full 30-day cap windows
 * plus a 5-day buffer for clock skew. The spec lists `pg_cron` and a
 * Bun `setInterval` as both valid; we use the `setInterval`
 * approach so the GC is colocated with the worker process and
 * reads no extra infra.
 *
 * Behavior:
 *  - Gated by `COST_GUARD_GC_ENABLED` (default true). Set
 *    `COST_GUARD_GC_ENABLED=false` to disable in environments where
 *    `pg_cron` is doing the same job.
 *  - The single `tick()` function is exported so unit tests can
 *    drive it deterministically. `start()` schedules the
 *    setInterval/setTimeout.
 *  - A failure logs `cost_guard_gc_failed` and the worker keeps
 *    running — the next tick will retry.
 *
 * Returns the `setInterval` and `setTimeout` handles so tests can
 * clean them up. The interval is `unref`-ed so it does NOT keep the
 * process alive on shutdown.
 */

import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const GC_INITIAL_DELAY_MS = 30_000;
const GC_RETENTION_DAYS = 35;

export interface GcTickResult {
  cutoff: string;
  deletedRows: number;
}

/**
 * One GC pass: delete every `daily_api_usage` row whose `day` is
 * strictly older than 35 days from today. Returns the cutoff and
 * row count for assertions. Throws are logged and swallowed so the
 * worker never crashes on a DB blip.
 */
export async function tickDailyApiUsageGc(): Promise<GcTickResult> {
  const cutoff = new Date(Date.now() - GC_RETENTION_DAYS * ONE_DAY_MS)
    .toISOString()
    .slice(0, 10);
  try {
    const supabase = getServiceClient();
    const { error, count } = await supabase
      .from("daily_api_usage")
      .delete({ count: "exact" })
      .lt("day", cutoff);
    if (error) throw error;
    const deletedRows = typeof count === "number" ? count : 0;
    logger.info(
      { event: "cost_guard_gc_completed", cutoff, deletedRows },
      "daily_api_usage GC run completed",
    );
    return { cutoff, deletedRows };
  } catch (err) {
    logger.error(
      { err, event: "cost_guard_gc_failed" },
      "daily_api_usage GC run failed; will retry on next tick",
    );
    // Re-throw so tests can assert the error path. Production
    // callers (`startDailyApiUsageGc`) catch and swallow.
    throw err;
  }
}

export interface DailyApiUsageGcHandles {
  initialTimeout: ReturnType<typeof setTimeout>;
  interval: ReturnType<typeof setInterval>;
}

/**
 * Schedule the nightly GC: one tick `GC_INITIAL_DELAY_MS` from
 * now, then every 24h. Returns the handles so tests can call
 * `clearInterval` / `clearTimeout`. Returns `null` when the GC is
 * disabled via `COST_GUARD_GC_ENABLED=false`.
 */
export function startDailyApiUsageGc(): DailyApiUsageGcHandles | null {
  if (process.env.COST_GUARD_GC_ENABLED === "false") {
    logger.info(
      { env: "COST_GUARD_GC_ENABLED=false" },
      "cost_guard_gc_disabled",
    );
    return null;
  }

  const initialTimeout = setTimeout(() => {
    // Swallow — never crash the worker on a GC blip.
    void tickDailyApiUsageGc().catch(() => undefined);
  }, GC_INITIAL_DELAY_MS);

  const interval = setInterval(() => {
    void tickDailyApiUsageGc().catch(() => undefined);
  }, ONE_DAY_MS);
  if (typeof interval.unref === "function") {
    interval.unref();
  }
  if (typeof initialTimeout.unref === "function") {
    initialTimeout.unref();
  }

  return { initialTimeout, interval };
}

// Test-only re-exports for the constants the spec mentions.
export const DAILY_API_USAGE_GC_CONSTANTS = {
  ONE_DAY_MS,
  GC_INITIAL_DELAY_MS,
  GC_RETENTION_DAYS,
} as const;
