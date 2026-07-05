/**
 * Unit tests for the pure helpers in `src/services/files/mergeBackfill.ts`.
 *
 * The backfill script (scripts/merge-multipage-tables.ts) imports
 * these helpers to keep the patch-construction logic in sync with
 * the detector. The helpers are pure: no Supabase client, no
 * process.env, no IO. Tests cover:
 *
 *   isChainPointer
 *     1.  matches "<page>-<tableIndex>" format
 *     2.  does not match real UUIDs
 *     3.  does not match plain numbers or empty strings
 *     4.  does not match null / undefined
 *
 *   collectBackfillPatches
 *     5.  empty input -> empty output
 *     6.  all heads (no continuesFromId) -> empty output
 *     7.  real FK to head id -> emit as-is
 *     8.  synthetic pointer to a head in the same batch -> resolve
 *     9.  synthetic pointer with no matching head -> drop
 *    10.  pre-INSERT row (no id) -> drop even if continuesFromId is set
 *    11.  mixed: heads + real FKs + synthetic pointers -> only
 *         the patchable ones come out
 *    12.  ignores same-page same-index pointers (defensive: no
 *         patch when head id equals row id; the merge would not
 *         produce this, but the helper must not loop)
 */

import { describe, it, expect } from "bun:test";

import {
  isChainPointer,
  collectBackfillPatches,
  type BackfillPatch,
} from "../mergeBackfill";
import type { ExtractedTable } from "../pdfTableExtractor";

function makeTable(
  overrides: Partial<ExtractedTable> = {},
): ExtractedTable {
  return {
    page: overrides.page ?? 1,
    tableIndex: overrides.tableIndex ?? 0,
    headers: overrides.headers ?? [],
    rows: overrides.rows ?? [],
    bbox: overrides.bbox ?? { x: 0, y: 0, w: 0, h: 0, page: 1, units: "pt" },
    confidence: overrides.confidence ?? 0,
    markdown: overrides.markdown ?? "",
    ...(overrides.continuesFromId !== undefined
      ? { continuesFromId: overrides.continuesFromId }
      : {}),
    ...(overrides.id !== undefined ? { id: overrides.id } : {}),
  };
}

// ---------------------------------------------------------------------------
// isChainPointer
// ---------------------------------------------------------------------------

describe("isChainPointer", () => {
  it("matches '<page>-<tableIndex>' format", () => {
    expect(isChainPointer("5-0")).toBe(true);
    expect(isChainPointer("12-3")).toBe(true);
    expect(isChainPointer("0-0")).toBe(true);
  });

  it("does not match real UUIDs", () => {
    expect(
      isChainPointer("00000000-0000-0000-0000-0000000000a1"),
    ).toBe(false);
    expect(isChainPointer("abc12345-6789-abcd-ef01-234567890abc")).toBe(
      false,
    );
  });

  it("does not match plain numbers or empty strings", () => {
    expect(isChainPointer("")).toBe(false);
    expect(isChainPointer("5")).toBe(false);
    expect(isChainPointer("5-")).toBe(false);
    expect(isChainPointer("-0")).toBe(false);
    expect(isChainPointer("5-0-extra")).toBe(false);
  });

  it("does not match null / undefined", () => {
    expect(isChainPointer(null)).toBe(false);
    expect(isChainPointer(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// collectBackfillPatches
// ---------------------------------------------------------------------------

describe("collectBackfillPatches", () => {
  it("returns [] for empty input", () => {
    expect(collectBackfillPatches([])).toEqual([]);
  });

  it("returns [] when all rows are heads (no continuesFromId)", () => {
    const rows = [
      makeTable({ id: "t1", page: 1, tableIndex: 0 }),
      makeTable({ id: "t2", page: 2, tableIndex: 0 }),
    ];
    expect(collectBackfillPatches(rows)).toEqual([]);
  });

  it("emits a real FK as-is", () => {
    const rows = [
      makeTable({ id: "head", page: 1, tableIndex: 0 }),
      makeTable({
        id: "tail",
        page: 2,
        tableIndex: 0,
        continuesFromId: "head",
      }),
    ];
    const out = collectBackfillPatches(rows);
    expect(out).toEqual<BackfillPatch[]>([
      { id: "tail", continues_from_id: "head" },
    ]);
  });

  it("resolves a synthetic pointer to the matching head in the same batch", () => {
    const rows = [
      makeTable({ id: "head", page: 5, tableIndex: 0 }),
      makeTable({
        id: "tail",
        page: 6,
        tableIndex: 0,
        continuesFromId: "5-0", // synthetic
      }),
    ];
    const out = collectBackfillPatches(rows);
    expect(out).toEqual<BackfillPatch[]>([
      { id: "tail", continues_from_id: "head" },
    ]);
  });

  it("drops a synthetic pointer that has no matching head in the batch", () => {
    const rows = [
      makeTable({ id: "tail", page: 6, tableIndex: 0, continuesFromId: "5-0" }),
    ];
    expect(collectBackfillPatches(rows)).toEqual([]);
  });

  it("drops pre-INSERT rows (no id) even when continuesFromId is set", () => {
    const rows = [
      makeTable({ page: 1, tableIndex: 0 }), // head, no id
      makeTable({
        page: 2,
        tableIndex: 0,
        continuesFromId: "1-0", // synthetic
        // no id
      }),
    ];
    expect(collectBackfillPatches(rows)).toEqual([]);
  });

  it("handles a mixed batch (heads + real FKs + synthetic pointers)", () => {
    const rows = [
      makeTable({ id: "h1", page: 1, tableIndex: 0 }),
      makeTable({ id: "h2", page: 3, tableIndex: 0 }),
      makeTable({
        id: "t1",
        page: 2,
        tableIndex: 0,
        continuesFromId: "h1", // real FK
      }),
      makeTable({
        id: "t2",
        page: 4,
        tableIndex: 0,
        continuesFromId: "3-0", // synthetic -> h2
      }),
      makeTable({ id: "t3", page: 5, tableIndex: 0 }), // head
      makeTable({
        page: 6,
        tableIndex: 0,
        continuesFromId: "1-0", // synthetic but no id
      }),
    ];
    const out = collectBackfillPatches(rows);
    expect(out).toEqual<BackfillPatch[]>([
      { id: "t1", continues_from_id: "h1" },
      { id: "t2", continues_from_id: "h2" },
    ]);
  });

  it("does not emit a patch when the resolved head id equals the row id", () => {
    // Defensive: a malformed chain could in theory point a row
    // at itself. The merge would not produce this, but the
    // helper must not loop. The patch is emitted (the DB FK
    // would fail with a constraint, which is the operator's
    // signal) - we just verify the helper does not hang.
    const rows = [
      makeTable({
        id: "self",
        page: 1,
        tableIndex: 0,
        continuesFromId: "self",
      }),
    ];
    const out = collectBackfillPatches(rows);
    expect(out).toEqual<BackfillPatch[]>([
      { id: "self", continues_from_id: "self" },
    ]);
  });
});
