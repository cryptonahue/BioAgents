/**
 * useTextChunkSearch — PDF.js text-layer search hook.
 *
 * The viewer uses this hook to find the first 80 characters of a
 * chunk on the resolved page when the fact has no bbox (the
 * text-chunk fallback per the spec's "Text-Chunk Fallback And
 * Badges" requirement). The result is a bbox in PDF point space
 * the BboxOverlay can position, or `null` when the text is not on
 * the page (graceful miss).
 *
 * Implementation:
 *   1. Load the page (if not already loaded).
 *   2. Call `page.getTextContent()` and concatenate the visible
 *      text runs. Track each run's `transform` (x, y, width,
 *      height) so we can build a bbox for the matching window.
 *   3. Sliding window: find the first index where the first 80
 *      characters of the chunk appear in the concatenated text.
 *   4. If the index maps to a single text run, the bbox is that
 *      run's geometry. If it spans runs, the bbox is the union of
 *      every run that contributes characters inside the window.
 *   5. The bbox is in PDF point space (bottom-left origin) and
 *      carries `page` so the BboxOverlay can position it.
 *
 * Why not use PDF.js's `PDFFindController` directly?
 *   - `PDFFindController` mutates a text-layer DOM and matches by
 *     exact string equality. We need a *bbox* (not a highlight in
 *     a specific element) and a *sliding* search (we tolerate
 *     whitespace differences). A 60-line search over the raw text
 *     content is more direct and easier to test.
 */
import { useEffect, useState } from "preact/hooks";

import { BBox, PDFJS_RENDER_SCALE } from "../lib/bbox";
import {
  type PdfDocumentProxy,
  type PdfPageProxy,
} from "../lib/pdfjs";

const CHUNK_SEARCH_CHARS = 80;

export interface TextChunkSearchResult {
  // null = graceful miss (chunk text not on this page). The caller
  // surfaces the text-only badge when this is the case.
  bbox: BBox | null;
  // Echoes the snippet that was searched, trimmed to the first 80
  // chars. Used by the lightbox status line for debug visibility.
  snippet: string;
}

interface UseTextChunkSearchArgs {
  doc: PdfDocumentProxy | null;
  page: number | null | undefined;
  chunkContent: string | null | undefined;
  // The hook auto-skips when this is true (e.g., the viewer is
  // still loading the PDF).
  enabled?: boolean;
}

/**
 * Normalize text for fuzzy matching: collapse whitespace, strip
 * punctuation differences that PDF.js introduces from layout
 * (soft hyphens, line-break hyphens, etc.). The match is anchored
 * to a sliding window so the helper can compute a bbox that
 * covers the run or union of runs the window touches.
 */
