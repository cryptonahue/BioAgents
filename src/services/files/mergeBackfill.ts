/**
 * Pure helpers for the multi-page table merge backfill script.
 *
 * The script at `scripts/merge-multipage-tables.ts` and the
 * detector at `src/services/files/providers/localPdfTableProvider.ts`
 * use the same shape for `continuesFromId`:
 *   - `null` / `undefined`        = chain head
 *   - a UUID                     = real DB id (post-INSERT, post backfill)
 *   - `<page>-<tableIndex>`      = synthetic per-batch pointer (pre-INSERT)
 *
 * The detector and the script both need to (a) detect the synthetic
 * pointer format and (b) resolve it to a real head id by
 * (page, tableIndex) lookup. Centralizing both pieces of logic
 * here keeps the script in lock-step with the detector and gives
 * us a single testable surface.
 *
 * This module is pure: no Supabase client, no `process.env`, no
 * `dotenv/config`. The script imports it; the unit tests import
 * it directly. The detector has its own copy of `isChainPointer`
 * (kept for module isolation reasons in CLAUDE.md's TDZ section)
 * — that copy is mirrored here.
 */

import type { ExtractedTable } from "./pdfTableExtractor";

/**
 * Detect a synthetic per-batch pointer (`<page>-<tableIndex>`).
 * Mirrors the detector's `isChainPointer` in
 * `localPdfTableProvider.ts` so the two surfaces agree.
 */
export function isChainPointer(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^\d+-\d+$/.test(value);
}

/**
 * A patch the backfill script would apply: a target row id and
 * the head row id it should now point at.
 */
export type BackfillPatch = {
  id: string;
  continues_from_id: string;
};

/**
 * Resolve a `mergeTablesAcrossPages` output into a flat list of
 * (id → head id) patches. The merge post-pass may emit:
 *   - `null`            → no patch (head)
 *   - a UUID            → real FK; emit as-is
 *   - `<page>-<tableIndex>` → synthetic pointer; resolve to the
 *                             matching node's real id (by
 *                             page + tableIndex lookup in the
 *                             same input batch)
 *
 * Rows without an `id` (the detector's pre-INSERT case) are
 * silently dropped — the script only patches DB rows.
 *
 * Pure function. Exported for unit tests.
 */
export function collectBackfillPatches(
  merged: ExtractedTable[],
): BackfillPatch[] {
  const out: BackfillPatch[] = [];
  for (const t of merged) {
    if (!t.continuesFromId) continue;
    if (!t.id) continue;
    if (isChainPointer(t.continuesFromId)) {
      const head = merged.find(
        (x) => `${x.page}-${x.tableIndex}` === t.continuesFromId,
      );
      if (!head?.id) continue;
      out.push({ id: t.id, continues_from_id: head.id });
      continue;
    }
    out.push({ id: t.id, continues_from_id: t.continuesFromId });
  }
  return out;
}
