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
  normalizeToAlnum,
  MATCH_FLOOR_MIN,
  NEEDLE_MAX_ALNUM,
  PREFIX_STEP,
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
  /**
   * How much of the quote actually turned up in the PDF, and how much we
   * were looking for. A verbatim quote matches in full; a paraphrased one
   * matches only its opening words, if that.
   *
   * This is not bookkeeping — it is the difference between evidence and a
   * fabrication, and nothing else in the system can tell them apart.
   */
  matchedChars: number;
  needleChars: number;
}

/**
 * The fraction of a quote that must turn up in the PDF for its box to mean
 * anything.
 *
 * The extractor is told to return "a short verbatim snippet". On this corpus
 * it mostly does — and once it did not, inventing "Protease activity was
 * determined by clear zones on milk agar", a sentence that is not in the
 * paper. Its opening words ARE, though, so a search that keeps shortening its
 * prefix until something matches will happily anchor a fabricated citation to
 * the two real words it starts with, and report success.
 *
 * A box drawn over 20% of a quote is not evidence for that quote. It is a
 * highlight in roughly the right neighbourhood, dressed up as a citation —
 * which is exactly the kind of confident wrongness that costs more trust than
 * showing nothing at all.
 *
 * So demand that most of the quote be real. What survives is an anchor you can
 * stand behind; what does not is a fabrication we now detect instead of
 * decorate.
 */
const MIN_FIDELITY = 0.6;

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
   * The alphanumeric stream of each page, and the map from each position in
   * it back to the run it came from.
   *
   * Precomputed because uniqueness is checked ACROSS THE DOCUMENT: to know
   * that a quote appears exactly once we have to count it on every page, and
   * rebuilding each page's stream per quote — for dozens of quotes — would
   * turn a linear job into a quadratic one.
   */
  pageAlnum: string[];
  pageAlnumToRun: number[][];
  /** Convenience: `pageAlnum[i].length`. */
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
    const pageAlnum: string[] = [];
    const pageAlnumToRun: number[][] = [];
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

        // Alphanumeric stream + the map back to runs. Crossing run boundaries
        // is what makes hyphenation and layout breaks invisible to the match.
        let alnum = "";
        const toRun: number[] = [];
        for (let i = 0; i < runs.length; i++) {
          const norm = normalizeToAlnum(runs[i].str);
          alnum += norm;
          for (let k = 0; k < norm.length; k++) toRun.push(i);
        }
        pageAlnum.push(alnum);
        pageAlnumToRun.push(toRun);
        pageAlnumLength.push(alnum.length);
      } finally {
        page.cleanup();
      }
    }
    return {
      numPages: doc.numPages,
      pages,
      pageAlnum,
      pageAlnumToRun,
      pageAlnumLength,
    };
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

  // UNIQUENESS IS CHECKED ACROSS THE WHOLE SCOPE, NOT PAGE BY PAGE.
  //
  // Page-local uniqueness is not uniqueness. A quote that appears once on
  // page 3 and once on page 7 is unique on each and ambiguous in the
  // document, and a page-by-page scan taking the first hit would anchor it
  // to page 3 with total confidence and no idea it was wrong.
  //
  // Counting across the scope also lets the floor collapse. It only ever
  // existed as a PROXY for uniqueness — and a bad one. Three real facts on
  // this corpus quote strain IDs like "BPR-16 (B. velezensis, CBS#148295)":
  // twenty-five characters, appearing EXACTLY ONCE in the paper, and the
  // floor threw all three away before uniqueness was ever consulted. They
  // could not have been more unambiguous. Once we can ask the real question,
  // asking the proxy first is just a way of getting it wrong.
  const needle = buildNeedle(text, MATCH_FLOOR_MIN);
  // Below the minimum, a unique hit stops meaning anything. Refuse, don't
  // guess.
  if (!needle) return null;

  const maxLen = Math.min(NEEDLE_MAX_ALNUM, needle.length);
  for (let len = maxLen; len >= MATCH_FLOOR_MIN; len -= PREFIX_STEP) {
    const candidate = needle.slice(0, len);

    // Count every occurrence across every page in scope.
    let hitPage = -1;
    let hitIdx = -1;
    let occurrences = 0;
    for (let pageNum = first; pageNum <= last && occurrences < 2; pageNum++) {
      const hay = index.pageAlnum[pageNum - 1];
      if (!hay) continue;
      let idx = hay.indexOf(candidate);
      while (idx !== -1) {
        occurrences++;
        if (occurrences === 1) {
          hitPage = pageNum;
          hitIdx = idx;
        } else break; // two is already too many
        idx = hay.indexOf(candidate, idx + 1);
      }
    }

    // Shortening can only ever find MORE places, never fewer. So once a
    // prefix is ambiguous, every shorter one is too, and there is nothing
    // left to try.
    if (occurrences > 1) return null;
    if (occurrences === 0) continue; // not here at this length; try shorter

    // Found it — but is it really the QUOTE, or just the words the quote
    // happens to start with? A fabricated sentence borrows its opening from
    // the paper; only a verbatim one keeps going.
    if (len < needle.length * MIN_FIDELITY) return null;

    const runs = index.pages[hitPage - 1];
    const toRun = index.pageAlnumToRun[hitPage - 1];
    const startRun = toRun[hitIdx];
    const endRun = toRun[Math.min(hitIdx + len - 1, toRun.length - 1)];
    if (startRun == null || endRun == null) continue;

    const bbox = bboxFromRuns(runs, startRun, endRun, hitPage);
    if (!bbox) continue;
    return {
      page: hitPage,
      bbox,
      matchedChars: len,
      needleChars: needle.length,
    };
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
