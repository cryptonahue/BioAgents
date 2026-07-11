import "dotenv/config";
import { runCrossSourceContradictionDetection } from "../src/services/researchBrain";

/**
 * Corpus-wide (cross-source) contradiction sweep.
 *
 * MANUAL / SCHEDULED on purpose. This is NOT wired into the per-source ingest
 * path: a corpus-wide pass on every ingested paper would be quadratic in the
 * size of the corpus. Run it after an ingestion batch, or on a cron.
 *
 * 100% deterministic — ZERO LLM calls, zero spend. The LLM tier
 * (`BIOPROSPECTING_CONTRADICTION_LLM`) is a different, intra-source code path
 * and stays OFF.
 *
 * Usage:
 *   bun scripts/detect-contradictions.ts --cross-source [--dry-run] [--limit N]
 *                                        [--max-group-size N] [--max-rows N]
 *
 * Requires BIOPROSPECTING_CONTRADICTION_DETECTION=true (same flag as the
 * intra-source tier).
 */

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readPositiveInt(name: string): number | undefined {
  const raw = readArg(name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer (received: ${raw})`);
  }
  return Math.floor(parsed);
}

const USAGE = `Usage: bun scripts/detect-contradictions.ts --cross-source [--dry-run] [--limit N] [--max-group-size N] [--max-rows N]

  --cross-source     Run the corpus-wide sweep (required; the only mode today).
                     Per-source detection runs inside the ingestion worker.
  --dry-run          Group, detect and report — write nothing.
  --limit N          Process at most N cross-source groups.
  --max-group-size N Skip (loudly) any group with more than N facts.
                     Default: BIOPROSPECTING_CONTRADICTION_MAX_GROUP_SIZE or 200.
  --max-rows N       Stop after N contradiction rows this run.
                     Default: BIOPROSPECTING_CONTRADICTION_MAX_ROWS_PER_RUN or 500.
`;

async function main() {
  if (!hasFlag("cross-source")) {
    console.error(USAGE);
    process.exit(1);
  }

  const dryRun = hasFlag("dry-run");
  const limit = readPositiveInt("limit");
  const maxGroupSize = readPositiveInt("max-group-size");
  const maxRowsPerRun = readPositiveInt("max-rows");

  if (process.env.BIOPROSPECTING_CONTRADICTION_DETECTION !== "true") {
    console.error(
      "BIOPROSPECTING_CONTRADICTION_DETECTION is not 'true' — the sweep is a no-op.\n" +
        "Re-run with: BIOPROSPECTING_CONTRADICTION_DETECTION=true bun scripts/detect-contradictions.ts --cross-source",
    );
    process.exit(1);
  }

  const summary = await runCrossSourceContradictionDetection({
    dryRun,
    ...(limit != null ? { limit } : {}),
    ...(maxGroupSize != null ? { maxGroupSize } : {}),
    ...(maxRowsPerRun != null ? { maxRowsPerRun } : {}),
  });

  console.log(
    dryRun
      ? "Cross-source contradiction sweep completed (DRY RUN — nothing written)"
      : "Cross-source contradiction sweep completed",
  );
  console.log(JSON.stringify(summary, null, 2));

  if (summary.groupsSkippedTooLarge > 0) {
    console.warn(
      `WARNING: ${summary.groupsSkippedTooLarge} group(s) exceeded --max-group-size and were SKIPPED (not truncated). See skippedGroups above.`,
    );
  }
  if (summary.truncated) {
    console.warn(
      `WARNING: the run hit --max-rows (${summary.bounds.maxRowsPerRun}). Some conflicts were NOT written. Raise the cap or re-run.`,
    );
  }
}

main().catch((error) => {
  console.error("Cross-source contradiction sweep failed");
  console.error(error);
  process.exit(1);
});
