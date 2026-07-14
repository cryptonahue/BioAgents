/**
 * Server-side text anchoring: given a PDF and a piece of text, find WHERE
 * it is — page number plus a bounding box.
 *
 * WHY THIS EXISTS
 *
 * The PDF text layer is the only source of geometric truth in a digital
 * PDF. Nothing else knows where anything is: an OCR model returns
 * markdown with no coordinates, and a vision model asked for coordinates
 * will invent them. So every highlight this product draws — a claim's
 * quote today, a table caption and a table cell tomorrow — resolves the
 * same way: take the text, find it in the text layer, read off the box.
 *
 * PARSE ONCE, MATCH MANY
 *
 * The API is an INDEX, not a one-shot call, for two reasons:
 *
 *   1. Correctness. PDF.js TRANSFERS the buffer it is handed to its
 *      worker, which detaches it. Feed the same Uint8Array to a second
 *      getDocument and it throws DataCloneError. A per-text call would
 *      therefore work exactly once per paper — and silently fail for
 *      every claim after the first.
 *   2. Cost. A paper has one text layer and many things to anchor (12
 *      claims today, every table cell tomorrow). Re-parsing the PDF per
 *      needle is absurd; extract the runs once and match against them.
 *
 * `indexPdfText` therefore reads every page's runs up front, destroys the
 * document, and hands back a pure in-memory index. Matching against it
 * touches no PDF machinery at all.
 *
 * COORDINATE CONTRACT
 *
 * Boxes come back in the viewer's contract, verbatim: PDF points, origin
 * at the TOP-LEFT, `y` measured DOWNWARD from the top of the page. This
 * is NOT the PDF's native convention (origin bottom-left) — the flip
 * happens here, once. Getting it backwards is not hypothetical: it
 * shipped, and drew every highlight mirrored through the page height.
 */
import { loadPdfjsLegacy } from "../files/loaders/pdfjsLegacy";
import {
  buildNeedle,
  findAlnumMatchRuns,
  matchFloorFor,
  normalizeToAlnum,
  type MatchableRun,
} from "../../../shared/textAnchor";
import logger from "../../utils/logger";

/**
 * A bbox in the viewer's contract: PDF points, top-left origin, `y`
 * measured downward from the page top.
 */
export interface AnchorBBox {
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
  units: "pt";
}

export interface AnchorResult {
  page: number;
  bbox: AnchorBBox;
}

/**
 * One text run: the string (for the match) plus its geometry in the
 * top-left-origin point space (for the box).
 */
export interface PositionedRun extends MatchableRun {
  x: number;
  yTop: number; // points, measured DOWN from the page top
  w: number;
  h: number;
}

/** A parsed PDF's text layer, ready to be matched against repeatedly. */
export interface PdfTextIndex {
  numPages: number;
  /** Runs per page. `pages[0]` is page 1. */
  pages: PositionedRun[][];
  /**
   * Alphanumeric character count per page. Precomputed because the match
   * floor scales with the haystack, and the haystack is the SUM over the
   * pages a search is about to cover — see `matchFloorFor`.
   */
  pageAlnumLength: number[];
}

// The shape PDF.js reports for a text item. `transform` is
// [a, b, c, d, e, f] where e,f are the x,y of the BASELINE in PDF points
// (origin bottom-left) and d is the vertical scale = font height.
interface PdfTextItem {
  str?: string;
  width?: number;
  transform?: number[];
}

/**
 * Convert PDF.js text items into runs in the top-left-origin point space.
 *
 * PDF.js reports the baseline y measured UP from the page bottom. The top
 * of a run, measured DOWN from the page top, is therefore
 * `pageHeight - baseline - fontHeight`.
 */
function runsFromItems(
  items: PdfTextItem[],
  pageHeightPt: number,
): PositionedRun[] {
  const runs: PositionedRun[] = [];
  for (const item of items) {
    if (!item || !item.str || !item.str.trim()) continue;
    if (!Array.isArray(item.transform) || item.transform.length < 6) continue;
    // `transform[3]` is the vertical scale, i.e. the font height in points.
    // Do NOT use hypot(a, d): horizontal text is axis-aligned, so that
    // double-counts by sqrt(2).
    const fontHeight = Math.abs(item.transform[3] || item.transform[0] || 0);
    if (fontHeight <= 0) continue;
    runs.push({
      str: item.str,
      x: item.transform[4],
      yTop: pageHeightPt - item.transform[5] - fontHeight,
      w: item.width || 0,
      h: fontHeight,
    });
  }
  return runs;
}

/**
 * Union the runs a match spans into one box. Everything is already in the
 * top-left-origin point space, so this is a plain min/max — no flip, no
 * scale.
 */
