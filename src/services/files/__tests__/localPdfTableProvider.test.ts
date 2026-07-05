/**
 * Unit tests for the local table detector's pure clustering
 * algorithm. The detector is exported from `localPdfTableProvider.ts`
 * as `detectTablesOnPage` — these tests drive it with hand-rolled
 * text-item fixtures (no pdfjs involvement) and assert the
 * cluster output matches expectations.
 *
 * The spike test (which DOES go through pdfjs) lives in
 * `localPdfTableProvider.spike.test.ts` next to this file.
 *
 * PR #1 of bioprospecting-multipage-table-merge: also covers the
 * `mergeTablesAcrossPages` and `scoreMergeCandidate` post-pass
 * functions. These are pure (no pdfjs) and use hand-rolled
 * `ExtractedTable[]` fixtures.
 */

import { describe, expect, it } from "bun:test";
import type { ExtractedTable } from "../pdfTableExtractor";
import {
  detectTablesOnPage,
  mergeTablesAcrossPages,
  renderTableToMarkdown,
  scoreMergeCandidate,
  segmentRowIntoCells,
  type DetectedRow,
  type MergeOverride,
} from "../providers/localPdfTableProvider";

type TextItemFixture = {
  str: string;
  transform: [number, number, number, number, number, number];
  width: number;
  height: number;
};

const PAGE_HEIGHT_PT = 792; // US Letter

function fixture(
  str: string,
  x: number,
  yPdf: number,
  width: number,
  height = 12,
  fontSize = 12,
): TextItemFixture {
  return {
    str,
    transform: [fontSize, 0, 0, fontSize, x, yPdf],
    width,
    height,
  };
}

/**
 * Build a simple 2x2 table fixture:
 *   Headers (y=700): Treatment, Yield
 *   Row 1 (y=670):   A,          10
 *   Row 2 (y=640):   B,          20
 * PDF origin bottom-left → yPdf is the BOTTOM of the text run.
 */
function simpleTableItems(): TextItemFixture[] {
  return [
    fixture("Treatment", 100, 700 - 12, 60),
    fixture("Yield", 250, 700 - 12, 30),
    fixture("A", 100, 670 - 12, 10),
    fixture("10", 250, 670 - 12, 14),
    fixture("B", 100, 640 - 12, 10),
    fixture("20", 250, 640 - 12, 14),
  ];
}

