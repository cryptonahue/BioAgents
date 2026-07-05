/**
 * Shared PDF.js mount for the provenance viewer.
 *
 * Used by both the EvidenceLightbox (inline modal) and the
 * dedicated /viewer/:sourceId route. Renders pages of the source
 * PDF at the fixed 1.5× scale and overlays a highlight div at
 * the resolved bbox.
 *
 * The component reads `bbox` and `type` either from props (lightbox
 * usage) or from the URL hash (dedicated route). The hash-derived
 * state is watched via `hashchange` so deep links survive reload
 * and back/forward navigation (spec: "Hash survives reload").
 *
 * v1 is read-only: PDF.js text layer is on (selection + copy), no
 * edit affordances, no inline annotations. The spec's "Read-Only
 * Contract" requirement is enforced by the absence of any input
 * element inside this root.
 */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import {
  HashState,
  parseViewerHash,
  ProvenanceType,
} from "../hooks/useProvenance";
import { BBox, PDFJS_RENDER_SCALE } from "../lib/bbox";
import { type PdfDocumentProxy, type PdfPageProxy } from "../lib/pdfjs";
import { BboxOverlay } from "./BboxOverlay";

interface EvidenceViewerProps {
  doc: PdfDocumentProxy | null;
  isLoading: boolean;
  error: string;
  numPages: number;
  // Optional prop-driven provenance (used by the lightbox). When
  // omitted, the viewer falls back to URL hash state.
  bbox?: BBox | null;
  type?: ProvenanceType;
  page?: number;
  // PR #2 of figure-image-extraction: when the figure has an
  // extracted image, the lightbox passes the proxy URL so the
  // bbox can switch from purple (bbox-only) to green
  // (with-image). Tables and chunks ignore this. Optional —
  // when undefined the pre-change purple class applies for
  // figures.
  imageUrl?: string;
  // Called when the URL hash is the source of truth (dedicated
  // route). The parent can use this to set `window.location.hash`.
  onHashChange?: (state: HashState) => void;
}