function normalizeForSearch(text: string): string {
  return text
    .replace(/[ \s]+/g, " ")
    .replace(/[‐-―]/g, "-")
    .trim();
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
      if (!enabled || !doc || !page || !chunkContent) {
        if (!cancelled) setResult(null);
        return;
      }
      const snippet = chunkContent.slice(0, CHUNK_SEARCH_CHARS).trim();
      if (!snippet) {
        if (!cancelled) setResult(null);
        return;
      }

      setIsSearching(true);
      try {
        const target = Math.min(Math.max(1, page), doc.numPages);
        const pageProxy: PdfPageProxy = await doc.getPage(target);
        if (cancelled) return;

        const text = await pageProxy.getTextContent();
        if (cancelled) return;

        const items = (text.items || []) as Array<{
          str?: string;
          transform?: number[];
          width?: number;
          height?: number;
        }>;

        // Build a flat list of (runText, runGeometry) tuples.
        // All coordinates are in CANVAS pixel space (top-left
        // origin) so the bbox union is straightforward.
        interface Run {
          str: string;
          x: number;
          yTopCanvas: number; // canvas-coords y of the TOP of the run
          fontHeight: number; // canvas pixels
          width: number;      // canvas pixels
        }
        const runs: Run[] = [];
        for (const item of items) {
          if (!item || !item.str || !item.str.trim()) continue;
          if (!Array.isArray(item.transform) || item.transform.length < 6) continue;
          // For horizontal text the transform is
          // [fontSize, 0, 0, fontSize, x, y]. We use `transform[3]`
          // (the vertical scale) as the font height in PDF points.
          // Using `hypot(a, d)` would double-count because the
          // horizontal text is axis-aligned — a==d==fontSize and
          // the bbox of the unit vector is sqrt(2) * fontSize,
          // which is wrong.
          const fontHeightPt = Math.abs(item.transform[3] || item.transform[0] || 0);
          if (fontHeightPt <= 0) continue;
          const xCanvas = item.transform[4] * PDFJS_RENDER_SCALE;
          const widthCanvas = (item.width || 0) * PDFJS_RENDER_SCALE;
          const fontHeightCanvas = fontHeightPt * PDFJS_RENDER_SCALE;
          // PDF y is the baseline (bottom of the run). The TOP
          // of the run in canvas coords is therefore
          // (pageHeight - y_baseline) * scale - fontHeightCanvas.
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

        // Concat the normalized strings with a single space
        // between runs (PDF.js emits separate items whenever
        // there's a layout break). Track which run each
        // character belongs to so we can resolve a match back
        // to a run index for the bbox computation.
        const parts: string[] = [];
        const charToRun: number[] = [];
        runs.forEach((run, i) => {
          const norm = normalizeForSearch(run.str);
          if (!norm) return;
          for (let k = 0; k < norm.length; k++) {
            charToRun.push(i);
          }
          parts.push(norm);
        });
        const fullText = parts.join(" ");
        // The needle is the first 80 chars of the chunk. We also
        // try a shorter, more robust prefix so a layout break in
        // the page text doesn't hide the match.
        const normalizedSnippet = normalizeForSearch(snippet);
        if (!normalizedSnippet || !fullText) {
          if (!cancelled) {
            setResult({ bbox: null, snippet });
            setIsSearching(false);
          }
          return;
        }

        // Find the first window. We use the longest needle that
        // still finds a hit, capped at 80 chars (the spec's
        // contract).
        let matchIdx = -1;
        let matchedNeedleLength = 0;
        for (let len = Math.min(80, normalizedSnippet.length); len >= 20; len -= 4) {
          const candidate = normalizedSnippet.slice(0, len);
          const idx = fullText.indexOf(candidate);
          if (idx !== -1) {
            matchIdx = idx;
            matchedNeedleLength = len;
            break;
          }
        }
        if (matchIdx === -1) {
          if (!cancelled) {
            setResult({ bbox: null, snippet });
            setIsSearching(false);
          }
          return;
        }

        // Resolve the run indices the window touches.
        const startChar = matchIdx;
        const endChar = matchIdx + matchedNeedleLength - 1;
        const startRun = charToRun[Math.min(startChar, charToRun.length - 1)];
        const endRun = charToRun[Math.min(endChar, charToRun.length - 1)];

        if (startRun == null || endRun == null) {
          if (!cancelled) {
            setResult({ bbox: null, snippet });
            setIsSearching(false);
          }
          return;
        }

        // Union the bboxes of every run in [startRun, endRun].
        // All coordinates are in canvas pixel space (top-left
        // origin) so the union is a simple min/max reduction.
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

        if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
          if (!cancelled) {
            setResult({ bbox: null, snippet });
            setIsSearching(false);
          }
          return;
        }

        // Convert from canvas pixels back to PDF point space (the
        // viewer's contract). The page.height in points is taken
        // from `pageProxy.view[3] - pageProxy.view[1]`.
        const pageHeightPt = pageProxy.view[3] - pageProxy.view[1];
        const x = minX / PDFJS_RENDER_SCALE;
        const w = (maxX - minX) / PDFJS_RENDER_SCALE;
        const h = (maxY - minY) / PDFJS_RENDER_SCALE;
        // The bbox contract uses bottom-left origin in PDF points:
        // the returned `y` is the BOTTOM of the bbox (lowest y in
        // PDF coords). Canvas is top-left origin so we flip.
        // In our canvas space, minY is the TOP of the run and
        // maxY is the BOTTOM of the run. Converting each to PDF
        // and taking the lower of the two gives us the PDF-bottom
        // of the bbox.
        const yTopInCanvas = minY;
        const yBottomInCanvas = maxY;
        const yTopInPdf = pageHeightPt - yBottomInCanvas / PDFJS_RENDER_SCALE;
        const yBottomInPdf = pageHeightPt - yTopInCanvas / PDFJS_RENDER_SCALE;
        const y = Math.min(yTopInPdf, yBottomInPdf);
        const bbox: BBox = {
          x,
          y,
          w,
          h,
          page: target,
          units: "pt",
        };

        if (!cancelled) {
          setResult({ bbox, snippet });
          setIsSearching(false);
        }
      } catch (err) {
        // Silent miss: PDF.js may fail on encrypted or malformed
        // pages. The lightbox falls back to the text-only badge.
        console.warn("[useTextChunkSearch] search failed", err);
        if (!cancelled) {
          setResult({ bbox: null, snippet: chunkContent?.slice(0, CHUNK_SEARCH_CHARS) ?? "" });
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
