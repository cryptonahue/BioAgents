/**
 * Local PDF table extraction provider.
 *
 * Custom detector built on `pdfjs-dist@5` legacy build. No
 * `pdf-table-extractor` (it pinned pdfjs-dist@1 and required a
 * canvas runtime that Bun cannot load in this environment), no
 * `node-canvas`, no web worker. See design §3.2.
 *
 * Algorithm summary (per page):
 *   1. Load the page with `pdfjs.getDocument(...)`.
 *   2. Walk `page.getTextContent().items`. Each text item carries
 *      `transform[5]` (x, y in PDF points, origin bottom-left),
 *      `width`, `height`.
 *   3. Cluster items by y-coordinate (tolerance 2pt) → rows.
 *   4. Within each row, segment cells by x-coordinate: an item
 *      continues the current cell if its `x` is within `x + width + 4pt`
 *      of the previous item's end.
 *   5. The first 1-2 rows of a page that are short and text-like are
 *      header rows. Multi-level headers are flattened into a single
 *      `headers` array (interleaving L1, L2 with L2 cells repeated
 *      for the span they cover).
 *   6. Bbox of a table = union of every cell's geometry, normalized
 *      to PDF native origin (bottom-left).
 *   7. Per-row confidence = `min(1, chars / (numCells * 8))`. Table
 *      confidence = mean of row confidences.
 *
 * Multi-page: this provider runs the algorithm once per page and
 * concatenates the results. The caller is responsible for
 * persisting `(page, tableIndex)` per source.
 */

import type { PdfjsLegacyModule } from "../loaders/pdfjsLegacy";
import type {
  BBox,
  ExtractedFigure,
  ExtractedTable,
  TableExtractionProvider,
} from "../pdfTableExtractor";
import { TableExtractionProviderError } from "../pdfTableExtractor";

// ---------------------------------------------------------------------------
// Tunables (kept as module constants so tests can reference them)
// ---------------------------------------------------------------------------

/** Items within this many points of each other on Y are on the same row. */
export const Y_TOLERANCE_PT = 2;

/** Items within this many points of the previous item's right edge continue the same cell. */
export const X_TOLERANCE_PT = 4;

/** Maximum text length for a cell to be considered a header cell. */
export const MAX_HEADER_CELL_CHARS = 40;

/** Maximum number of body rows that count as "header" rows (1-2 for multi-level). */
export const MAX_HEADER_ROWS = 2;

/** Minimum number of body rows for a cluster of rows to be considered a "table" at all. */
export const MIN_BODY_ROWS = 1;

/** Maximum chain depth for a multi-page table merge. A chain longer than this
 * is treated as a single chain head plus a new chain. Defensive cap on the
 * prompt walker's `Set<string>` cycle detection. */
export const MAX_CHAIN_DEPTH = 10;

/** Env var keys for merge mode + threshold. Read via `globalThis` memoization
 * (TDZ-safe) in `resolveMergeConfig()`. */
export const TABLE_MERGE_MODE_ENV = "TABLE_MERGE_MODE";
export const TABLE_MERGE_THRESHOLD_ENV = "TABLE_MERGE_THRESHOLD";

/** Hard ceiling for the merge score (0..1). */
export const MERGE_SCORE_CEILING = 1;

// ---------------------------------------------------------------------------
// Multi-page merge post-pass
// ---------------------------------------------------------------------------

/** Merge mode controlling whether and how the detector links consecutive
 * fragments across pages. See spec §"Multi-Page Table Continuation" mode table. */
export type MergeMode = "hard" | "hard-confidence" | "manual";

/** Per-pair override row, loaded from `research_evidence_table_merges_override`.
 * The detector consults this BEFORE `scoreMergeCandidate` per design
 * §"Per-pair override always wins over detector". The `tableId` and
 * `otherTableId` match the DB ids of the two fragments being evaluated. */
export interface MergeOverride {
  tableId: string;
  otherTableId: string;
  action: "force_merge" | "force_unmerge";
  confidenceScore?: number;
  reason?: string;
}

/** Synthetic pointer used to chain a tail fragment to its head before
 * the row has a real DB id. Format: `<prevPage>-<prevTableIndex>` (e.g.
 * `"5-0"`). The persistence layer in `pdfTableExtractor.ts` recognizes
 * this format and resolves it to a real DB id by looking up the head
 * row by `(page, table_index)`. UUIDs never collide with this format. */
export const CHAIN_POINTER_PREFIX = ""; // placeholder; pointers are `page-tableIndex`

