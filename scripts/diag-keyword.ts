#!/usr/bin/env bun
/**
 * TEMP diagnostic — is the Anthothela paper findable by keyword search?
 * Queries the `documents` (vector chunk) table directly. Safe, read-only.
 * Delete after use.
 *
 *   bun run scripts/diag-keyword.ts
 */
import { getServiceClient } from "../src/db/client";

const supabase = getServiceClient();

// 1. How many chunks does the Anthothela paper have, and under what title?
const { data: anth, error: e1 } = await supabase
  .from("documents")
  .select("id,title")
  .ilike("title", "%23-00044%");
if (e1) console.error("query 1 error:", e1.message);
const anthTitles = [...new Set((anth ?? []).map((d: any) => d.title))];
console.log(`\n[1] Anthothela (23-00044) chunks in 'documents': ${anth?.length ?? 0}`);
console.log(`    stored under title(s): ${JSON.stringify(anthTitles)}`);

// 2. How many chunks (any paper) contain the word "antifungal"?
const { data: af, error: e2 } = await supabase
  .from("documents")
  .select("id,title")
  .ilike("content", "%antifungal%")
  .limit(500);
if (e2) console.error("query 2 error:", e2.message);
const afByTitle = new Map<string, number>();
for (const d of af ?? []) afByTitle.set((d as any).title, (afByTitle.get((d as any).title) ?? 0) + 1);
console.log(`\n[2] chunks whose CONTENT contains "antifungal": ${af?.length ?? 0}`);
for (const [t, n] of [...afByTitle.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`    ${n.toString().padStart(3)}  ${t}`);

// 3. The exact .or() the keyword search runs — does it return Anthothela?
const { data: kw, error: e3 } = await supabase
  .from("documents")
  .select("id,title")
  .or("content.ilike.%antifungal%,title.ilike.%antifungal%")
  .limit(200);
if (e3) console.error("query 3 (.or ilike %) error:", e3.message);
const kwTitles = [...new Set((kw ?? []).map((d: any) => d.title))];
console.log(`\n[3] .or(content.ilike.%antifungal%) returned ${kw?.length ?? 0} chunks across ${kwTitles.length} papers:`);
for (const t of kwTitles) console.log(`    ${t}`);
console.log(
  `\n>>> Anthothela in the .or() result? ${kwTitles.some((t) => (t ?? "").includes("23-00044")) ? "YES" : "NO"}`,
);

process.exit(0);
