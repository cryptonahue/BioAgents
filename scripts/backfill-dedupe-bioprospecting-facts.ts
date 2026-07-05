import "dotenv/config";
import { backfillBioprospectingFactDedup } from "../src/services/researchBrain";

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

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main() {
  const dryRun = hasFlag("dry-run") || !hasFlag("apply");
  const limit = readPositiveInt(readArg("limit"), 500);
  const batchSize = readPositiveInt(readArg("batch-size"), 500);

  const result = await backfillBioprospectingFactDedup({
    limit,
    batchSize,
    dryRun,
  });

  console.log(
    `Bioprospecting fact dedup backfill (${dryRun ? "dry-run" : "apply"}) completed`,
  );
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Bioprospecting fact dedup backfill failed");
  console.error(error);
  process.exit(1);
});