/** Default score threshold for `hard-confidence` mode. */
export const DEFAULT_MERGE_THRESHOLD = 0.7;

/** Weights for the 4-signal merge score. Sum = 1.0. See spec §"hard-confidence
 * weights" and design §"Decision: Score tie-break prefers same `tableIndex`". */
export const SCORE_WEIGHT_HEADER = 0.4;
export const SCORE_WEIGHT_COLUMNS = 0.2;
export const SCORE_WEIGHT_X_ANCHOR = 0.2;
export const SCORE_WEIGHT_PAGE_DIST = 0.2;

/** Regex for the negative signal: T₂'s first body row matches
 * `Table N.` (or `Table N`). The score is forced to 0 when this matches,
 * UNLESS an override row exists for the pair. */
export const TABLE_PREFIX_RE = /^Table\s+\d+\.?\s*/i;

/** Normalize a header for case+whitespace-insensitive comparison. */
function normalizeHeader(s: string): string {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Headers match iff the normalized arrays are elementwise equal AND
 * both are non-empty. Empty headers (the detector's fallback when no
 * descriptive cells were found) are not considered a match. */
function headersMatch(a: string[], b: string[]): boolean {
  if (!a || !b || a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (normalizeHeader(a[i]) !== normalizeHeader(b[i])) return false;
  }
  return true;
}

/** X-anchor alignment: |T₁.bbox.x − T₂.bbox.x| ≤ X_TOLERANCE_PT (4pt). */
function xAnchorsAligned(t1: ExtractedTable, t2: ExtractedTable): boolean {
  return Math.abs((t1.bbox?.x ?? 0) - (t2.bbox?.x ?? 0)) <= X_TOLERANCE_PT;
}

/** Page distance = 1 AND same `tableIndex`. The strongest prior in real
 * multi-page PDFs (see design §"Decision: Score tie-break prefers same
 * `tableIndex`"). */
function pageDistanceAndIndexMatch(t1: ExtractedTable, t2: ExtractedTable): boolean {
  return t2.page - t1.page === 1 && t1.tableIndex === t2.tableIndex;
}

/** First body row of T₂ (the first non-empty row). Returns the row or
 * `null` if T₂ has no rows. */
function firstBodyRow(t: ExtractedTable): string[] | null {
  if (!t.rows || t.rows.length === 0) return null;
  for (const row of t.rows) {
    if (row && row.some((c) => c && c.trim() && c.trim() !== "-")) return row;
  }
  return t.rows[0] ?? null;
}

/** Get the first cell of the first body row of T₂, lowercased and
 * trimmed, for the negative-signal check. Returns `""` if T₂ is empty. */
function firstCellText(t: ExtractedTable): string {
  const row = firstBodyRow(t);
  if (!row || row.length === 0) return "";
  return (row[0] || "").trim();
}

/** Check whether T₂'s first body row matches `Table N.` (the negative
 * signal). Spec §"Negative signal": if T₂'s first row matches
 * `/^Table\s+\d+\.?/i`, the score is forced to 0. */
function hasTablePrefix(t2: ExtractedTable): boolean {
  const first = firstCellText(t2);
  if (!first) return false;
  return TABLE_PREFIX_RE.test(first);
}

/**
 * Score 0..1 for whether T₂ is a continuation of T₁. Implements the
 * 4-signal weighted formula from the spec. Returns 0 (forced) when
 * T₂'s first body row matches the `Table N.` prefix.
 *
 * Signals and weights:
 *   - Header match:                          0.4
 *   - Column count match:                    0.2
 *   - X-anchor alignment ≤ X_TOLERANCE_PT:   0.2
 *   - Page distance = 1 AND same tableIndex: 0.2
 *
 * Pure function. Exported for unit tests.
 */
export function scoreMergeCandidate(
  t1: ExtractedTable,
  t2: ExtractedTable,
): number {
  // Negative signal: T₂ starts with "Table N." → score 0.
  // Per the spec, an override UNCONDITIONALLY bypasses the detector
  // (the score is never even computed in that case), so the negative
  // signal applies only in the detector's own scoring path. The caller
  // is responsible for the override consult BEFORE calling this.
  if (hasTablePrefix(t2)) return 0;

  let score = 0;
  if (headersMatch(t1.headers, t2.headers)) score += SCORE_WEIGHT_HEADER;
  const cols1 = t1.headers?.length ?? 0;
  const cols2 = t2.headers?.length ?? 0;
  if (cols1 > 0 && cols1 === cols2) score += SCORE_WEIGHT_COLUMNS;
  if (xAnchorsAligned(t1, t2)) score += SCORE_WEIGHT_X_ANCHOR;
  if (pageDistanceAndIndexMatch(t1, t2)) score += SCORE_WEIGHT_PAGE_DIST;
  return Math.min(MERGE_SCORE_CEILING, score);
}

/** Build the synthetic per-batch pointer (the previous fragment's
 * `(page, tableIndex)`) used to chain a tail fragment to its head
 * BEFORE the row has a real DB id. The persistence layer resolves
 * this to a real id by looking up the head by `(page, table_index)`. */
function makeChainPointer(prev: ExtractedTable): string {
  return `${prev.page}-${prev.tableIndex}`;
}

/** Check whether a `continuesFromId` value is a synthetic per-batch
 * pointer (i.e., matches `<page>-<tableIndex>`). Used by the
 * persistence layer to decide whether to resolve the FK. */
export function isChainPointer(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^\d+-\d+$/.test(value);
}

/** Look up an override for the pair `(T₁, T₂)`. Returns the override
 * or `null`. The match is symmetric — the override table has a
 * `(table_id, other_table_id)` composite index, so we probe both
 * orderings. */
function findOverride(
  t1: ExtractedTable,
  t2: ExtractedTable,
  overrides: MergeOverride[],
): MergeOverride | null {
  if (!t1.id || !t2.id) return null;
  for (const ov of overrides) {
    if (
      (ov.tableId === t1.id && ov.otherTableId === t2.id) ||
      (ov.tableId === t2.id && ov.otherTableId === t1.id)
    ) {
      return ov;
    }
  }
  return null;
}

/**
 * Post-pass: patch `continuesFromId` on tail fragments of multi-page
 * chains. Pure function. Runs after the per-page loop in `extract()`.
 *
 * Walks consecutive `(page, tableIndex)` pairs in ascending order and
 * decides for each pair whether T₂ continues T₁. The decision tree:
 *
 *   1. Look up an override for the pair (matched by DB id, in either
 *      order). If found:
 *        - `force_merge`   → patch T₂.continuesFromId, return.
 *        - `force_unmerge` → clear any prior `continuesFromId` on T₂
 *                            that points at T₁, skip.
 *   2. Otherwise, apply the mode logic:
 *        - `hard`            → merge iff headers match AND no
 *                              `Table N.` prefix on T₂.
 *        - `hard-confidence` → merge iff score > threshold.
 *        - `manual`          → never merge.
 *
 *   3. Chain depth cap at `MAX_CHAIN_DEPTH` (10): a tail beyond that
 *      starts a new chain (the next fragment becomes a fresh head).
 *
 * Tie-break: when scoring, the 0.2 page-distance signal already
 * rewards same `tableIndex` + page distance 1. The function walks
 * pairs in `(page, tableIndex)` order, so the "same `tableIndex`
 * wins" tie-break is implicit in the walk order (consecutive pairs
 * on the same `tableIndex` are evaluated first).
 *
 * `continuesFromId` is set to:
 *   - The previous fragment's `id` if both fragments have an id
 *     (post-INSERT re-read case).
 *   - A synthetic per-batch pointer (`<prevPage>-<prevTableIndex>`)
 *     if the previous fragment has no id (pre-INSERT provider output).
 *     The persistence layer resolves this to a real id.
 *
 * @param tables     Per-page `ExtractedTable[]` from `detectTablesOnPage`.
 * @param mode       One of `"hard" | "hard-confidence" | "manual"`.
 * @param overrides  Per-pair overrides from the DB. The detector must
 *                   consult this list BEFORE calling `scoreMergeCandidate`.
 *                   Pass `[]` for the in-provider call (overrides are
 *                   consulted by the orchestrator post-INSERT).
 * @param threshold  Score threshold for `hard-confidence` mode.
 *                   Defaults to `DEFAULT_MERGE_THRESHOLD` (0.7).
 */
export function mergeTablesAcrossPages(
  tables: ExtractedTable[],
  mode: MergeMode,
  overrides: MergeOverride[],
  threshold: number = DEFAULT_MERGE_THRESHOLD,
): ExtractedTable[] {
  if (!tables || tables.length === 0) return tables;

  // 1. Sort by (page ASC, tableIndex ASC). The walk order is the
  //    tie-break order (same tableIndex + lower page distance = first).
  const sorted = [...tables].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    return a.tableIndex - b.tableIndex;
  });

  // 2. Build a fresh output array. We patch `continuesFromId` on the
  //    sorted order, NOT on the input order — the caller sees the
  //    output in `(page, tableIndex)` order, which matches the DB
  //    `(source_id, page, table_index)` uniqueness ordering.
  const out: ExtractedTable[] = sorted.map((t) => ({ ...t, continuesFromId: null }));

  // 3. Walk consecutive pairs. Maintain the depth of the current chain
  //    starting at the most recent head. When depth reaches the cap,
  //    start a new chain.
  let chainDepth = 0;
  let chainHead: ExtractedTable | null = null;

  for (let i = 0; i < out.length; i++) {
    const cur = out[i];

    if (i === 0) {
      // First fragment: always a head.
      chainHead = cur;
      chainDepth = 1;
      cur.continuesFromId = null;
      continue;
    }

    const prev = out[i - 1];
    if (!chainHead) {
      // Shouldn't happen (we set it on i=0), but defensive.
      chainHead = cur;
      chainDepth = 1;
      continue;
    }

    // Chain depth cap: once we hit MAX_CHAIN_DEPTH, the next pair
    // starts a new chain regardless of score. The current fragment
    // is already a head of the new chain.
    if (chainDepth >= MAX_CHAIN_DEPTH) {
      chainHead = cur;
      chainDepth = 1;
      cur.continuesFromId = null;
      continue;
    }

    // 4. Override consult first (per design §"Per-pair override always
    //    wins over detector"). Match by DB id; if either fragment
    //    has no id (pre-INSERT), the consult is a no-op (the
    //    orchestrator handles overrides post-INSERT).
    const ov = findOverride(prev, cur, overrides);
    if (ov) {
      if (ov.action === "force_merge") {
        cur.continuesFromId = prev.id ?? makeChainPointer(prev);
        chainDepth++;
        continue;
      }
      if (ov.action === "force_unmerge") {
        // Clear any prior continuesFromId on cur that points at prev.
        if (cur.continuesFromId === prev.id || cur.continuesFromId === makeChainPointer(prev)) {
          cur.continuesFromId = null;
        }
        chainHead = cur;
        chainDepth = 1;
        continue;
      }
    }

    // 5. Mode-driven scoring.
    let shouldMerge = false;
    if (mode === "manual") {
      shouldMerge = false;
    } else if (mode === "hard") {
      // Merge iff headers match AND no "Table N." prefix on T₂.
      shouldMerge =
        headersMatch(prev.headers, cur.headers) && !hasTablePrefix(cur);
    } else {
      // "hard-confidence"
      const score = scoreMergeCandidate(prev, cur);
      shouldMerge = score > threshold;
    }

    if (shouldMerge) {
      cur.continuesFromId = prev.id ?? makeChainPointer(prev);
      chainDepth++;
    } else {
      chainHead = cur;
      chainDepth = 1;
      cur.continuesFromId = null;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// TDZ-safe env resolution for merge config (mirrors resolveMode in
// pdfTableExtractor.ts — see the TDZ note in CLAUDE.md).
// ---------------------------------------------------------------------------

const MERGE_MODE_KEY = "__bioprospectingTableMergeMode";
const MERGE_THRESHOLD_KEY = "__bioprospectingTableMergeThreshold";

function resolveMergeMode(): MergeMode {
  const cached = (globalThis as any)[MERGE_MODE_KEY] as MergeMode | undefined;
  if (cached) return cached;
  const raw = (
    process.env[TABLE_MERGE_MODE_ENV] || "hard-confidence"
  ).toLowerCase();
  const mode: MergeMode =
    raw === "hard" || raw === "hard-confidence" || raw === "manual"
      ? (raw as MergeMode)
      : "hard-confidence";
  (globalThis as any)[MERGE_MODE_KEY] = mode;
  return mode;
}

function resolveMergeThreshold(): number {
  const cached = (globalThis as any)[MERGE_THRESHOLD_KEY] as
    | number
    | undefined;
  if (typeof cached === "number") return cached;
  const raw = process.env[TABLE_MERGE_THRESHOLD_ENV];
  const n = raw ? Number(raw) : NaN;
  const t = Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_MERGE_THRESHOLD;
  (globalThis as any)[MERGE_THRESHOLD_KEY] = t;
  return t;
}

/** Public accessors for the merge config. Memoized via `globalThis`
 * so Bun workers do not hit TDZ on `process.env`. */
export function getMergeMode(): MergeMode {
  return resolveMergeMode();
}

export function getMergeThreshold(): number {
  return resolveMergeThreshold();
}

/** Reset the memoized merge config. Test-only — forces the next
 * `getMergeMode()` / `getMergeThreshold()` call to re-read `process.env`. */
export function _resetMergeConfigForTests(): void {
  delete (globalThis as any)[MERGE_MODE_KEY];
  delete (globalThis as any)[MERGE_THRESHOLD_KEY];
}

// ---------------------------------------------------------------------------
// pdfjs text-item shape (just the fields we use)
// ---------------------------------------------------------------------------

type PdfjsTransform = [number, number, number, number, number, number];

type PdfjsTextItem = {
  str: string;
  transform: PdfjsTransform;
  width: number;
  height: number;
  hasEOL?: boolean;
};

type PdfjsTextContent = {
  items: PdfjsTextItem[];
};

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export type LocalProviderDeps = () => Promise<PdfjsLegacyModule>;

export class LocalTableExtractionProvider implements TableExtractionProvider {
  readonly name = "local" as const;

  constructor(private readonly loadPdfjs: LocalProviderDeps) {}

  async extract(
    pdf: Uint8Array,
    _ctx?: { runId?: string; sourceId?: string },
  ): Promise<ExtractedTable[]> {
    const pdfjs = await this.loadPdfjs();

    let doc: any;
    try {
      const loadingTask = pdfjs.getDocument({
        data: pdf,
        useWorkerFetch: false,
        isEvalSupported: false,
        disableFontFace: true,
        verbosity: 0,
      });
      doc = await loadingTask.promise;
    } catch (error) {
      throw new TableExtractionProviderError(
        `pdfjs getDocument failed: ${(error as Error).message ?? String(error)}`,
        error,
      );
    }

    try {
      const tables: ExtractedTable[] = [];
      const numPages: number = doc.numPages;

      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.0 });
        const pageHeightPt = viewport.height;
        const tc: PdfjsTextContent = await page.getTextContent();
        const pageTables = detectTablesOnPage(tc.items, pageNum, pageHeightPt);
        tables.push(...pageTables);
        page.cleanup();
      }

      // Post-pass: link multi-page table fragments via `continuesFromId`.
      // Runs AFTER the per-page loop so it sees the full document. The
      // override consult is a no-op at this layer (rows have no ids yet)
      // — the orchestrator consults overrides post-INSERT in a follow-up
      // pass. The env vars are read via `globalThis` memoization to
      // avoid TDZ in Bun workers (see CLAUDE.md).
      const merged = mergeTablesAcrossPages(
        tables,
        resolveMergeMode(),
        [], // overrides consulted post-INSERT by the orchestrator
        resolveMergeThreshold(),
      );
      return merged;
    } catch (error) {
      throw new TableExtractionProviderError(
        `pdfjs page extraction failed: ${(error as Error).message ?? String(error)}`,
        error,
      );
    } finally {
      try {
        await doc.destroy();
      } catch {
        // ignore
      }
    }
  }

  /**
   * The local detector does not identify figures. Returns `[]` so
   * the orchestrator's figure persistence path is a no-op when this
   * provider is the only one that ran. Figure data only comes from
   * Mistral in v1.
   */
  async extractFigures(_pdf: Uint8Array): Promise<ExtractedFigure[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pure detector (exported for unit tests; no pdfjs dependency)
// ---------------------------------------------------------------------------

export type Cell = {
  text: string;
  bbox: BBox;
  x: number; // canvas coords (origin top-left)
  y: number;
  width: number;
  height: number;
};

export type DetectedRow = {
  // Median y in canvas coords (top-left origin)
  y: number;
  cells: Cell[];
};

/**
 * Run the clustering algorithm on the text items of a single page.
 * `pageHeightPt` is the page height in PDF points (from
 * `page.getViewport({ scale: 1.0 }).height`). Returns the list of
 * detected tables on this page.
 *
 * Exported so the unit tests can drive it with synthetic fixtures
 * without going through pdfjs.
 */
export function detectTablesOnPage(
  items: PdfjsTextItem[],
  page: number,
  pageHeightPt: number,
): ExtractedTable[] {
  // 1. Normalize items → cells in canvas coords (origin top-left).
  const cells = itemsToCells(items, page, pageHeightPt);

  if (cells.length === 0) return [];

  // 2. Group cells into rows by y (tolerance Y_TOLERANCE_PT).
  const rows = groupCellsIntoRows(cells, Y_TOLERANCE_PT);

  if (rows.length === 0) return [];

  // 3. For each row, segment into column cells by x-distance.
  const segmentedRows: DetectedRow[] = rows.map((row) => ({
    y: row.y,
    cells: segmentRowIntoCells(row.cells, X_TOLERANCE_PT),
  }));

  // 4. Find table clusters: groups of consecutive rows that share
  //    approximately the same column anchors. A new table starts
  //    when the next row's column count differs by more than 1, OR
  //    when there's a vertical gap > 3 * (row height).
  const clusters = clusterRowsIntoTables(segmentedRows);

  // 5. For each cluster, decide which rows are header rows, build
  //    ExtractedTable.
  const tables: ExtractedTable[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const tableIndex = i;
    const t = buildTableFromCluster(cluster, page, tableIndex);
    if (t) tables.push(t);
  }

  return tables;
}

// ---------------------------------------------------------------------------
// Step 1: pdfjs items → cells in canvas coords
// ---------------------------------------------------------------------------

function itemsToCells(
  items: PdfjsTextItem[],
  page: number,
  pageHeightPt: number,
): Cell[] {
  const out: Cell[] = [];
  for (const item of items) {
    // Filter out whitespace-only and "spacer" items (PDF.js sometimes
    // emits " " tokens that are just to advance the cursor).
    if (!item.str || item.str.trim() === "") continue;
    const t = item.transform;
    // t = [a, b, c, d, e, f] → horizontal text: e = x (left), f = y (bottom)
    const xPdf = t[4];
    const yPdf = t[5];
    const w = item.width || 0;
    const h = item.height || Math.abs(t[3]) || 0;

    // Convert PDF coords (origin bottom-left) to canvas coords
    // (origin top-left):
    //   canvasY = pageHeight - (pdfY + h)  (item's top edge)
    const yCanvas = pageHeightPt - (yPdf + h);

    out.push({
      text: item.str,
      bbox: { x: xPdf, y: yPdf, w, h, page, units: "pt" },
      x: xPdf,
      y: yCanvas,
      width: w,
      height: h,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 2: cluster cells into rows
// ---------------------------------------------------------------------------

function groupCellsIntoRows(cells: Cell[], yTolerance: number): DetectedRow[] {
  // Sort by y ascending (top-to-bottom in canvas coords).
  const sorted = [...cells].sort((a, b) => a.y - b.y);

  const rows: { y: number; cells: Cell[] }[] = [];
  for (const cell of sorted) {
    const cellMidY = cell.y + cell.height / 2;
    const matched = rows.find((r) => Math.abs(r.y - cellMidY) <= yTolerance);
    if (matched) {
      matched.cells.push(cell);
      // Update the row anchor as the running median of cell midpoints.
      matched.y = median(matched.cells.map((c) => c.y + c.height / 2));
    } else {
      rows.push({ y: cellMidY, cells: [cell] });
    }
  }

  // Sort each row's cells by x (left-to-right).
  for (const r of rows) {
    r.cells.sort((a, b) => a.x - b.x);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Step 3: segment a row into column cells
// ---------------------------------------------------------------------------

/**
 * Group consecutive cells in a row that are within xTolerance of
 * the previous cell's right edge → same logical cell. Returns one
 * Cell per column, with text concatenated (whitespace normalized).
 */
export function segmentRowIntoCells(
  rowCells: Cell[],
  xTolerance: number,
): Cell[] {
  if (rowCells.length === 0) return [];

  const segments: Cell[] = [];
  let current: Cell = { ...rowCells[0] };

  for (let i = 1; i < rowCells.length; i++) {
    const next = rowCells[i];
    const currentRight = current.x + current.width;
    if (next.x - currentRight <= xTolerance) {
      // Same cell — append text, extend bbox.
      const newText = appendText(current.text, next.text);
      const newRight = Math.max(currentRight, next.x + next.width);
      const newLeft = Math.min(current.x, next.x);
      const newTop = Math.min(current.y, next.y);
      const newBottom = Math.max(
        current.y + current.height,
        next.y + next.height,
      );
      current = {
        ...current,
        text: newText,
        x: newLeft,
        y: newTop,
        width: newRight - newLeft,
        height: newBottom - newTop,
        bbox: {
          ...current.bbox,
          x: newLeft,
          w: newRight - newLeft,
          h: newBottom - newTop,
        },
      };
    } else {
      // Push the current segment and start a new one.
      segments.push(normalizeCellText(current));
      current = { ...next };
    }
  }
  segments.push(normalizeCellText(current));
  return segments;
}

function appendText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  // If `a` already ends with a space OR `b` starts with a space,
  // just concatenate; otherwise insert a single space.
  if (a.endsWith(" ") || b.startsWith(" ")) return a + b;
  return `${a} ${b}`;
}

function normalizeCellText(cell: Cell): Cell {
  return { ...cell, text: cell.text.replace(/\s+/g, " ").trim() };
}

// ---------------------------------------------------------------------------
// Step 4: cluster rows into tables
// ---------------------------------------------------------------------------

function clusterRowsIntoTables(rows: DetectedRow[]): DetectedRow[][] {
  if (rows.length === 0) return [];

  const tables: DetectedRow[][] = [];
  let current: DetectedRow[] = [rows[0]];

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const colCountPrev = prev.cells.length;
    const colCountCur = cur.cells.length;
    const yGap = cur.y - prev.y;
    // If the column count differs by more than 1, treat as a new
    // table. Same if the y-gap is much larger than typical row
    // height (indicates an empty line between two tables).
    const typicalRowHeight = median(
      current.flatMap((r) => r.cells.map((c) => c.height)),
    );
    const tooFar = typicalRowHeight > 0 && yGap > 3 * typicalRowHeight;
    if (Math.abs(colCountPrev - colCountCur) > 1 || tooFar) {
      if (current.length >= 1 + MIN_BODY_ROWS) tables.push(current);
      current = [cur];
    } else {
      current.push(cur);
    }
  }
  if (current.length >= 1 + MIN_BODY_ROWS) tables.push(current);
  return tables;
}

// ---------------------------------------------------------------------------
// Step 5: build ExtractedTable from a row cluster
// ---------------------------------------------------------------------------

function buildTableFromCluster(
  rows: DetectedRow[],
  page: number,
  tableIndex: number,
): ExtractedTable | null {
  if (rows.length === 0) return null;

  // Determine header rows. A row is a header candidate when:
  //   - it's one of the first 1-2 rows of the cluster
  //   - every cell is short (<= MAX_HEADER_CELL_CHARS)
  //   - at least one cell contains alphabetic content (rules out
  //     pure-number data rows that happen to be in position 0)
  const headerRowCount = countHeaderRows(rows);
  if (rows.length <= headerRowCount) return null; // no body rows → not a table

  const headerRows = rows.slice(0, headerRowCount);
  const bodyRows = rows.slice(headerRowCount);

  // The "max column count" of the body determines the table width.
  // Each body row is padded with empty cells to match.
  const maxCols = Math.max(...bodyRows.map((r) => r.cells.length), 1);

  const paddedBodyCells: Cell[][] = bodyRows.map((r) => {
    const cells = [...r.cells];
    while (cells.length < maxCols) {
      cells.push({
        text: "-",
        bbox: emptyBbox(page),
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
    }
    return cells;
  });

  // Flatten multi-level headers.
  const flatHeaders = flattenMultiLevelHeaders(headerRows, maxCols);

  // Pad body row widths to match header width (so the table is
  // rectangular in `headers.length` and `rows[i].length`).
  const finalBody = paddedBodyCells.map((cells) => {
    while (cells.length < flatHeaders.length) {
      cells.push({
        text: "-",
        bbox: emptyBbox(page),
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
    }
    return cells.map((c) => c.text || "-");
  });

  // Confidence: per-row chars / (cells * 8), capped at 1.
  const rowConfidences = finalBody.map((row) => {
    const totalChars = row.reduce((n, c) => n + (c === "-" ? 0 : c.length), 0);
    return Math.min(1, totalChars / Math.max(1, row.length * 8));
  });
  const confidence =
    rowConfidences.length === 0
      ? 0
      : rowConfidences.reduce((a, b) => a + b, 0) / rowConfidences.length;

  // Bbox: union of every cell across header + body rows.
  const allCells = [
    ...headerRows.flatMap((r) => r.cells),
    ...paddedBodyCells.flat(),
  ];
  const bbox = unionBbox(allCells, page);

  // Markdown rendering.
  const markdown = renderTableToMarkdown(flatHeaders, finalBody);

  return {
    page,
    tableIndex,
    headers: flatHeaders,
    rows: finalBody,
    bbox,
    confidence,
    markdown,
  };
}

function countHeaderRows(rows: DetectedRow[]): number {
  let count = 0;
  for (let i = 0; i < rows.length && i < MAX_HEADER_ROWS; i++) {
    const row = rows[i];
    if (row.cells.length === 0) break;
    const allShort = row.cells.every(
      (c) => (c.text?.length || 0) <= MAX_HEADER_CELL_CHARS,
    );
    const hasAlpha = row.cells.some((c) => /[A-Za-z]/.test(c.text || ""));
    // Reject rows that look like short data: a row is a header
    // candidate only if it has alphabetic content AND at least one
    // cell contains a non-numeric, non-pure-letter string. This
    // rules out "A, 10" / "B, 20" / "1, 2" type data rows that
    // happen to be at the top of the cluster.
    const hasDescriptiveCell = row.cells.some((c) => {
      const t = (c.text || "").trim();
      if (t.length < 3) return false;
      // Must have at least one letter AND not be a single word of
      // pure letters (which would be like "Control" — actually OK
      // for headers, but "A" is too short). Accept multi-char
      // strings that are at least 60% alphabetic.
      const letters = (t.match(/[A-Za-z]/g) || []).length;
      return letters >= 2;
    });
    if (allShort && hasAlpha && hasDescriptiveCell) count++;
    else break;
  }
  return count;
}

/**
 * Flatten multi-level headers into a single array of cells. If the
 * cluster has 2 header rows, the L2 row's cells are repeated under
 * each L1 cell they belong to. If the L2 row has fewer cells than
 * L1 (a "spans multiple columns" pattern), we distribute the L2
 * cells evenly across the L1 cells.
 */
function flattenMultiLevelHeaders(
  headerRows: DetectedRow[],
  targetLength: number,
): string[] {
  if (headerRows.length === 0) {
    // No headers detected: synthesize empty placeholders.
    return Array.from({ length: targetLength }, () => "");
  }
  if (headerRows.length === 1) {
    const cells = headerRows[0].cells.map((c) => c.text || "");
    while (cells.length < targetLength) cells.push("");
    return cells;
  }
  // Multi-level: 2 rows.
  const l1 = headerRows[0].cells.map((c) => c.text || "");
  const l2 = headerRows[1].cells.map((c) => c.text || "");

  // For each L1 cell, repeat the L2 cells underneath. The simplest
  // robust mapping: distribute L2 cells evenly under the L1 cells
  // (one L2 per L1) when counts match, else repeat L1 cell text
  // and append L2 in order.
  if (l1.length === l2.length) {
    const flat: string[] = [];
    for (let i = 0; i < l1.length; i++) {
      flat.push(l1[i]);
      flat.push(l2[i]);
    }
    while (flat.length < targetLength) flat.push("");
    return flat;
  }

  // Mismatched counts: just concatenate L1 and L2 in order, repeating
  // L1 for the count of L2 cells.
  const flat: string[] = [];
  const l2PerL1 = Math.max(1, Math.round(l2.length / Math.max(1, l1.length)));
  for (let i = 0; i < l1.length; i++) {
    flat.push(l1[i]);
    const slice = l2.slice(i * l2PerL1, (i + 1) * l2PerL1);
    for (const c of slice) flat.push(c);
  }
  while (flat.length < targetLength) flat.push("");
  return flat;
}

// ---------------------------------------------------------------------------
// Bbox helpers
// ---------------------------------------------------------------------------

function emptyBbox(page: number): BBox {
  return { x: 0, y: 0, w: 0, h: 0, page, units: "pt" };
}

function unionBbox(cells: Cell[], page: number): BBox {
  if (cells.length === 0) return emptyBbox(page);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of cells) {
    if (c.width === 0 && c.height === 0) continue;
    const left = c.x;
    const top = c.y;
    const right = c.x + c.width;
    const bottom = c.y + c.height;
    if (left < minX) minX = left;
    if (top < minY) minY = top;
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
  }
  if (!Number.isFinite(minX)) return emptyBbox(page);
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
    page,
    units: "pt",
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering (used by both providers via pdfTablePromptBuilder.ts)
// ---------------------------------------------------------------------------

export function renderTableToMarkdown(
  headers: string[],
  rows: string[][],
): string {
  if (headers.length === 0 && rows.length === 0) return "";
  const lines: string[] = [];
  if (headers.length > 0) {
    lines.push(`| ${headers.join(" | ")} |`);
    lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  }
  for (const row of rows) {
    // Pad row to match header length.
    const padded = [...row];
    while (padded.length < headers.length) padded.push("-");
    lines.push(`| ${padded.join(" | ")} |`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
