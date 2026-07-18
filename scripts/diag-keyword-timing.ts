#!/usr/bin/env bun
/**
 * TEMP diagnostic — WHERE does the deep-research run spend its time?
 * Isolates the cost of the keyword-search IDF count (exact vs estimated) and
 * times the whole retrieval pipeline. Read-only. Delete after use.
 *
 *   bun run scripts/diag-keyword-timing.ts
 *
 * The per-term exact-vs-estimated comparison is DEPLOY-INDEPENDENT (it hits the
 * DB directly in both modes), so it proves the fix even before deploying it:
 * if exact is slow and estimated is fast, count:"exact" was the stall.
 */
import { getServiceClient } from "../src/db/client";
import { VectorSearchWithDocuments } from "../src/embeddings/vectorSearchWithDocs";

const supabase = getServiceClient();

const time = async (label: string, fn: () => Promise<string>) => {
  const t0 = performance.now();
  let note = "";
  try {
    note = await fn();
  } catch (e: any) {
    note = `ERROR ${e?.message ?? e}`;
  }
  const ms = Math.round(performance.now() - t0);
  console.log(`  ${label.padEnd(34)} ${ms.toString().padStart(7)} ms   ${note}`);
  return ms;
};

// Scale of the table being scanned.
const { count: total } = await supabase
  .from("documents")
  .select("id", { count: "estimated", head: true });
console.log(`\ndocuments table ≈ ${total} rows (estimated)\n`);

// The smoking gun: exact count forces a full ILIKE seq scan; estimated does not.
const TERMS = ["antifungal", "marine", "compounds", "candida", "extracts"];
console.log("=== per-term IDF count cost: exact vs estimated ===");
for (const t of TERMS) {
  const or = `content.ilike.%${t}%,title.ilike.%${t}%`;
  await time(`exact("${t}")`, async () => {
    const { count } = await supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .or(or);
    return `count=${count}`;
  });
  await time(`estimated("${t}")`, async () => {
    const { count } = await supabase
      .from("documents")
      .select("id", { count: "estimated", head: true })
      .or(or);
    return `count=${count}`;
  });
}

// The pipeline as actually called (uses whatever count mode is deployed).
console.log("\n=== full retrieval pipeline (as deployed) ===");
const vs = new VectorSearchWithDocuments();
const Q =
  "What antifungal compounds does my library describe, from which marine source organisms, and what potency was reported?";
await time("keywordSearch(Q, 24)", async () => {
  const r = await (vs as any).keywordSearch(Q, 24);
  return `${r.length} chunks`;
});
await time("vectorSearch(Q, 24)", async () => {
  const r = await vs.vectorSearch(Q, 24);
  return `${r.length} chunks`;
});
await time("search(Q) full hybrid", async () => {
  const r = await vs.search(Q, { vectorLimit: 24, finalLimit: 8 });
  return `${r.length} chunks`;
});

console.log(
  "\n>>> If exact() >> estimated() per term, count:\"exact\" was the stall.",
);
console.log(
  ">>> keywordSearch time before deploy = slow; after deploy (estimated) = fast.\n",
);

process.exit(0);
