#!/usr/bin/env bun
/**
 * TEMP diagnostic — WHERE in the hybrid pipeline does the Anthothela paper drop?
 * Runs the real vector / keyword / full-search stages and prints which papers
 * each returns. Read-only. Delete after use.
 *
 * Needs the `%` keyword fix deployed (commit 2898c6e).
 *
 *   bun run scripts/diag-keyword.ts
 */
import { VectorSearchWithDocuments } from "../src/embeddings/vectorSearchWithDocs";

const vs = new VectorSearchWithDocuments();
const Q =
  "What antifungal compounds or extracts from marine organisms does my library describe, from which source organisms, and what activity or potency was reported?";

const titles = (arr: any[]) => [...new Set(arr.map((d) => d.title))];
const hasAnth = (arr: any[]) =>
  arr.some((d) => (d.title ?? "").includes("23-00044"));

console.log(`\nQUERY: ${Q}\n`);

const vec = await vs.vectorSearch(Q, 24);
console.log(`[VECTOR]  ${vec.length} chunks · Anthothela? ${hasAnth(vec) ? "YES" : "NO"}`);
titles(vec).forEach((t) => console.log(`    ${t}`));

const kw = await (vs as any).keywordSearch(Q, 24);
console.log(`\n[KEYWORD] ${kw.length} chunks · Anthothela? ${hasAnth(kw) ? "YES" : "NO"}`);
titles(kw).forEach((t) => console.log(`    ${t}`));

const fin = await vs.search(Q, { vectorLimit: 24, finalLimit: 8 });
console.log(`\n[FINAL]   ${fin.length} chunks · Anthothela? ${hasAnth(fin) ? "YES" : "NO"}`);
titles(fin).forEach((t) => console.log(`    ${t}`));

console.log(
  `\n>>> DROP POINT: ${
    hasAnth(fin)
      ? "none — it survives (was a deploy/other issue)"
      : hasAnth(kw)
        ? "AFTER keyword — the RRF/reranker/finalLimit cuts it"
        : "keyword itself does not return it (ranking/limit in keywordSearch)"
  }`,
);

process.exit(0);
