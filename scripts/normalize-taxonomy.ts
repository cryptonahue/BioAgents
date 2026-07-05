import "dotenv/config";
import { normalizeBioprospectingTaxonomy } from "../src/services/researchBrain";

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

async function main() {
  const limit = Number(readArg("limit") || "500");
  const dryRun = hasFlag("dry-run");
  const onlyMissing = !hasFlag("all");
  const useWoRMS = hasFlag("worms");

  const result = await normalizeBioprospectingTaxonomy({
    limit: Number.isFinite(limit) && limit > 0 ? limit : 500,
    dryRun,
    onlyMissing,
    useWoRMS,
  });

  console.log("Taxonomy normalization completed");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Taxonomy normalization failed");
  console.error(error);
  process.exit(1);
});
