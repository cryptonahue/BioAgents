/**
 * One-time backfill: restore research_claims.chunk_id for claims that were
 * orphaned by the pre-fix re-ingestion bug (chunks replaced -> ON DELETE SET
 * NULL nulled the link). For each orphaned claim we pick the source chunk
 * whose text best overlaps the claim (the claim is an LLM paraphrase of its
 * source chunk), and relink it.
 *
 * Only claims with status supported/partial/contradicted are targeted —
 * hypothesis/open_question claims legitimately have no chunk.
 *
 * DRY RUN by default. Pass --apply to write. Tune the floor with
 * --threshold=0.35 (default) — matches below the floor are left null.
 *
 *   bun run scripts/backfill-claim-chunks.ts            # dry run
 *   bun run scripts/backfill-claim-chunks.ts --apply    # write links
 */
import { getServiceClient } from "../src/db/client";

const APPLY = process.argv.includes("--apply");
const THRESHOLD = Number(
  (process.argv.find((a) => a.startsWith("--threshold=")) || "").split("=")[1] ||
    "0.35",
);

const STOPWORDS = new Set([
  "the","and","for","with","that","this","from","were","was","are","have",
  "has","had","which","their","these","those","been","also","such","into",
  "than","then","they","them","when","what","where","while","being","other",
  "between","during","against","within","using","used","show","shown","showed",
  "study","paper","results","result","found","observed","demonstrated",
]);

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/** Recall of the claim's significant tokens inside a chunk. */
function score(claimTokens: Set<string>, chunkTokens: Set<string>): number {
  if (claimTokens.size === 0) return 0;
  let hit = 0;
  for (const t of claimTokens) if (chunkTokens.has(t)) hit++;
  return hit / claimTokens.size;
}

type Row = { id: string; claim: string; status: string; source_id: string };
type Chunk = { id: string; content: string };

async function main() {
  const sb = getServiceClient();

  const { data: orphans, error } = await sb
    .from("research_claims")
    .select("id, claim, status, source_id")
    .is("chunk_id", null)
    .in("status", ["supported", "partial", "contradicted"]);
  if (error) throw error;

  const rows = (orphans || []) as Row[];
  console.log(
    `mode: ${APPLY ? "APPLY" : "DRY RUN"} | threshold: ${THRESHOLD}`,
  );
  console.log(`orphaned candidate claims: ${rows.length}`);

  // Cache chunks per source.
  const chunkCache = new Map<string, Array<Chunk & { tok: Set<string> }>>();
  async function chunksFor(sourceId: string) {
    let c = chunkCache.get(sourceId);
    if (!c) {
      const { data } = await sb
        .from("research_evidence_chunks")
        .select("id, content")
        .eq("source_id", sourceId);
      c = ((data || []) as Chunk[]).map((ch) => ({
        ...ch,
        tok: tokens(ch.content),
      }));
      chunkCache.set(sourceId, c);
    }
    return c;
  }

  const links: Array<{ claimId: string; chunkId: string; s: number }> = [];
  const buckets = { "<0.35": 0, "0.35-0.5": 0, "0.5-0.7": 0, ">=0.7": 0 };
  const samples: Array<{ claim: string; snippet: string; s: number }> = [];

  for (const row of rows) {
    const chunks = await chunksFor(row.source_id);
    if (chunks.length === 0) continue;
    const ct = tokens(row.claim);
    let best: (Chunk & { tok: Set<string> }) | null = null;
    let bestScore = 0;
    for (const ch of chunks) {
      const s = score(ct, ch.tok);
      if (s > bestScore) {
        bestScore = s;
        best = ch;
      }
    }
    if (bestScore < 0.35) buckets["<0.35"]++;
    else if (bestScore < 0.5) buckets["0.35-0.5"]++;
    else if (bestScore < 0.7) buckets["0.5-0.7"]++;
    else buckets[">=0.7"]++;

    if (best && bestScore >= THRESHOLD) {
      links.push({ claimId: row.id, chunkId: best.id, s: bestScore });
      if (samples.length < 6) {
        samples.push({
          claim: row.claim.slice(0, 90),
          snippet: best.content.slice(0, 90).replace(/\s+/g, " "),
          s: Number(bestScore.toFixed(2)),
        });
      }
    }
  }

  console.log("score buckets:", JSON.stringify(buckets));
  console.log(
    `would link: ${links.length} / ${rows.length} (${(
      (links.length / Math.max(1, rows.length)) *
      100
    ).toFixed(0)}%)`,
  );
  console.log("samples:");
  for (const s of samples) {
    console.log(`  [${s.s}] ${s.claim}`);
    console.log(`         -> ${s.snippet}`);
  }

  if (!APPLY) {
    console.log("\nDRY RUN — no writes. Re-run with --apply to persist.");
    return;
  }

  let done = 0;
  for (const l of links) {
    const { error: upErr } = await sb
      .from("research_claims")
      .update({ chunk_id: l.chunkId })
      .eq("id", l.claimId);
    if (upErr) {
      console.error("update failed for", l.claimId, upErr.message);
      continue;
    }
    done++;
  }
  console.log(`\nAPPLIED: linked ${done} claims.`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
