/**
 * Shared PDF.js mount for the provenance viewer.
 *
 * Used by both the EvidenceLightbox (inline modal) and the
 * dedicated /viewer/:sourceId route. Renders pages of the source
 * PDF at a dynamic scale (fit-to-width by default, plus optional
 * manual zoom controls) and overlays a highlight div at the
 * resolved bbox. The overlay is computed with the SAME live scale
 * the canvas renders at, so highlights stay aligned at any zoom.
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
  // Opt-in visible zoom toolbar (− / fit / +). The dedicated
  // /viewer route sets this true; the lightbox leaves it off to
  // keep its chrome unchanged. Fit-to-width applies regardless.
  showZoomControls?: boolean;
}

// Manual zoom is clamped to a sane range; fit-to-width is clamped
// to the same bounds so an extreme container size can't produce a
// degenerate scale.
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const ZOOM_STEP = 1.2;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
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
  showZoomControls = false,
}: EvidenceViewerProps) {
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [bbox, setBbox] = useState<BBox | null>(bboxProp ?? null);
  const [type, setType] = useState<ProvenanceType>(typeProp ?? "chunk");
  const [pageRender, setPageRender] = useState<PdfPageProxy | null>(null);
  // Live render scale. Starts at the legacy fixed value; the fit
  // effect overrides it to fit-to-width once the page + container
  // are measured. Manual zoom controls also write here.
  const [scale, setScale] = useState<number>(PDFJS_RENDER_SCALE);
  // When true, the scale tracks the container width (recomputed on
  // resize). Manual − / + turn this OFF; the fit button turns it
  // back ON.
  const [fitMode, setFitMode] = useState<boolean>(true);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  // The scroll container (canvaswrap). Its clientWidth minus padding
  // is the "available width" used for fit-to-width.
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
        const viewport = page.getViewport({ scale });
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
          const x = item.transform[4] * scale;
          const yTop = viewport.height - item.transform[5] * scale;
          span.style.position = "absolute";
          span.style.left = `${x}px`;
          span.style.top = `${yTop - fontHeight * scale}px`;
          span.style.fontSize = `${fontHeight * scale}px`;
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
  }, [doc, pageNumber, scale]);

  // Fit-to-width. Computes the scale so the page fills the available
  // width of the scroll container (clientWidth minus horizontal
  // padding — NOT the sidebar, which lives outside this container).
  // Recomputes on container resize while `fitMode` is on. Because
  // PDF.js returns the same PdfPageProxy instance for a given page,
  // setting the fit scale settles: once `scale` equals the fit
  // value, the render effect re-runs with the same page instance and
  // this effect recomputes the same value, so no update is emitted.
  useEffect(() => {
    if (!fitMode) return;
    const page = pageRender;
    const container = scrollRef.current;
    if (!page || !container) return;

    const computeFit = (): number | null => {
      const naturalWidth = page.getViewport({ scale: 1 }).width;
      if (!naturalWidth) return null;
      const styles = window.getComputedStyle(container);
      const paddingX =
        (parseFloat(styles.paddingLeft) || 0) +
        (parseFloat(styles.paddingRight) || 0);
      const available = container.clientWidth - paddingX;
      if (available <= 0) return null;
      return clampScale(available / naturalWidth);
    };

    let raf = 0;
    const recompute = () => {
      const next = computeFit();
      if (next == null) return;
      // Skip micro-updates to avoid a resize/render feedback loop.
      setScale((prev) => (Math.abs(prev - next) > 0.001 ? next : prev));
    };

    recompute();
    const observer = new ResizeObserver(() => {
      // Debounce bursts of resize callbacks into one rAF tick.
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recompute);
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [fitMode, pageRender]);

  const zoomIn = useCallback(() => {
    setFitMode(false);
    setScale((s) => clampScale(s * ZOOM_STEP));
  }, []);

  const zoomOut = useCallback(() => {
    setFitMode(false);
    setScale((s) => clampScale(s / ZOOM_STEP));
  }, []);

  const fitToWidth = useCallback(() => {
    // Re-enabling fit mode makes the fit effect recompute on its
    // next run (it depends on `fitMode`).
    setFitMode(true);
  }, []);

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
        {showZoomControls ? (
          <div
            className="provenance-viewer__zoom"
            role="group"
            aria-label="Zoom controls"
          >
            <button
              type="button"
              className="provenance-viewer__nav"
              onClick={zoomOut}
              disabled={scale <= MIN_SCALE + 1e-6}
              aria-label="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              className="provenance-viewer__zoomlevel"
              onClick={fitToWidth}
              aria-pressed={fitMode}
              aria-label="Fit page to width"
              title="Fit to width"
            >
              {Math.round(scale * 100)}%{fitMode ? " · Fit" : ""}
            </button>
            <button
              type="button"
              className="provenance-viewer__nav"
              onClick={zoomIn}
              disabled={scale >= MAX_SCALE - 1e-6}
              aria-label="Zoom in"
            >
              +
            </button>
          </div>
        ) : null}
      </div>
      <div ref={scrollRef} className="provenance-viewer__canvaswrap">
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
            scale={scale}
            className="provenance-viewer__overlay"
          />
        ) : null}
      </div>
    </div>
  );
}
