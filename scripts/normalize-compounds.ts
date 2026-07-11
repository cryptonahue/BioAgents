import "dotenv/config";
import { normalizeBioprospectingCompounds } from "../src/services/researchBrain";

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
  const limit = Number(readArg("limit") || "50");
  const dryRun = hasFlag("dry-run");
  const onlyMissing = !hasFlag("all");

  // Recovery-pass opt-in flags. When none are passed the CLI
  // reproduces today's behavior exactly (original-name-only lookup,
  // `pending`-only candidate set, no attempts reset, never promote).
  const includeFailed = hasFlag("include-failed");
  const tryFuzzyVariants = hasFlag("try-fuzzy-variants");
  const acceptLocal = hasFlag("accept-local");
  const maxVariants = Number(readArg("max-variants") || "3");

  const result = await normalizeBioprospectingCompounds({
    limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
    dryRun,
    onlyMissing,
    includeFailed,
    tryFuzzyVariants,
    maxVariantsPerFact:
      Number.isFinite(maxVariants) && maxVariants >= 0 ? maxVariants : 3,
    // Only takes effect when the env master-arm
    // COMPOUND_AUTHORITY_ACCEPT_LOCAL=true is also set; the driver
    // resolves the two-gate flag internally.
    promoteLocalOnMiss: acceptLocal,
  });

  console.log("Compound normalization completed");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Compound normalization failed");
  console.error(error);
  process.exit(1);
});
