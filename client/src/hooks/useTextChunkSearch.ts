/**
 * useTextChunkSearch — PDF.js text-layer search hook.
 *
 * The viewer uses this hook to find a chunk / verbatim quote in the
 * PDF text layer when the fact has no stored bbox (the text-chunk
 * fallback per the spec's "Text-Chunk Fallback And Badges"
 * requirement). The result is a bbox in PDF point space the
 * BboxOverlay can position, or `null` when the text is not found
 * (graceful miss).
 *
 * Two search modes, chosen by the `page` argument:
 *   - `page` is a number → search ONLY that page. Used by the
 *     lightbox, where the fact carries a known page.
 *   - `page` is null/undefined → search EVERY page in order and
 *     return the first hit. Used by the dedicated ViewerPage when a
 *     claim carries a verbatim `quote` but no resolvable page (the
 *     in-process ingestion path does not persist evidence-chunk
 *     rows, so the claim→chunk→page link is unavailable; the quote
 *     alone drives the highlight). The returned bbox carries the
 *     page it was found on, so the viewer can jump to it.
 *
 * Matching strategy — alphanumeric stream:
 *   The PDF text layer and the stored quote differ in whitespace,
 *   punctuation, ligatures and, critically, line-break hyphenation
 *   ("commen-\nsal" → two runs). Matching the raw text is fragile,
 *   which previously forced a fall-back to very short prefixes that
 *   matched spuriously on the wrong page (e.g. a 20-char prefix in a
 *   243-page book). Instead we reduce BOTH sides to a lowercase
 *   alphanumeric-only stream and require a long match (>= 60 chars).
 *   A 60-character verbatim alphanumeric run is effectively unique in
 *   a document, so the first page that contains it IS the right page
 *   and the highlight lands on real text.
 *
 * Per-page implementation:
 *   1. Call `page.getTextContent()` and build one run per text item,
 *      recording its geometry (for the bbox) and its characters (for
 *      the alphanumeric stream + char→run map).
 *   2. Find the longest prefix of the needle (down to the 60-char
 *      floor) that appears in the page's alphanumeric stream.
 *   3. The bbox is the union of every run the match window touches,
 *      in PDF point space (bottom-left origin), carrying `page`.
 */
import { useEffect, useState } from "preact/hooks";

import { BBox, PDFJS_RENDER_SCALE } from "../lib/bbox";
import {
  type PdfDocumentProxy,
  type PdfPageProxy,
} from "../lib/pdfjs";

// How many alphanumeric characters of the quote we match on, and the
// minimum contiguous match we accept. The floor is what kills
// spurious matches: a 60-char verbatim alphanumeric span is unique.
const NEEDLE_MAX_ALNUM = 140;
const MATCH_FLOOR_ALNUM = 60;
// A short raw snippet echoed back for debug visibility.
const SNIPPET_CHARS = 80;

export interface TextChunkSearchResult {
  // null = graceful miss (chunk text not found). The caller
  // surfaces the text-only badge when this is the case.
  bbox: BBox | null;
  // Echoes the snippet that was searched, trimmed to the first 80
  // chars. Used by the lightbox status line for debug visibility.
  snippet: string;
}

interface UseTextChunkSearchArgs {
  doc: PdfDocumentProxy | null;
  // A page number searches only that page; null/undefined searches
  // every page and returns the first hit.
  page: number | null | undefined;
  chunkContent: string | null | undefined;
  // The hook auto-skips when this is false (e.g., the viewer is
  // still loading the PDF).
  enabled?: boolean;
}

/** One text run from the PDF text layer: its string plus the canvas
 *  geometry needed to build a bbox. `str` alone is enough for the
 *  match; the geometry is only read for the bbox union. */
export interface TextRun {
  str: string;
  x: number;          // canvas px, left edge
  yTopCanvas: number; // canvas px, top edge
  fontHeight: number; // canvas px
  width: number;      // canvas px
}

/**
 * Reduce text to a lowercase alphanumeric-only stream. Strips
 * whitespace, punctuation, hyphens and case so the PDF text layer
 * and the stored quote compare on letters/digits alone.
 */
