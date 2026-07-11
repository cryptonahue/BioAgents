/**
 * useTextChunkHighlight — resolve a highlight for a text chunk that
 * has no stored bbox.
 *
 * Wraps `useTextChunkSearch` and maps its result to the (bbox, type)
 * pair the EvidenceViewer expects:
 *   - hit  → `type: "chunk"` + the point-space rect (yellow overlay)
 *   - miss → `type: "text-only"` (the viewer shows the
 *            "provenance: text-only" badge, no overlay)
 *   - idle / still searching → both null (nothing drawn yet)
 *
 * Shared by the EvidenceLightbox (single-fact provenance) and the
 * dedicated ViewerPage (sidebar claim clicks) so the search→bbox
 * mapping lives in exactly one place. The returned rect is in PDF
 * point space; the overlay re-scales it via `bboxToPixels(bbox,
 * scale)`, so callers MUST NOT pre-multiply by any scale.
 */
import { ProvenanceType } from "./useProvenance";
import { useTextChunkSearch } from "./useTextChunkSearch";
import { BBox } from "../lib/bbox";
import { type PdfDocumentProxy } from "../lib/pdfjs";

interface UseTextChunkHighlightArgs {
  doc: PdfDocumentProxy | null;
  page: number | null | undefined;
  content: string | null | undefined;
  // Auto-skips when false (e.g., the lightbox is closed or the fact
  // already has a stored bbox and needs no search).
  enabled?: boolean;
}

export function useTextChunkHighlight({
  doc,
  page,
  content,
  enabled = true,
}: UseTextChunkHighlightArgs): {
  bbox: BBox | null;
  type: ProvenanceType | null;
  isSearching: boolean;
} {
  const active = Boolean(enabled && doc && page && content);
  // The hook is always called (React rules); `enabled: active` makes
  // it a no-op when there is nothing to search.
  const { result, isSearching } = useTextChunkSearch({
    doc,
    page,
    chunkContent: content,
    enabled: active,
  });

  if (!active) return { bbox: null, type: null, isSearching: false };
  if (isSearching || !result) return { bbox: null, type: null, isSearching };
  if (result.bbox) return { bbox: result.bbox, type: "chunk", isSearching };
  // Graceful miss: text not found on the page. The viewer renders the
  // text-only badge for this type.
  return { bbox: null, type: "text-only", isSearching };
}
