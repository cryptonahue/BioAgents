/**
 * Backfill script for multi-page table chains.
 *
 * Re-runs the `mergeTablesAcrossPages` post-pass against every
 * `research_evidence_tables` source that does NOT already have a
 * chain. The script is idempotent and incremental:
 *
 *   - Sources with ≥1 row where `continues_from_id IS NOT NULL`
 *     are skipped (they already have a chain).
 *   - Dry-run is the default; `--apply` writes the FK patches.
 *   - The merge respects the current `TABLE_MERGE_MODE` env var
 *     (read via the same TDZ-safe resolver the detector uses).
 *
 * Invocation:
 *   bun run merge:tables                    # dry-run, default limit 100
 *   bun run merge:tables:apply              # write the FKs
 *   bun run merge:tables --limit=500        # process up to 500 sources
 *   bun run merge:tables --apply --limit=50 # apply, capped at 50
 *   bun run merge:tables --help             # this message
 *
 * Exit code: 0 on success or on skip-without-error; non-zero on
 * a real failure (per spec §"Backfill is incremental and dry-run
 * by default").
 */

import "dotenv/config";

import { getServiceClient } from "../src/db/client";
import { _resetMergeConfigForTests } from "../src/services/files/providers/localPdfTableProvider";
import { getMergeMode, getMergeThreshold } from "../src/services/files/providers/localPdfTableProvider";
import { mergeTablesAcrossPages, type MergeOverride } from "../src/services/files/providers/localPdfTableProvider";
import {
  collectBackfillPatches,
  isChainPointer,
  type BackfillPatch,
} from "../src/services/files/mergeBackfill";
import type { ExtractedTable } from "../src/services/files/pdfTableExtractor";

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

function printHelp(): void {
  console.log(`merge-multipage-tables - backfill multi-page table chains

USAGE
  bun run merge:tables [options]

OPTIONS
  --apply           Write the FK patches. Default: dry-run (no writes).
  --limit=<n>       Maximum number of candidate sources to process.
                    Default: 100.
  --help            Print this help and exit.

ENV
  TABLE_MERGE_MODE         One of "hard" | "hard-confidence" | "manual".
                           Default: hard-confidence.
  TABLE_MERGE_THRESHOLD    Numeric 0..1. Default: 0.7.
                           Only used by hard-confidence mode.

BEHAVIOR
  - Incremental: sources with at least one chain row
    (continues_from_id IS NOT NULL) are skipped.
  - The merge post-pass runs in-memory on the rows of each
    candidate source; only the resulting continues_from_id
    columns are written to the DB.
  - Synthetic per-batch pointers (<page>-<tableIndex>) emitted
    by the merge are resolved to real head ids before the
    UPDATE.
  - Exit code 0 on success (including "no work to do").
    Non-zero only on a real DB / network error.

SEE ALSO
  docs/STATUS.es.md - "Multi-Page Table Merge" runbook.
`);
}

interface SourceIdRow {
  source_id: string;
}

interface TableRow {
  id: string;
  source_id: string;
  page: number;
  table_index: number;
  continues_from_id: string | null;
}

