/**
 * Idempotent seed loader CLI.
 *
 * Usage:
 *   bun run seed:compounds
 *   bun run seed:compounds --dry-run
 *
 * Mirrors `scripts/normalize-taxonomy.ts` in structure. Reads the
 * JSON seed, calls `loadSeedCompounds`, prints a JSON summary.
 */

import "dotenv/config";
import { loadSeedCompounds } from "../../src/services/researchBrain/seedCompounds";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const dryRun = hasFlag("dry-run");
  const summary = await loadSeedCompounds({ dryRun });
  console.log("Compound seed loader completed");
  console.log(JSON.stringify(summary, null, 2));
  if (dryRun) {
    console.log("(dry-run: no rows written)");
  }
}

main().catch((error) => {
  console.error("Compound seed loader failed");
  console.error(error);
  process.exit(1);
});