function bboxFromRuns(
  runs: PositionedRun[],
  startRun: number,
  endRun: number,
  page: number,
): AnchorBBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = startRun; i <= endRun; i++) {
    const r = runs[i];
    if (!r) continue;
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.yTop);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.yTop + r.h);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  // A zero-size box is not a highlight, it is a dot in the corner. Refuse
  // it — that is literally what the Mistral tables persisted.
  if (maxX <= minX || maxY <= minY) return null;
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
    page,
    units: "pt",
  };
}

/**
 * Read every page's text runs once and return an in-memory index.
 *
 * The input buffer is COPIED before it reaches PDF.js, which would
 * otherwise transfer (and detach) the caller's array — leaving them
 * holding an empty buffer they may still need.
 */
export async function indexPdfText(pdf: Uint8Array): Promise<PdfTextIndex> {
  const pdfjs = await loadPdfjsLegacy();
  const doc = await pdfjs.getDocument({
    // .slice() — PDF.js detaches what it is given; never hand it the
    // caller's buffer.
    data: pdf.slice(),
    useSystemFonts: false,
    disableFontFace: true,
  }).promise;

  try {
    const pages: PositionedRun[][] = [];
    const pageAlnumLength: number[] = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      try {
        const pageHeightPt = page.getViewport({ scale: 1.0 }).height;
        const tc = await page.getTextContent();
        const runs = runsFromItems(
          (tc.items || []) as PdfTextItem[],
          pageHeightPt,
        );
        pages.push(runs);
        pageAlnumLength.push(
          runs.reduce((n, r) => n + normalizeToAlnum(r.str).length, 0),
        );
      } finally {
        page.cleanup();
      }
    }
    return { numPages: doc.numPages, pages, pageAlnumLength };
  } finally {
    try {
      await doc.destroy();
    } catch {
      // ignore
    }
  }
}

export interface AnchorOptions {
  /**
   * Search only this page. Omit to scan every page and return the first
   * hit — safe because the 60-character floor makes a hit unambiguous.
   */
  page?: number;
}

/**
 * Find `text` in an already-parsed index. Synchronous and cheap: call it
 * once per claim, per caption, per cell.
 *
 * A null return is a first-class answer, not a failure. The caller MUST
 * degrade honestly — the viewer has a `text-only` badge for exactly this.
 * Never synthesize a box you did not verify: a wrong highlight does not
 * cost you one highlight, it costs the credibility of all of them.
 */
export function anchorInIndex(
  index: PdfTextIndex,
  text: string,
  options: AnchorOptions = {},
): AnchorResult | null {
  const first = options.page
    ? Math.min(Math.max(1, options.page), index.numPages)
    : 1;
  const last = options.page ? first : index.numPages;

  // The floor scales with the HAYSTACK — the text this call is about to
  // cover, summed over every page in scope. The match itself runs page by
  // page, but the risk of a spurious hit comes from trying all of them, so
  // scoping to one page earns a shorter (still safe) anchor. That is what
  // lets a 30-character table row anchor inside a table we have already
  // located, while the same row would rightly be refused document-wide.
  let haystack = 0;
  for (let p = first; p <= last; p++) haystack += index.pageAlnumLength[p - 1] ?? 0;
  const floor = matchFloorFor(haystack);

  const needle = buildNeedle(text, floor);
  // Too little text to anchor confidently at this scale. Refuse, don't guess.
  if (!needle) return null;

  for (let pageNum = first; pageNum <= last; pageNum++) {
    const runs = index.pages[pageNum - 1];
    if (!runs || runs.length === 0) continue;
    const match = findAlnumMatchRuns(runs, needle, floor);
    if (!match) continue;
    const bbox = bboxFromRuns(runs, match.startRun, match.endRun, pageNum);
    if (!bbox) continue;
    return { page: pageNum, bbox };
  }
  return null;
}

/**
 * Convenience for anchoring a SINGLE text. Anything anchoring more than
 * one thing in the same PDF must use `indexPdfText` + `anchorInIndex` and
 * reuse the index — see the note at the top of this file.
 */
export async function anchorTextInPdf(
  pdf: Uint8Array,
  text: string,
  options: AnchorOptions = {},
): Promise<AnchorResult | null> {
  try {
    const index = await indexPdfText(pdf);
    return anchorInIndex(index, text, options);
  } catch (error) {
    // A malformed or encrypted PDF is a miss, not a crash: the caller
    // degrades to text-only and the ingestion run carries on.
    logger.warn({ err: error }, "text_anchor_failed");
    return null;
  }
}