async function main() {
  if (hasFlag("help")) {
    printHelp();
    process.exit(0);
  }
  const dryRun = !hasFlag("apply");
  const limitArg = Number(readArg("limit") || "100");
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : 100;

  // Force a re-read of the merge config in case the script is
  // run with explicit env overrides (e.g. CI sets
  // TABLE_MERGE_MODE=hard-confidence). The detector's helper
  // memoizes via globalThis; this reset ensures we pick up the
  // current process.env on this script's first call.
  _resetMergeConfigForTests();

  const mode = getMergeMode();
  const threshold = getMergeThreshold();
  console.log(
    `[merge-multipage-tables] mode=${mode} threshold=${threshold} dryRun=${dryRun} limit=${limit}`,
  );

  const sb = getServiceClient();

  // 1. Find candidate source_ids: sources where every row has
  //    continues_from_id IS NULL, AND the source is NOT already
  //    in `(SELECT DISTINCT source_id FROM research_evidence_tables
  //    WHERE continues_from_id IS NOT NULL)`.
  // We do this in two queries (simpler than a single LEFT JOIN with
  // an IS NULL filter, and the per-source pagination in step 2 is
  // explicit):
  //   a) All source_ids that have ≥1 chain already.
  //   b) All source_ids that have ≥1 row (paginated by limit).
  const { data: chainSources, error: chainErr } = await sb
    .from("research_evidence_tables")
    .select("source_id")
    .not("continues_from_id", "is", null);
  if (chainErr) {
    console.error(
      "[merge-multipage-tables] failed to read chain sources",
      chainErr,
    );
    process.exit(1);
  }
  const skip = new Set<string>(
    (chainSources || []).map((r: SourceIdRow) => r.source_id),
  );

  // Paginate via a simple "select distinct source_id where
  // continues_from_id is null" with a PostgREST range/limit. We
  // do it source by source to keep the join semantics explicit
  // and to support the `--limit` cap.
  // We can't select DISTINCT via the supabase-js client, so we
  // select source_id + page and dedupe in memory.
  const { data: candidateRows, error: candErr } = await sb
    .from("research_evidence_tables")
    .select("source_id, page, table_index, id, continues_from_id")
    .is("continues_from_id", null)
    .order("source_id", { ascending: true })
    .order("page", { ascending: true })
    .order("table_index", { ascending: true })
    .limit(limit * 10); // generous upper bound; we cap by source count below
  if (candErr) {
    console.error(
      "[merge-multipage-tables] failed to read candidate rows",
      candErr,
    );
    process.exit(1);
  }

  // 2. Group by source_id, dedupe, drop sources that are in the
  //    skip set, and cap to the limit.
  const bySource = new Map<string, TableRow[]>();
  for (const r of (candidateRows || []) as TableRow[]) {
    if (skip.has(r.source_id)) continue;
    if (!bySource.has(r.source_id)) bySource.set(r.source_id, []);
    bySource.get(r.source_id)!.push(r);
  }
  const sourceIds = [...bySource.keys()].slice(0, limit);

  console.log(
    `[merge-multipage-tables] found ${skip.size} sources with existing chains (skipped), ${bySource.size} candidate sources; processing ${sourceIds.length}.`,
  );

  let totalPatched = 0;
  let totalSourcesProcessed = 0;
  let totalSourcesSkipped = 0;

  for (const sourceId of sourceIds) {
    const rows = bySource.get(sourceId) || [];
    if (rows.length < 2) {
      totalSourcesSkipped++;
      continue;
    }

    // 3. Map DB rows to ExtractedTable (with id and continuesFromId
    //    carried through).
    const tables: ExtractedTable[] = rows.map((r) => ({
      id: r.id,
      page: r.page,
      tableIndex: r.table_index,
      headers: [], // unused by the merge; the detector reads headers
      rows: [],
      bbox: { x: 0, y: 0, w: 0, h: 0, page: r.page, units: "pt" },
      confidence: 0,
      markdown: "",
      continuesFromId: r.continues_from_id ?? null,
    }));

    // The merge post-pass needs the `headers` to apply the
    // `hard` heuristic. The current row shape doesn't expose
    // headers in the select; we read them in a second pass
    // to keep the source-of-truth in the DB.
    const { data: headerRows, error: headerErr } = await sb
      .from("research_evidence_tables")
      .select("id, headers")
      .eq("source_id", sourceId)
      .in(
        "id",
        rows.map((r) => r.id),
      );
    if (headerErr) {
      console.warn(
        `[merge-multipage-tables] failed to read headers for source ${sourceId}`,
        headerErr,
      );
    }
    const headerById = new Map<string, string[]>();
    for (const r of headerRows || []) {
      headerById.set((r as { id: string; headers: string[] }).id, (r as { id: string; headers: string[] }).headers);
    }
    for (const t of tables) {
      if (t.id) t.headers = headerById.get(t.id) || [];
    }

    // 4. Run the merge post-pass.
    const merged = mergeTablesAcrossPages(tables, mode, [] as MergeOverride[], threshold);

    // 5. Collect the patches (id → continues_from_id). The pure
    //    helper in `mergeBackfill.ts` handles synthetic pointer
    //    resolution and pre-INSERT row filtering.
    const patches: BackfillPatch[] = collectBackfillPatches(merged);

    if (patches.length === 0) {
      totalSourcesSkipped++;
      continue;
    }

    totalSourcesProcessed++;

    if (dryRun) {
      console.log(
        JSON.stringify(
          {
            sourceId,
            proposedPatches: patches,
            note: "dry-run; no writes",
          },
          null,
          2,
        ),
      );
      totalPatched += patches.length;
      continue;
    }

    // 6. Apply the patches. Supabase JS doesn't support batched
    //    UPDATE; one round-trip per row. The unique constraint
    //    on (source_id, page, table_index) keeps the rest of the
    //    row stable — we only touch continues_from_id.
    const results = await Promise.allSettled(
      patches.map((p) =>
        sb
          .from("research_evidence_tables")
          .update({ continues_from_id: p.continues_from_id })
          .eq("id", p.id),
      ),
    );
    let success = 0;
    let failed = 0;
    for (const r of results) {
      if (r.status === "fulfilled" && !r.value.error) success++;
      else failed++;
    }
    console.log(
      `[merge-multipage-tables] source=${sourceId} patched=${success} failed=${failed}`,
    );
    totalPatched += success;
  }

  console.log(
    JSON.stringify(
      {
        mode,
        threshold,
        dryRun,
        limit,
        totalSourcesProcessed,
        totalSourcesSkipped,
        totalPatched,
        note: dryRun
          ? "dry-run complete; rerun with --apply to write the FKs"
          : "apply complete",
      },
      null,
      2,
    ),
  );

  // Exit 0 on success (per spec §"Backfill is incremental and
  // dry-run by default" — skipping is not an error).
  process.exit(0);
}

/** Local copy of `isChainPointer` is now imported from
 * `src/services/files/mergeBackfill.ts`. The two copies
 * (detector's local + backfill module) intentionally mirror each
 * other; the detector keeps its own copy per the TDZ note in
 * CLAUDE.md ("module isolation"). */

main().catch((error) => {
  console.error("[merge-multipage-tables] failed");
  console.error(error);
  process.exit(1);
});