describe("localPdfTableProvider — detectTablesOnPage", () => {
  it("returns [] for an empty page", () => {
    const out = detectTablesOnPage([], 1, PAGE_HEIGHT_PT);
    expect(out).toEqual([]);
  });

  it("returns [] when there are no body rows (header only)", () => {
    const items = [
      fixture("Treatment", 100, 700 - 12, 60),
      fixture("Yield", 250, 700 - 12, 30),
    ];
    const out = detectTablesOnPage(items, 1, PAGE_HEIGHT_PT);
    // Single header row, no body → not a table per MIN_BODY_ROWS = 1.
    expect(out).toEqual([]);
  });

  it("detects a simple 2x2 table with correct bbox.units === 'pt'", () => {
    const out = detectTablesOnPage(simpleTableItems(), 1, PAGE_HEIGHT_PT);
    expect(out.length).toBe(1);
    const t = out[0];
    expect(t.page).toBe(1);
    expect(t.tableIndex).toBe(0);
    expect(t.bbox.units).toBe("pt");
    expect(t.headers).toContain("Treatment");
    expect(t.headers).toContain("Yield");
    // Body rows are [["A", "10"], ["B", "20"]]
    expect(t.rows.length).toBe(2);
    expect(t.rows[0]).toContain("A");
    expect(t.rows[1]).toContain("20");
    // Confidence should be a positive number between 0 and 1.
    expect(t.confidence).toBeGreaterThan(0);
    expect(t.confidence).toBeLessThanOrEqual(1);
  });

  it("emits empty cells as '-' for sparse body rows", () => {
    // Treatment | Yield
    // A         | (empty)
    // B         | 20
    const items = [
      fixture("Treatment", 100, 700 - 12, 60),
      fixture("Yield", 250, 700 - 12, 30),
      fixture("A", 100, 670 - 12, 10),
      // No second column on row 1
      fixture("B", 100, 640 - 12, 10),
      fixture("20", 250, 640 - 12, 14),
    ];
    const out = detectTablesOnPage(items, 1, PAGE_HEIGHT_PT);
    expect(out.length).toBeGreaterThanOrEqual(1);
    const t = out[0];
    // Find the row that has "A" and the one that has "B".
    const aRow = t.rows.find((r) => r.includes("A"));
    const bRow = t.rows.find((r) => r.includes("B"));
    expect(aRow).toBeDefined();
    expect(bRow).toBeDefined();
    // The empty cell should be normalized to "-".
    expect(aRow!.some((c) => c === "-")).toBe(true);
    expect(bRow!.some((c) => c === "-")).toBe(false);
  });

  it("detects multi-level headers by flattening them into a single array", () => {
    // Two header rows:
    //   L1: "Extraction Parameters", "Yield" (spans col 2 + col 3)
    //   L2: "Pressure", "Temp", "Time"
    // Body: 10, 20, 30
    // We simulate by using a separate column for L1 (the L1 cell
    // text and the L2 cells it spans are inferred by the row count
    // and width). To keep the test deterministic, the simpler form:
    //
    //   L1: "Treatment" (one column), "Parameters" (covers cols 2-3)
    //   L2: "Drug" (col 1), "Pressure", "Temp"
    //   Body: "A", "10", "20"
    //         "B", "30", "40"
    //
    // Since L2 has 3 cells and L1 has 2, the flattener will interleave
    // them: [L1_1, L1_2, L2_1, L2_2, L2_3].
    const items = [
      // L1 row (y=720)
      fixture("Treatment", 100, 720 - 12, 60),
      fixture("Parameters", 250, 720 - 12, 60),
      // L2 row (y=695)
      fixture("Drug", 100, 695 - 12, 30),
      fixture("Pressure", 250, 695 - 12, 50),
      fixture("Temp", 400, 695 - 12, 30),
      // Body row 1 (y=670)
      fixture("A", 100, 670 - 12, 10),
      fixture("10", 250, 670 - 12, 14),
      fixture("20", 400, 670 - 12, 14),
      // Body row 2 (y=640)
      fixture("B", 100, 640 - 12, 10),
      fixture("30", 250, 640 - 12, 14),
      fixture("40", 400, 640 - 12, 14),
    ];
    const out = detectTablesOnPage(items, 1, PAGE_HEIGHT_PT);
    expect(out.length).toBe(1);
    const t = out[0];
    // Multi-level flattening: both L1 cells appear in headers.
    expect(t.headers).toContain("Treatment");
    expect(t.headers).toContain("Parameters");
    // And the L2 cells are appended.
    expect(t.headers).toContain("Drug");
    expect(t.headers).toContain("Pressure");
    expect(t.headers).toContain("Temp");
  });

  it("bbox.units is always 'pt'", () => {
    const out = detectTablesOnPage(simpleTableItems(), 1, PAGE_HEIGHT_PT);
    for (const t of out) {
      expect(t.bbox.units).toBe("pt");
    }
  });

  it("bbox coordinates are non-negative and within page bounds (top-left origin)", () => {
    const out = detectTablesOnPage(simpleTableItems(), 1, PAGE_HEIGHT_PT);
    for (const t of out) {
      expect(t.bbox.x).toBeGreaterThanOrEqual(0);
      expect(t.bbox.y).toBeGreaterThanOrEqual(0);
      expect(t.bbox.w).toBeGreaterThanOrEqual(0);
      expect(t.bbox.h).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("localPdfTableProvider — segmentRowIntoCells", () => {
  function makeCell(
    x: number,
    width: number,
    text: string,
    y = 100,
    height = 12,
  ): DetectedRow["cells"][number] {
    return {
      text,
      bbox: { x, y, w: width, h: height, page: 1, units: "pt" },
      x,
      y,
      width,
      height,
    };
  }

  it("merges consecutive items into one cell when within tolerance", () => {
    const row: DetectedRow["cells"] = [
      makeCell(100, 30, "Hel"),
      makeCell(132, 30, "lo"), // 100+30+2=132, within 4pt tolerance
    ];
    const out = segmentRowIntoCells(row, 4);
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("Hel lo");
  });

  it("splits into separate cells when the gap exceeds tolerance", () => {
    const row: DetectedRow["cells"] = [
      makeCell(100, 30, "Hel"),
      makeCell(200, 30, "lo"), // 130+70 gap > 4pt tolerance
    ];
    const out = segmentRowIntoCells(row, 4);
    expect(out.length).toBe(2);
    expect(out[0].text).toBe("Hel");
    expect(out[1].text).toBe("lo");
  });

  it("handles a single cell", () => {
    const row: DetectedRow["cells"] = [makeCell(100, 30, "Only")];
    const out = segmentRowIntoCells(row, 4);
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("Only");
  });

  it("handles an empty row", () => {
    const out = segmentRowIntoCells([], 4);
    expect(out).toEqual([]);
  });
});

describe("localPdfTableProvider — renderTableToMarkdown", () => {
  it("renders a single-header single-row table", () => {
    const md = renderTableToMarkdown(["A", "B"], [["1", "2"]]);
    expect(md).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("renders a header-only table", () => {
    const md = renderTableToMarkdown(["A", "B"], []);
    expect(md).toBe("| A | B |\n| --- | --- |");
  });

  it("pads short body rows with '-' to match the header length", () => {
    const md = renderTableToMarkdown(["A", "B", "C"], [["1"]]);
    expect(md).toContain("| 1 | - | - |");
  });

  it("returns an empty string for an empty input", () => {
    expect(renderTableToMarkdown([], [])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// PR #1 of bioprospecting-multipage-table-merge: merge post-pass.
// ---------------------------------------------------------------------------

/** Build a minimal ExtractedTable for merge-fixture use. Only the
 * fields the merge function reads are populated. */
function mkTable(
  page: number,
  tableIndex: number,
  headers: string[],
  firstBodyRow: string[],
  opts: {
    id?: string;
    x?: number;
    rows?: string[][];
  } = {},
): ExtractedTable {
  return {
    page,
    tableIndex,
    headers,
    rows: opts.rows ?? [firstBodyRow],
    bbox: {
      x: opts.x ?? 100,
      y: 100,
      w: 400,
      h: 50,
      page,
      units: "pt",
    },
    confidence: 0.9,
    markdown: "",
    ...(opts.id ? { id: opts.id } : {}),
  };
}

describe("localPdfTableProvider — scoreMergeCandidate", () => {
  it("returns 1.0 when all 4 signals fire (matching headers, same columns, X-anchor within 4pt, page distance 1, same tableIndex)", () => {
    const t1 = mkTable(5, 0, ["Treatment", "Yield"], ["A", "10"], { x: 100 });
    const t2 = mkTable(6, 0, ["Treatment", "Yield"], ["B", "20"], { x: 102 });
    const score = scoreMergeCandidate(t1, t2);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it("returns 0 when T2's first body row matches the 'Table N.' prefix, even when every other signal would fire", () => {
    const t1 = mkTable(5, 0, ["Treatment", "Yield"], ["A", "10"], { x: 100 });
    const t2 = mkTable(
      6,
      0,
      ["Treatment", "Yield"],
      ["Table 3. Continued from previous page"],
      { x: 102 },
    );
    const score = scoreMergeCandidate(t1, t2);
    expect(score).toBe(0);
  });
});

describe("localPdfTableProvider — mergeTablesAcrossPages", () => {
  it("(a) passes through a single-page document without setting continuesFromId", () => {
    const t1 = mkTable(1, 0, ["A", "B"], ["1", "2"], { id: "t1" });
    const t2 = mkTable(1, 1, ["C", "D"], ["3", "4"], { id: "t2" });
    const out = mergeTablesAcrossPages([t1, t2], "hard", [], 0.7);
    expect(out).toHaveLength(2);
    expect(out[0].continuesFromId).toBeNull();
    expect(out[1].continuesFromId).toBeNull();
  });

  it("(b) merges a 2-page fragment pair in 'hard' mode when headers match and T2 has no 'Table N.' prefix", () => {
    const t1 = mkTable(5, 0, ["Treatment", "Yield"], ["A", "10"], { id: "t1" });
    const t2 = mkTable(6, 0, ["Treatment", "Yield"], ["B", "20"], { id: "t2" });
    const out = mergeTablesAcrossPages([t1, t2], "hard", [], 0.7);
    expect(out).toHaveLength(2);
    expect(out[0].continuesFromId).toBeNull();
    // T2's continuesFromId should be T1's id (real id, both have ids).
    expect(out[1].continuesFromId).toBe("t1");
  });

  it("(c) chains a 3-page fragment 5→6→7 in 'hard-confidence' mode (all headers match, same tableIndex, page distance 1)", () => {
    const t1 = mkTable(5, 0, ["Treatment", "Yield"], ["A", "10"], { id: "t1" });
    const t2 = mkTable(6, 0, ["Treatment", "Yield"], ["B", "20"], { id: "t2" });
    const t3 = mkTable(7, 0, ["Treatment", "Yield"], ["C", "30"], { id: "t3" });
    const out = mergeTablesAcrossPages([t1, t2, t3], "hard-confidence", [], 0.7);
    expect(out).toHaveLength(3);
    expect(out[0].continuesFromId).toBeNull();
    expect(out[1].continuesFromId).toBe("t1");
    expect(out[2].continuesFromId).toBe("t2");
  });

  it("(d) 'hard-confidence' mode threshold gate: score below threshold → no merge", () => {
    // Mismatched headers → header signal 0, columns still match (2),
    // X-anchor aligned, page distance + same tableIndex.
    // Score = 0 (header) + 0.2 (columns) + 0.2 (X) + 0.2 (page+index) = 0.6
    // Below 0.7 threshold → no merge.
    const t1 = mkTable(5, 0, ["Treatment", "Yield"], ["A", "10"], { x: 100 });
    const t2 = mkTable(6, 0, ["Different", "Headers"], ["B", "20"], { x: 102 });
    const out = mergeTablesAcrossPages([t1, t2], "hard-confidence", [], 0.7);
    expect(out).toHaveLength(2);
    expect(out[0].continuesFromId).toBeNull();
    expect(out[1].continuesFromId).toBeNull();
  });

  it("(e) 'Table N.' prefix negative signal forces score=0 in 'hard-confidence' mode → no merge", () => {
    // Even with all other signals positive, the prefix forces 0 → below
    // threshold → no merge.
    const t1 = mkTable(5, 0, ["Treatment", "Yield"], ["A", "10"], { x: 100 });
    const t2 = mkTable(
      6,
      0,
      ["Treatment", "Yield"],
      ["Table 3. Continued from page 5"],
      { x: 102 },
    );
    const out = mergeTablesAcrossPages([t1, t2], "hard-confidence", [], 0.5);
    expect(out).toHaveLength(2);
    expect(out[0].continuesFromId).toBeNull();
    expect(out[1].continuesFromId).toBeNull();
  });

  it("(f) 'manual' mode is a no-op: detector never merges regardless of signals", () => {
    // Perfect candidate pair: identical headers, X-anchor aligned,
    // same tableIndex, page distance 1. Manual → no merge.
    const t1 = mkTable(5, 0, ["Treatment", "Yield"], ["A", "10"], { id: "t1" });
    const t2 = mkTable(6, 0, ["Treatment", "Yield"], ["B", "20"], { id: "t2" });
    const out = mergeTablesAcrossPages([t1, t2], "manual", [], 0.7);
    expect(out).toHaveLength(2);
    expect(out[0].continuesFromId).toBeNull();
    expect(out[1].continuesFromId).toBeNull();
  });

  it("(g) override precedence: force_merge writes FK regardless of score; force_unmerge clears it; both (T1,T2) and (T2,T1) orderings are consulted", () => {
    // Pair with mismatched headers (would NOT merge in hard-confidence
    // at threshold 0.7) — but a force_merge override forces the merge.
    const t1 = mkTable(5, 0, ["A", "B"], ["1", "2"], { id: "t1", x: 100 });
    const t2 = mkTable(6, 0, ["X", "Y"], ["3", "4"], { id: "t2", x: 300 });

    // (g.1) force_merge in (t1, t2) order → merge applied
    const overridesAB: MergeOverride[] = [
      {
        tableId: "t1",
        otherTableId: "t2",
        action: "force_merge",
        reason: "manual link",
      },
    ];
    const out1 = mergeTablesAcrossPages(
      [t1, t2],
      "hard-confidence",
      overridesAB,
      0.7,
    );
    expect(out1[1].continuesFromId).toBe("t1");

    // (g.2) force_merge in (t2, t1) order (reversed) → still merges
    const overridesBA: MergeOverride[] = [
      {
        tableId: "t2",
        otherTableId: "t1",
        action: "force_merge",
        reason: "manual link",
      },
    ];
    const out2 = mergeTablesAcrossPages(
      [t1, t2],
      "hard-confidence",
      overridesBA,
      0.7,
    );
    expect(out2[1].continuesFromId).toBe("t1");

    // (g.3) force_unmerge clears any prior continuesFromId
    // Pre-set t2.continuesFromId to t1's id (mimicking a prior merge),
    // then run with a force_unmerge override.
    const t1Linked = { ...t1 };
    const t2Linked: ExtractedTable = { ...t2, continuesFromId: "t1" };
    const overridesUnmerge: MergeOverride[] = [
      {
        tableId: "t1",
        otherTableId: "t2",
        action: "force_unmerge",
        reason: "wrong link",
      },
    ];
    const out3 = mergeTablesAcrossPages(
      [t1Linked, t2Linked],
      "hard-confidence",
      overridesUnmerge,
      0.7,
    );
    expect(out3[1].continuesFromId).toBeNull();
  });
});
