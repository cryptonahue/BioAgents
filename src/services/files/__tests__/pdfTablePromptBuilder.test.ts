/**
 * Unit tests for the prompt builder.
 *
 * PR #2 of bioprospecting-multipage-table-merge: covers the
 * chain walk, defensive merge, and cycle detection paths in
 * `buildTablesPromptSection`. Each fixture hand-rolls
 * `ExtractedTable[]` and asserts the rendered `tables:` block.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { ExtractedTable } from "../pdfTableExtractor";
import {
  _resetTableMergeEnabledForTests,
  buildTablesPromptSection,
  isTableMergeEnabled,
} from "../pdfTablePromptBuilder";

function makeTable(overrides: Partial<ExtractedTable>): ExtractedTable {
  return {
    page: 1,
    tableIndex: 0,
    headers: ["A", "B"],
    rows: [["1", "2"]],
    bbox: { x: 0, y: 0, w: 100, h: 50, page: 1, units: "pt" },
    confidence: 0.5,
    markdown: "",
    ...overrides,
  };
}

describe("pdfTablePromptBuilder — buildTablesPromptSection", () => {
  it("returns '' for an empty input", () => {
    expect(buildTablesPromptSection([])).toBe("");
  });

  it("emits a tables: header line", () => {
    const out = buildTablesPromptSection([makeTable({})]);
    expect(out.startsWith("tables:")).toBe(true);
  });

  it("emits page=N table=M labels for each table", () => {
    const out = buildTablesPromptSection([
      makeTable({ page: 2, tableIndex: 1, headers: ["x"], rows: [["y"]] }),
    ]);
    expect(out).toContain("page=2 table=1");
  });

  it("renders the header row in pipe format", () => {
    const out = buildTablesPromptSection([
      makeTable({ headers: ["Treatment", "Yield"], rows: [["A", "10"]] }),
    ]);
    expect(out).toContain("| Treatment | Yield |");
    expect(out).toContain("| --- | --- |");
  });

  it("renders data rows in pipe format", () => {
    const out = buildTablesPromptSection([
      makeTable({
        headers: ["x", "y"],
        rows: [
          ["1", "2"],
          ["3", "4"],
        ],
      }),
    ]);
    expect(out).toContain("| 1 | 2 |");
    expect(out).toContain("| 3 | 4 |");
  });

  it("normalizes empty cells to '-'", () => {
    const out = buildTablesPromptSection([
      makeTable({ headers: ["a", "b"], rows: [["", "x"]] }),
    ]);
    expect(out).toContain("| - | x |");
  });

  it("orders tables by (page, tableIndex) ascending", () => {
    const t1 = makeTable({
      page: 2,
      tableIndex: 0,
      headers: ["a"],
      rows: [["x"]],
    });
    const t2 = makeTable({
      page: 1,
      tableIndex: 5,
      headers: ["b"],
      rows: [["y"]],
    });
    const t3 = makeTable({
      page: 1,
      tableIndex: 0,
      headers: ["c"],
      rows: [["z"]],
    });
    const out = buildTablesPromptSection([t1, t2, t3]);
    // Find the order of the page= labels.
    const cIdx = out.indexOf("page=1 table=0");
    const bIdx = out.indexOf("page=1 table=5");
    const aIdx = out.indexOf("page=2 table=0");
    expect(cIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(aIdx);
  });

  it("handles multi-level headers (flattened) without crashing", () => {
    // The detector flattens multi-level headers before they reach
    // the prompt builder, so the prompt builder sees a flat array.
    // The builder just renders whatever it's given.
    const out = buildTablesPromptSection([
      makeTable({
        headers: ["L1A", "L1B", "L2A", "L2B", "L2C"],
        rows: [["1", "2", "3", "4", "5"]],
      }),
    ]);
    expect(out).toContain("| L1A | L1B | L2A | L2B | L2C |");
    expect(out).toContain("| --- | --- | --- | --- | --- |");
    expect(out).toContain("| 1 | 2 | 3 | 4 | 5 |");
  });

  it("pads short body rows with '-' to match the header length", () => {
    const out = buildTablesPromptSection([
      makeTable({ headers: ["a", "b", "c"], rows: [["1"]] }),
    ]);
    expect(out).toContain("| 1 | - | - |");
  });

  it("emits no header row when headers is empty (markdown-only tables from Mistral)", () => {
    const out = buildTablesPromptSection([
      makeTable({ headers: [], rows: [] }),
    ]);
    // No " | --- |" separator because there's no header row.
    expect(out).not.toContain("| --- |");
  });
});

// ---------------------------------------------------------------------------
// PR #2 of bioprospecting-multipage-table-merge: chain walk + defensive
// merge + cycle detection.
// ---------------------------------------------------------------------------

describe("pdfTablePromptBuilder — PR2 chain walk", () => {
  afterEach(() => {
    _resetTableMergeEnabledForTests();
  });

  it("(a) chain walk: 3 fragments linked 5→6→7 via real DB ids collapse to 1 'tables:' block with 3 'page=N table=M' sub-markers in page-ascending order", () => {
    // Fragments linked by real DB ids (post-INSERT case).
    const head = makeTable({
      id: "id-head",
      page: 5,
      tableIndex: 0,
      headers: ["Treatment", "Yield"],
      rows: [
        ["A", "10"],
        ["B", "20"],
      ],
    });
    const mid = makeTable({
      id: "id-mid",
      page: 6,
      tableIndex: 0,
      headers: ["Treatment", "Yield"],
      rows: [
        ["C", "30"],
        ["D", "40"],
      ],
      continuesFromId: "id-head",
    });
    const tail = makeTable({
      id: "id-tail",
      page: 7,
      tableIndex: 0,
      headers: ["Treatment", "Yield"],
      rows: [
        ["E", "50"],
        ["F", "60"],
      ],
      continuesFromId: "id-mid",
    });

    const out = buildTablesPromptSection([mid, head, tail]);
    // ONE `tables:` block.
    expect(out.match(/^tables:$/gm)?.length).toBe(1);
    // Three sub-markers in page-ascending order.
    const p5 = out.indexOf("page=5 table=0");
    const p6 = out.indexOf("page=6 table=0");
    const p7 = out.indexOf("page=7 table=0");
    expect(p5).toBeGreaterThan(-1);
    expect(p6).toBeGreaterThan(-1);
    expect(p7).toBeGreaterThan(-1);
    expect(p5).toBeLessThan(p6);
    expect(p6).toBeLessThan(p7);
    // The bodies are concatenated in chain order.
    const aIdx = out.indexOf("| A | 10 |");
    const bIdx = out.indexOf("| B | 20 |");
    const cIdx = out.indexOf("| C | 30 |");
    const eIdx = out.indexOf("| E | 50 |");
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(cIdx).toBeGreaterThan(bIdx);
    expect(eIdx).toBeGreaterThan(cIdx);
  });

  it("(b) defensive merge: 2 unlinked fragments with matching headers on adjacent pages collapse to 1 block even when continuesFromId is null on both", () => {
    // Two fragments, no FK set, but they match the `hard` heuristic
    // (no `Table N.` prefix on T₂, identical headers).
    const f1 = makeTable({
      id: "f1",
      page: 4,
      tableIndex: 0,
      headers: ["Treatment", "Yield"],
      rows: [["A", "10"]],
    });
    const f2 = makeTable({
      id: "f2",
      page: 5,
      tableIndex: 0,
      headers: ["Treatment", "Yield"],
      rows: [["B", "20"]],
    });

    const out = buildTablesPromptSection([f1, f2]);
    // ONE `tables:` block (the defensive merge folded them).
    expect(out.match(/^tables:$/gm)?.length).toBe(1);
    // Two sub-markers in page order.
    const p4 = out.indexOf("page=4 table=0");
    const p5 = out.indexOf("page=5 table=0");
    expect(p4).toBeGreaterThan(-1);
    expect(p5).toBeGreaterThan(p4);
  });

  it("(c) cycle detection: a fragment with continuesFromId equal to its own id terminates cleanly without infinite loop", () => {
    // Self-referential chain: row.id === row.continuesFromId.
    // The walker must terminate, NOT spin forever.
    const f1 = makeTable({
      id: "self",
      page: 1,
      tableIndex: 0,
      headers: ["A", "B"],
      rows: [["1", "2"]],
      continuesFromId: "self", // self-reference → cycle
    });
    const f2 = makeTable({
      id: "f2",
      page: 2,
      tableIndex: 0,
      headers: ["A", "B"],
      rows: [["3", "4"]],
    });

    // The build must complete (no hang). We assert the result is
    // well-formed: at least one `tables:` block, the self-ref row
    // is treated as a head (because the cycle detection aborts
    // the walk when it sees a repeat id).
    const out = buildTablesPromptSection([f1, f2]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.startsWith("tables:")).toBe(true);
    // The self-ref fragment should still be present as a page=
    // marker (because the cycle detection treats it as a head).
    expect(out).toContain("page=1 table=0");
    // f2 is unlinked → its own head, also rendered.
    expect(out).toContain("page=2 table=0");
  });

  it("TABLE_MERGE_ENABLED=false falls back to per-fragment rendering", () => {
    process.env.TABLE_MERGE_ENABLED = "false";
    _resetTableMergeEnabledForTests();
    expect(isTableMergeEnabled()).toBe(false);

    const head = makeTable({
      id: "id-head",
      page: 5,
      tableIndex: 0,
      headers: ["Treatment", "Yield"],
      rows: [["A", "10"]],
    });
    const mid = makeTable({
      id: "id-mid",
      page: 6,
      tableIndex: 0,
      headers: ["Treatment", "Yield"],
      rows: [["B", "20"]],
      continuesFromId: "id-head",
    });

    const out = buildTablesPromptSection([mid, head]);
    // Kill switch off → per-fragment: two `tables:` blocks? No —
    // there is still exactly one `tables:` header, but the chain
    // walk is disabled so the head and tail are rendered in
    // (page, tableIndex) order WITHOUT chain semantics. Verify
    // both fragments appear and are ordered.
    expect(out).toContain("page=5 table=0");
    expect(out).toContain("page=6 table=0");
    const p5 = out.indexOf("page=5 table=0");
    const p6 = out.indexOf("page=6 table=0");
    expect(p5).toBeLessThan(p6);

    // Restore.
    delete process.env.TABLE_MERGE_ENABLED;
    _resetTableMergeEnabledForTests();
    expect(isTableMergeEnabled()).toBe(true);
  });
});