export function normalizeToAlnum(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      out += String.fromCharCode(code + 32); // A-Z → a-z
    } else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      out += text[i]; // a-z, 0-9
    }
    // everything else (space, punctuation, hyphen, ligature glyphs) dropped
  }
  return out;
}

/**
 * Locate `needleAlnum` (already alphanumeric-normalized) inside a
 * list of runs and return the inclusive run-index range the match
 * spans, or null on a miss. Pure over `runs[i].str` — unit-tested
 * with synthetic runs, no PDF required.
 *
 * The longest prefix that still matches wins, down to the floor;
 * this tolerates a quote whose tail diverges from the page text
 * while still requiring a long, unambiguous anchor.
 */
export function findAlnumMatchRuns(
  runs: Array<{ str: string }>,
  needleAlnum: string,
): { startRun: number; endRun: number } | null {
  if (!needleAlnum) return null;

  // Alphanumeric stream over all runs + a map from each stream
  // index back to the run it came from.
  let fullAlnum = "";
  const alnumToRun: number[] = [];
  for (let i = 0; i < runs.length; i++) {
    const s = runs[i].str;
    for (let k = 0; k < s.length; k++) {
      const code = s.charCodeAt(k);
      let ch = "";
      if (code >= 65 && code <= 90) ch = String.fromCharCode(code + 32);
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57))
        ch = s[k];
      if (ch) {
        fullAlnum += ch;
        alnumToRun.push(i);
      }
    }
  }
  if (!fullAlnum) return null;

  const floor = Math.min(MATCH_FLOOR_ALNUM, needleAlnum.length);
  const maxLen = Math.min(NEEDLE_MAX_ALNUM, needleAlnum.length);
  if (maxLen < floor) return null;

  let matchIdx = -1;
  let matchedLen = 0;
  for (let len = maxLen; len >= floor; len -= 8) {
    const idx = fullAlnum.indexOf(needleAlnum.slice(0, len));
    if (idx !== -1) {
      matchIdx = idx;
      matchedLen = len;
      break;
    }
  }
  if (matchIdx === -1) return null;

  const startRun = alnumToRun[matchIdx];
  const endRun =
    alnumToRun[Math.min(matchIdx + matchedLen - 1, alnumToRun.length - 1)];
  if (startRun == null || endRun == null) return null;
  return { startRun, endRun };
}

/**
 * Union the bboxes of runs [startRun, endRun] and convert to PDF
 * point space (bottom-left origin). Pure over run geometry —
 * unit-testable. Returns null on degenerate geometry.
 */
export function bboxFromRunRange(
  runs: TextRun[],
  pageHeightPt: number,
  startRun: number,
  endRun: number,
  pageNum: number,
): BBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = startRun; i <= endRun; i++) {
    const r = runs[i];
    if (!r) continue;
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.yTopCanvas);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.yTopCanvas + r.fontHeight);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  if (maxX <= minX || maxY <= minY) return null;

  const x = minX / PDFJS_RENDER_SCALE;
  const w = (maxX - minX) / PDFJS_RENDER_SCALE;
  const h = (maxY - minY) / PDFJS_RENDER_SCALE;
  // Canvas is top-left origin; the bbox contract is bottom-left in
  // PDF points, with `y` the BOTTOM of the rect. Flip both edges and
  // take the lower.
  const yTopInPdf = pageHeightPt - maxY / PDFJS_RENDER_SCALE;
  const yBottomInPdf = pageHeightPt - minY / PDFJS_RENDER_SCALE;
  const y = Math.min(yTopInPdf, yBottomInPdf);
  return { x, y, w, h, page: pageNum, units: "pt" };
}

/**
 * Search a single, already-loaded PDF page for `needleAlnum` and
 * return the matching window's bbox in PDF point space, or null on a
 * miss.
 */