export function EvidenceViewer({
  doc,
  isLoading,
  error,
  numPages,
  bbox: bboxProp,
  type: typeProp,
  page: pageProp,
  imageUrl: imageUrlProp,
  onHashChange,
}: EvidenceViewerProps) {
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [bbox, setBbox] = useState<BBox | null>(bboxProp ?? null);
  const [type, setType] = useState<ProvenanceType>(typeProp ?? "chunk");
  const [pageRender, setPageRender] = useState<PdfPageProxy | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);

  // Hash sync: when no props are passed, derive state from the URL
  // hash. Re-read on `hashchange` (back/forward navigation).
  useEffect(() => {
    if (bboxProp !== undefined || typeProp !== undefined) return;
    const apply = () => {
      const state = parseViewerHash(window.location.hash);
      setBbox(state.bbox);
      setType(state.type);
      if (state.page) setPageNumber(state.page);
      onHashChange?.(state);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [bboxProp, typeProp, onHashChange]);

  // If props change (lightbox switching facts), follow them.
  useEffect(() => {
    if (bboxProp !== undefined) setBbox(bboxProp);
    if (typeProp !== undefined) setType(typeProp);
  }, [bboxProp, typeProp]);

  useEffect(() => {
    if (pageProp !== undefined) setPageNumber(pageProp);
  }, [pageProp]);

  // Render the current page on a 2D canvas. Cancels any in-flight
  // render task before starting the next to avoid "Cannot use the
  // same canvas during multiple render() operations" errors.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      try {
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
          renderTaskRef.current = null;
        }
        const target = Math.min(Math.max(1, pageNumber), doc.numPages);
        const page = await doc.getPage(target);
        if (cancelled) return;
        setPageRender(page);

        const canvas = canvasRef.current;
        const textLayer = textLayerRef.current;
        if (!canvas || !textLayer) return;

        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: PDFJS_RENDER_SCALE });
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        // Clear the text layer before re-populating. PDF.js's
        // TextLayer is destructive; stale spans would otherwise
        // leak across page turns.
        textLayer.innerHTML = "";
        textLayer.style.width = `${Math.floor(viewport.width)}px`;
        textLayer.style.height = `${Math.floor(viewport.height)}px`;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.scale(dpr, dpr);

        const renderTask = page.render({
          canvasContext: ctx,
          viewport,
          canvas,
        });
        renderTaskRef.current = renderTask;
        await renderTask.promise;
        renderTaskRef.current = null;
        if (cancelled) return;

        // Build the text layer for selection + copy (read-only).
        // We use the pdfjs textContent API directly; this avoids
        // the full TextLayer helper which is React/Preact-hostile.
        const text = await page.getTextContent();
        const textItems = text.items as Array<{
          str: string;
          transform: number[];
          width: number;
          height: number;
        }>;
        const fragment = document.createDocumentFragment();
        for (const item of textItems) {
          if (!item.str || !item.str.trim()) continue;
          const span = document.createElement("span");
          span.textContent = item.str;
          // text items use [fontSize, 0, 0, fontSize, x, y]
          const fontHeight = Math.hypot(
            item.transform[2] || 0,
            item.transform[3] || 0,
          );
          const x = item.transform[4] * PDFJS_RENDER_SCALE;
          const yTop = viewport.height - item.transform[5] * PDFJS_RENDER_SCALE;
          span.style.position = "absolute";
          span.style.left = `${x}px`;
          span.style.top = `${yTop - fontHeight * PDFJS_RENDER_SCALE}px`;
          span.style.fontSize = `${fontHeight * PDFJS_RENDER_SCALE}px`;
          span.style.whiteSpace = "pre";
          span.style.color = "transparent";
          fragment.appendChild(span);
        }
        textLayer.appendChild(fragment);
      } catch (err: any) {
        // The render task can be cancelled when the page changes
        // mid-flight; PDF.js surfaces that as an
        // `RenderingCancelledException` which we silence.
        if (err?.name !== "RenderingCancelledException") {
          console.error("[EvidenceViewer] render failed", err);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    };
  }, [doc, pageNumber]);

  const goToPage = useCallback(
    (next: number) => {
      if (!doc) return;
      const target = Math.min(Math.max(1, next), doc.numPages);
      setPageNumber(target);
    },
    [doc],
  );

  if (isLoading) {
    return (
      <div className="provenance-viewer__status">
        <span>Loading PDF…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="provenance-viewer__status provenance-viewer__status--error">
        <strong>PDF unavailable</strong>
        <p>{error}</p>
      </div>
    );
  }

  if (!doc) {
    return null;
  }

  // The bbox is anchored to its own page; if the user is on a
  // different page the overlay would be drawn at the wrong spot.
  // Only show the overlay when the current page matches.
  const showBbox = bbox && bbox.page === pageNumber;

  return (
    <div className="provenance-viewer">
      <div className="provenance-viewer__toolbar" role="toolbar">
        <button
          type="button"
          className="provenance-viewer__nav"
          onClick={() => goToPage(pageNumber - 1)}
          disabled={pageNumber <= 1}
          aria-label="Previous page"
        >
          ‹
        </button>
        <span className="provenance-viewer__pageinfo">
          Page {pageNumber} of {numPages}
        </span>
        <button
          type="button"
          className="provenance-viewer__nav"
          onClick={() => goToPage(pageNumber + 1)}
          disabled={pageNumber >= numPages}
          aria-label="Next page"
        >
          ›
        </button>
        {type === "text-only" ? (
          <span className="provenance-badge provenance-badge--inline">
            provenance: text-only
          </span>
        ) : null}
      </div>
      <div className="provenance-viewer__canvaswrap">
        <canvas ref={canvasRef} className="provenance-viewer__canvas" />
        <div
          ref={textLayerRef}
          className="provenance-viewer__textlayer"
          aria-hidden="false"
        />
        {showBbox ? (
          <BboxOverlay
            bbox={bbox}
            type={type}
            imageUrl={imageUrlProp}
            className="provenance-viewer__overlay"
          />
        ) : null}
      </div>
    </div>
  );
}
