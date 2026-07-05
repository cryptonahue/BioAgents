/**
 * Admin API for the `research_evidence_table_merges_override` table
 * (PR #3 of `bioprospecting-multipage-table-merge`).
 *
 * Three routes, all guarded by `authResolver({ required: true, role: "admin" })`:
 *
 *   1. POST   /api/research-brain/tables/:tableId/merge-with/:otherTableId
 *        Body: { reason: string, confidence_score?: number }
 *        Writes a `force_merge` override row + sets `continues_from_id`
 *        on the tail fragment. Idempotent: a second call with the
 *        same pair returns 200 with the existing row instead of
 *        inserting a duplicate.
 *
 *   2. DELETE /api/research-brain/tables/:tableId/merge-override
 *        Removes every override row involving the table and clears
 *        the FK on the chain tail. Returns { removed: number }.
 *
 *   3. GET    /api/research-brain/tables/:tableId/merges
 *        Returns ranked merge candidates for the source (scored by
 *        `scoreMergeCandidate` against adjacent tables within ±5
 *        pages, with any matching override row merged in).
 *
 * The override table takes precedence over the detector per
 * design §"Per-pair override always wins over detector". Admin
 * overrides are the human-in-the-loop escape hatch for detector
 * false positives / false negatives.
 */

import { Elysia } from "elysia";
import { authResolver } from "../../middleware/authResolver";
import { getServiceClient } from "../../db/client";
import { scoreMergeCandidate } from "../../services/files/providers/localPdfTableProvider";
import type { ExtractedTable } from "../../services/files/pdfTableExtractor";
import logger from "../../utils/logger";

/** Clamp a numeric input to the [0, 1] interval. Out-of-range
 * values are coerced to the nearest bound; NaN → undefined so the
 * DB stores NULL. */