async function findSnippetOnPage(
  pageProxy: PdfPageProxy,
  needleAlnum: string,
  pageNum: number,
): Promise<BBox | null> {
  const text = await pageProxy.getTextContent();

  const items = (text.items || []) as Array<{
    str?: string;
    transform?: number[];
    width?: number;
    height?: number;
  }>;

  // Build one run per text item, in CANVAS pixel space (top-left
  // origin) so the bbox union is a straightforward min/max.
  const runs: TextRun[] = [];
  for (const item of items) {
    if (!item || !item.str || !item.str.trim()) continue;
    if (!Array.isArray(item.transform) || item.transform.length < 6) continue;
    // For horizontal text the transform is
    // [fontSize, 0, 0, fontSize, x, y]. `transform[3]` is the
    // vertical scale = font height in PDF points (hypot(a,d) would
    // double-count on axis-aligned text).
    const fontHeightPt = Math.abs(item.transform[3] || item.transform[0] || 0);
    if (fontHeightPt <= 0) continue;
    const xCanvas = item.transform[4] * PDFJS_RENDER_SCALE;
    const widthCanvas = (item.width || 0) * PDFJS_RENDER_SCALE;
    const fontHeightCanvas = fontHeightPt * PDFJS_RENDER_SCALE;
    // PDF y is the baseline (bottom of the run). The TOP in canvas
    // coords is (pageHeight - y_baseline) * scale - fontHeightCanvas.
    const yBaselineCanvas =
      (pageProxy.view[3] - item.transform[5]) * PDFJS_RENDER_SCALE;
    const yTopCanvas = yBaselineCanvas - fontHeightCanvas;
    runs.push({
      str: item.str,
      x: xCanvas,
      yTopCanvas,
      fontHeight: fontHeightCanvas,
      width: widthCanvas,
    });
  }

  const match = findAlnumMatchRuns(runs, needleAlnum);
  if (!match) return null;

  const pageHeightPt = pageProxy.view[3] - pageProxy.view[1];
  return bboxFromRunRange(
    runs,
    pageHeightPt,
    match.startRun,
    match.endRun,
    pageNum,
  );
}

export function useTextChunkSearch({
  doc,
  page,
  chunkContent,
  enabled = true,
}: UseTextChunkSearchArgs): {
  result: TextChunkSearchResult | null;
  isSearching: boolean;
} {
  const [result, setResult] = useState<TextChunkSearchResult | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!enabled || !doc || !chunkContent) {
        if (!cancelled) setResult(null);
        return;
      }
      const snippet = chunkContent.slice(0, SNIPPET_CHARS).trim();
      // Match on up to NEEDLE_MAX_ALNUM alphanumeric chars of the
      // quote (draw from a generous raw prefix so punctuation/spaces
      // don't starve the needle).
      const needleAlnum = normalizeToAlnum(
        chunkContent.slice(0, NEEDLE_MAX_ALNUM * 3),
      ).slice(0, NEEDLE_MAX_ALNUM);
      if (needleAlnum.length < MATCH_FLOOR_ALNUM) {
        // Too little text to anchor a confident match.
        if (!cancelled) setResult({ bbox: null, snippet });
        return;
      }

      setIsSearching(true);
      try {
        let bbox: BBox | null = null;

        if (page) {
          // Known-page mode: search only the resolved page.
          const target = Math.min(Math.max(1, page), doc.numPages);
          const pageProxy: PdfPageProxy = await doc.getPage(target);
          if (cancelled) return;
          bbox = await findSnippetOnPage(pageProxy, needleAlnum, target);
        } else {
          // All-pages mode: scan in order, stop at the first hit. The
          // 60-char floor makes that first hit unambiguous, so early
          // exit is safe; `cancelled` lets a newer click abort.
          for (let p = 1; p <= doc.numPages; p++) {
            if (cancelled) return;
            const pageProxy: PdfPageProxy = await doc.getPage(p);
            if (cancelled) return;
            const hit = await findSnippetOnPage(pageProxy, needleAlnum, p);
            if (hit) {
              bbox = hit;
              break;
            }
          }
        }

        if (!cancelled) {
          setResult({ bbox, snippet });
          setIsSearching(false);
        }
      } catch (err) {
        // Silent miss: PDF.js may fail on encrypted or malformed
        // pages. The caller falls back to the text-only badge.
        console.warn("[useTextChunkSearch] search failed", err);
        if (!cancelled) {
          setResult({ bbox: null, snippet });
          setIsSearching(false);
        }
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [doc, page, chunkContent, enabled]);

  return { result, isSearching };
}
