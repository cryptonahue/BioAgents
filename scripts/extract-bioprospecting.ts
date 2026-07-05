import "dotenv/config";
import {
  extractBioprospectingFactsForSource,
  listBioprospectingSourceCandidates,
} from "../src/services/researchBrain";

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

function setEnvFromArg(argName: string, envName: string) {
  const value = readArg(argName);
  if (value) process.env[envName] = value;
}

async function main() {
  setEnvFromArg("max-chunks", "BIOPROSPECTING_MAX_CHUNKS");
  setEnvFromArg("batch-chunks", "BIOPROSPECTING_BATCH_CHUNKS");
  setEnvFromArg("timeout-ms", "BIOPROSPECTING_BATCH_TIMEOUT_MS");
  setEnvFromArg("retries", "BIOPROSPECTING_BATCH_RETRIES");

  const sourceId = readArg("source-id");
  const status = hasFlag("all") ? "all" : readArg("status") || "pending";
  const limit = Number(readArg("limit") || "10");
  const sourceKind = readArg("source-kind") || "paper";
  const dryRun = hasFlag("dry-run");

  const sources = sourceId
    ? [{ id: sourceId, title: sourceId }]
    : await listBioprospectingSourceCandidates({
        status,
        sourceKind: sourceKind as any,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 10,
      });

  console.log(
    JSON.stringify(
      {
        dryRun,
        sourceCount: sources.length,
        status,
        sourceKind,
        maxChunks: process.env.BIOPROSPECTING_MAX_CHUNKS || "80",
        batchChunks: process.env.BIOPROSPECTING_BATCH_CHUNKS || "8",
        timeoutMs: process.env.BIOPROSPECTING_BATCH_TIMEOUT_MS || "120000",
        retries: process.env.BIOPROSPECTING_BATCH_RETRIES || "1",
        sources: sources.map((source: any) => ({
          id: source.id,
          title: source.title,
          bioprospectingStatus: source.bioprospecting_status,
          factCount: source.bioprospecting_fact_count,
        })),
      },
      null,
      2,
    ),
  );

  if (dryRun) return;

  const results = [];
  for (const source of sources as Array<{ id: string; title?: string }>) {
    console.log(`Extracting ${source.title || source.id}`);
    results.push(await extractBioprospectingFactsForSource(source.id));
  }

  console.log("Bioprospecting extraction completed");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error("Bioprospecting extraction failed");
  console.error(error);
  process.exit(1);
});