function clampConfidence(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Lightweight row shape we read from `research_evidence_tables`
 * for the admin routes. We only need the fields the routes use;
 * the rest of the row is opaque. */
interface EvidenceTableRow {
  id: string;
  source_id: string;
  page: number;
  table_index: number;
  headers: string[];
  rows: string[][];
  bbox: { x: number; y: number; w: number; h: number; page: number; units: "pt" };
  markdown: string;
  extraction_provider: "local" | "mistral";
  extraction_confidence: number;
  continues_from_id?: string | null;
}

/** Convert a `research_evidence_tables` row to the
 * `ExtractedTable` shape that `scoreMergeCandidate` expects. */
function rowToExtractedTable(row: EvidenceTableRow): ExtractedTable {
  return {
    id: row.id,
    page: row.page,
    tableIndex: row.table_index,
    headers: row.headers ?? [],
    rows: row.rows ?? [],
    bbox: row.bbox,
    confidence: Number(row.extraction_confidence ?? 0),
    markdown: row.markdown ?? "",
    continuesFromId: row.continues_from_id ?? null,
  };
}

/** Return the override row matching the pair, in either ordering.
 * Matches by `(table_id, other_table_id)` OR `(other_table_id, table_id)`.
 * Returns `null` when no row exists. */
function findOverride(
  supabase: ReturnType<typeof getServiceClient>,
  tableId: string,
  otherTableId: string,
): Promise<{ id: string; action: string; confidence_score: number | null; reason: string; user_id: string; created_at: string; source_id: string; table_id: string; other_table_id: string } | null> {
  // Probe both orderings with two parallel SELECTs. We use the
  // composite index `idx_evidence_tables_override_pair (table_id,
  // other_table_id)` for both probes.
  return (async () => {
    const [a, b] = await Promise.all([
      supabase
        .from("research_evidence_table_merges_override")
        .select(
          "id, source_id, table_id, other_table_id, action, confidence_score, reason, user_id, created_at",
        )
        .eq("table_id", tableId)
        .eq("other_table_id", otherTableId)
        .maybeSingle(),
      supabase
        .from("research_evidence_table_merges_override")
        .select(
          "id, source_id, table_id, other_table_id, action, confidence_score, reason, user_id, created_at",
        )
        .eq("table_id", otherTableId)
        .eq("other_table_id", tableId)
        .maybeSingle(),
    ]);
    const row = (a.data ?? b.data) as any;
    const err = a.error ?? b.error;
    if (err) {
      // Bubble up via thrown error so the route returns 500.
      throw new Error(err.message ?? "override lookup failed");
    }
    return row ?? null;
  })();
}

export const tableMergesRoute = new Elysia({
  prefix: "/api/research-brain",
})
  // ---------------------------------------------------------------------------
  // 1. POST /api/research-brain/tables/:tableId/merge-with/:otherTableId
  // ---------------------------------------------------------------------------
  .post(
    "/tables/:tableId/merge-with/:otherTableId",
    async ({ params, body, request, set }) => {
      const { tableId, otherTableId } = params;
      if (!tableId || !otherTableId) {
        set.status = 400;
        return { error: "Missing tableId or otherTableId" };
      }
      if (tableId === otherTableId) {
        set.status = 400;
        return { error: "tableId and otherTableId must differ" };
      }

      const parsed = (body || {}) as {
        reason?: string;
        confidence_score?: number;
      };
      const reason = (parsed.reason ?? "").toString().trim();
      if (!reason) {
        set.status = 400;
        return { error: "Missing reason" };
      }
      const confidenceScore = clampConfidence(parsed.confidence_score);

      const userId = (request as any).auth?.userId;
      if (!userId) {
        // Defense-in-depth: authResolver({ required: true, role: 'admin' })
        // should have rejected this already.
        set.status = 401;
        return { error: "Authentication required" };
      }

      const supabase = getServiceClient();

      // 1. Load both tables. 404 if either is missing.
      //    Two parallel SELECTs — the spec scenario "POST 404 when
      //    either table id is missing" requires both to exist.
      const [aRes, bRes] = await Promise.all([
        supabase
          .from("research_evidence_tables")
          .select(
            "id, source_id, page, table_index, headers, rows, bbox, markdown, extraction_provider, extraction_confidence, continues_from_id",
          )
          .eq("id", tableId)
          .maybeSingle(),
        supabase
          .from("research_evidence_tables")
          .select(
            "id, source_id, page, table_index, headers, rows, bbox, markdown, extraction_provider, extraction_confidence, continues_from_id",
          )
          .eq("id", otherTableId)
          .maybeSingle(),
      ]);

      if (aRes.error) {
        logger.error(
          { err: aRes.error, tableId },
          "table_merges_lookup_failed",
        );
        set.status = 500;
        return {
          error: "Failed to load table",
          message: aRes.error.message,
        };
      }
      if (bRes.error) {
        logger.error(
          { err: bRes.error, otherTableId },
          "table_merges_lookup_failed",
        );
        set.status = 500;
        return {
          error: "Failed to load other table",
          message: bRes.error.message,
        };
      }
      const tableA = aRes.data as EvidenceTableRow | null;
      const tableB = bRes.data as EvidenceTableRow | null;
      if (!tableA || !tableB) {
        set.status = 404;
        return { error: "Table not found" };
      }

      // 2. Same-source check. 409 if the two fragments live on
      //    different sources (a merge across sources is not a
      //    physical continuation; the detector wouldn't propose
      //    one either).
      if (tableA.source_id !== tableB.source_id) {
        set.status = 409;
        return { error: "Tables belong to different sources" };
      }

      // 3. Idempotent: if an override row already exists for
      //    either ordering with `force_merge`, return 200 with
      //    the existing row. We DO NOT update FK on idempotent
      //    re-call — the spec scenario only requires 200 with
      //    the row.
      const existing = await findOverride(supabase, tableId, otherTableId);
      if (existing && existing.action === "force_merge") {
        set.status = 200;
        return {
          id: existing.id,
          tableId: existing.table_id,
          otherTableId: existing.other_table_id,
          action: existing.action,
        };
      }

      // 4. Insert the override row. Use the LOWER `(page,
      //    table_index)` table as `table_id` so the pair has a
      //    canonical direction in the DB. The detector consults
      //    both orderings anyway, so this is purely cosmetic —
      //    but it makes the override row easier to reason about
      //    when reading the table by hand.
      const aFirst =
        tableA.page < tableB.page ||
        (tableA.page === tableB.page && tableA.table_index <= tableB.table_index);
      const headRow = aFirst ? tableA : tableB;
      const tailRow = aFirst ? tableB : tableA;

      const insertPayload: Record<string, unknown> = {
        source_id: headRow.source_id,
        table_id: headRow.id,
        other_table_id: tailRow.id,
        action: "force_merge",
        reason,
        user_id: userId,
      };
      if (confidenceScore !== undefined) {
        insertPayload.confidence_score = confidenceScore;
      }

      const { data: inserted, error: insertError } = await supabase
        .from("research_evidence_table_merges_override")
        .insert(insertPayload)
        .select("id, table_id, other_table_id, action")
        .single();

      if (insertError || !inserted) {
        logger.error(
          {
            err: insertError,
            tableId,
            otherTableId,
          },
          "table_merges_override_insert_failed",
        );
        set.status = 500;
        return {
          error: "Failed to write override",
          message: insertError?.message,
        };
      }

      // 5. Update the FK on the tail fragment. The override row
      //    is the source of truth at detection time; this
      //    UPDATE makes the FK consistent for read-time chain
      //    walks (the prompt builder + viewer) immediately.
      const { error: fkError } = await supabase
        .from("research_evidence_tables")
        .update({ continues_from_id: headRow.id })
        .eq("id", tailRow.id);

      if (fkError) {
        // Non-fatal: the override is in place, the FK write is
        // a best-effort cache. Log and continue.
        logger.warn(
          { err: fkError, tableId: tailRow.id },
          "table_merges_fk_update_failed",
        );
      }

      logger.info(
        {
          overrideId: (inserted as any).id,
          tableId: headRow.id,
          otherTableId: tailRow.id,
          userId,
          confidenceScore,
        },
        "table_merges_force_merge",
      );

      set.status = 201;
      return {
        id: (inserted as any).id,
        tableId: (inserted as any).table_id,
        otherTableId: (inserted as any).other_table_id,
        action: (inserted as any).action,
      };
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  )
  // ---------------------------------------------------------------------------
  // 2. DELETE /api/research-brain/tables/:tableId/merge-override
  // ---------------------------------------------------------------------------
  .delete(
    "/tables/:tableId/merge-override",
    async ({ params, set }) => {
      const { tableId } = params;
      if (!tableId) {
        set.status = 400;
        return { error: "Missing tableId" };
      }

      const supabase = getServiceClient();

      // 1. Verify the table exists. 404 if it doesn't.
      const { data: table, error: tableError } = await supabase
        .from("research_evidence_tables")
        .select("id, continues_from_id")
        .eq("id", tableId)
        .maybeSingle();

      if (tableError) {
        logger.error(
          { err: tableError, tableId },
          "table_merges_delete_lookup_failed",
        );
        set.status = 500;
        return {
          error: "Failed to load table",
          message: tableError.message,
        };
      }
      if (!table) {
        set.status = 404;
        return { error: "Table not found" };
      }

      // 2. Delete override rows where this table appears in
      //    EITHER position. The spec says "all override rows
      //    involving the table". Two deletes cover both halves
      //    of the symmetric pair.
      const [aDel, bDel] = await Promise.all([
        supabase
          .from("research_evidence_table_merges_override")
          .delete()
          .eq("table_id", tableId),
        supabase
          .from("research_evidence_table_merges_override")
          .delete()
          .eq("other_table_id", tableId),
      ]);

      if (aDel.error) {
        logger.error(
          { err: aDel.error, tableId },
          "table_merges_override_delete_failed",
        );
        set.status = 500;
        return {
          error: "Failed to delete override",
          message: aDel.error.message,
        };
      }
      if (bDel.error) {
        logger.error(
          { err: bDel.error, tableId },
          "table_merges_override_delete_failed",
        );
        set.status = 500;
        return {
          error: "Failed to delete override",
          message: bDel.error.message,
        };
      }
      const removed =
        (aDel.count ?? 0) + (bDel.count ?? 0);

      // 3. Clear the FK on this table's row. If this fragment
      //    is the TAIL of a chain (continues_from_id = some
      //    other table), clearing it detaches the tail. We do
      //    NOT touch the head's row — a future POST against
      //    the pair will rebuild the link if needed.
      const { error: fkError } = await supabase
        .from("research_evidence_tables")
        .update({ continues_from_id: null })
        .eq("id", tableId);

      if (fkError) {
        // Non-fatal: log and continue. The override rows are
        // already gone; the FK is a cache.
        logger.warn(
          { err: fkError, tableId },
          "table_merges_fk_clear_failed",
        );
      }

      logger.info(
        { tableId, removed },
        "table_merges_override_removed",
      );

      set.status = 200;
      return { removed };
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  )
  // ---------------------------------------------------------------------------
  // 3. GET /api/research-brain/tables/:tableId/merges
  // ---------------------------------------------------------------------------
  .get(
    "/tables/:tableId/merges",
    async ({ params, query, set }) => {
      const { tableId } = params;
      if (!tableId) {
        set.status = 400;
        return { error: "Missing tableId" };
      }

      const parsed = (query || {}) as { limit?: string };
      let limit = Number(parsed.limit);
      if (!Number.isFinite(limit) || limit <= 0) limit = 10;
      if (limit > 50) limit = 50;

      const supabase = getServiceClient();

      // 1. Load the anchor table. We need its source_id and
      //    page to scope the candidate search.
      const { data: anchor, error: anchorError } = await supabase
        .from("research_evidence_tables")
        .select(
          "id, source_id, page, table_index, headers, rows, bbox, markdown, extraction_provider, extraction_confidence, continues_from_id",
        )
        .eq("id", tableId)
        .maybeSingle();

      if (anchorError) {
        logger.error(
          { err: anchorError, tableId },
          "table_merges_anchor_lookup_failed",
        );
        set.status = 500;
        return {
          error: "Failed to load table",
          message: anchorError.message,
        };
      }
      if (!anchor) {
        set.status = 404;
        return { error: "Table not found" };
      }
      const anchorRow = anchor as EvidenceTableRow;
      const anchorExtracted = rowToExtractedTable(anchorRow);

      // 2. Load every other table on the same source ordered
      //    by `(page, table_index)`. We then filter in JS for
      //    `|T.page - anchor.page| <= 5` per the spec
      //    ("adjacent pages only"). Supabase range filters on
      //    `page >= anchor.page - 5 AND page <= anchor.page + 5`
      //    would also work, but the per-source candidate set
      //    is bounded by the number of tables on the source
      //    (typically 10s, not 1000s), so JS filter is fine.
      const { data: allRows, error: allError } = await supabase
        .from("research_evidence_tables")
        .select(
          "id, source_id, page, table_index, headers, rows, bbox, markdown, extraction_provider, extraction_confidence, continues_from_id",
        )
        .eq("source_id", anchorRow.source_id)
        .order("page", { ascending: true })
        .order("table_index", { ascending: true });

      if (allError) {
        logger.error(
          { err: allError, tableId, sourceId: anchorRow.source_id },
          "table_merges_source_tables_failed",
        );
        set.status = 500;
        return {
          error: "Failed to load source tables",
          message: allError.message,
        };
      }

      // 3. Load all overrides for the source. The candidate
      //    ranking merges in any override row that names the
      //    pair (in either ordering).
      const { data: overrideRows, error: ovError } = await supabase
        .from("research_evidence_table_merges_override")
        .select(
          "id, source_id, table_id, other_table_id, action, confidence_score, reason, user_id, created_at",
        )
        .eq("source_id", anchorRow.source_id);

      if (ovError) {
        logger.error(
          { err: ovError, sourceId: anchorRow.source_id },
          "table_merges_overrides_load_failed",
        );
        set.status = 500;
        return {
          error: "Failed to load overrides",
          message: ovError.message,
        };
      }

      const rows = (allRows ?? []) as EvidenceTableRow[];
      const overrides = (overrideRows ?? []) as Array<{
        id: string;
        table_id: string;
        other_table_id: string;
        action: string;
        confidence_score: number | null;
        reason: string;
        user_id: string;
        created_at: string;
      }>;

      // 4. Build candidate list. Skip self; filter to ±5 pages.
      const candidates: Array<{
        otherTableId: string;
        page: number;
        tableIndex: number;
        score: number;
        override?: {
          id: string;
          action: string;
          confidenceScore: number | null;
          reason: string;
          userId: string;
          createdAt: string;
        };
      }> = [];
      for (const r of rows) {
        if (r.id === tableId) continue;
        if (Math.abs(r.page - anchorRow.page) > 5) continue;
        const candidateExtracted = rowToExtractedTable(r);
        const score = scoreMergeCandidate(anchorExtracted, candidateExtracted);

        // Find any override row that names the pair (either direction).
        const ov = overrides.find(
          (o) =>
            (o.table_id === tableId && o.other_table_id === r.id) ||
            (o.table_id === r.id && o.other_table_id === tableId),
        );

        candidates.push({
          otherTableId: r.id,
          page: r.page,
          tableIndex: r.table_index,
          score,
          ...(ov
            ? {
                override: {
                  id: ov.id,
                  action: ov.action,
                  confidenceScore: ov.confidence_score,
                  reason: ov.reason,
                  userId: ov.user_id,
                  createdAt: ov.created_at,
                },
              }
            : {}),
        });
      }

      // 5. Rank: score desc, then same tableIndex, then lower
      //    page distance. Per design §"Score tie-break prefers
      //    same `tableIndex`".
      candidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const aSameIdx = a.tableIndex === anchorRow.table_index ? 0 : 1;
        const bSameIdx = b.tableIndex === anchorRow.table_index ? 0 : 1;
        if (aSameIdx !== bSameIdx) return aSameIdx - bSameIdx;
        const aDist = Math.abs(a.page - anchorRow.page);
        const bDist = Math.abs(b.page - anchorRow.page);
        return aDist - bDist;
      });

      return {
        tableId,
        candidates: candidates.slice(0, limit),
      };
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  );

export default tableMergesRoute;
