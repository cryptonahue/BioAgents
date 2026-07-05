/**
 * Inline evidence lightbox. The default affordance for fact
 * citations on the library and research brain pages. The dedicated
 * `/viewer/:sourceId` route is the "open in tab" escalation.
 *
 * Behavior contract (spec §Evidence Lightbox Component):
 *   - Modal overlay over the current page
 *   - Esc closes, focus returns to the triggering element
 *   - Custom focus trap (no third-party lib)
 *   - "Open in tab" button opens `/viewer/:sourceId#bbox=...`
 *   - Supports all 4 provenance types (table|figure|chunk|text-only)
 *
 * v1 is intentionally read-only — no inline editing, no char-level
 * offsets. The text-only badge is rendered in the toolbar when
 * `provenance.type === "text-only"` (no overlay is drawn for it).
 *
 * PR #2 of figure-image-extraction: when the figure has an
 * `imageUrl` (set by the `/evidence` endpoint when storage_path IS
 * NOT NULL), the lightbox renders a cropped `<img>` header above
 * the PDF viewer with two new buttons — "Open image" and
 * "Download" — and a `Figure {N} (page {P})` text in the toolbar
 * header. When `imageUrl` is absent (bbox-only, pre-change case)
 * the header is omitted and the toolbar text is the only delta.
 * Both buttons are read-only affordances (window.open + fetch +
 * Blob); no DB writes.
 */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import { usePdfDocument } from "../hooks/usePdfDocument";
import {
  buildViewerHash,
  ProvenanceType,
  useProvenance,
} from "../hooks/useProvenance";
import { useSourceEvidence } from "../hooks/useSourceEvidence";
import { BBox } from "../lib/bbox";
import { ChainPager } from "./ChainPager";
import { EvidenceViewer } from "./EvidenceViewer";

interface EvidenceLightboxProps {
  factId: string | null;
  isOpen: boolean;
  onClose: () => void;
  // Element that triggered the lightbox — focus returns here on close.
  triggerRef?: { current: HTMLElement | null };
}

export function EvidenceLightbox({
  factId,
  isOpen,
  onClose,
  triggerRef,
}: EvidenceLightboxProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const openInTabRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const {
    data,
    isLoading: provLoading,
    error: provError,
  } = useProvenance(factId);

  // The lightbox only needs the sourceId for the PDF doc; the bbox
  // and type come from the provenance payload.
  const sourceId = data?.sourceId ?? null;
  const {
    doc,
    isLoading: pdfLoading,
    error: pdfError,
    numPages,
  } = usePdfDocument(isOpen && sourceId ? sourceId : null);

  // PR #2 of bioprospecting-multipage-table-merge: the ChainPager
  // walks `continuesFromId` on the cached evidence to render the
  // "Part X of N" badge + prev/next. We fetch the full evidence
  // for the source (the same endpoint the dedicated viewer uses)
  // and pass the table list to the pager.
  const { data: sourceEvidence } = useSourceEvidence(
    isOpen && sourceId ? sourceId : null,
  );
  // Track the user-clicked page from the ChainPager (only fires
  // when the `Follow` toggle is ON). When the pager requests a
  // page navigation, we override the `page` prop passed to the
  // EvidenceViewer below.
  const navigatedPageRef = useRef<number | null>(null);
  // No-op state to trigger re-render on navigation. The ref holds
  // the actual page; the state is a one-bit "did the user click
  // nav" flag that forces the parent component to re-evaluate.
  const [, setChainTick] = useState(0);

  // Handler for the ChainPager: when the user clicks prev/next
  // AND the `Follow` toggle is ON, navigate to the fragment's
  // page. The EvidenceViewer re-renders on the new page.
  const handleChainNavigate = useCallback((targetPage: number) => {
    navigatedPageRef.current = targetPage;
    setChainTick((t) => t + 1);
  }, []);

  // Remember the previously-focused element so we can restore on
  // close. The spec calls for "focus returns to the fact citation
  // that opened it" — the triggerRef is the canonical reference.
  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current =
      triggerRef?.current ?? (document.activeElement as HTMLElement | null);
    // Move focus into the dialog immediately so screen readers
    // announce it. The "Open in tab" button is the primary action.
    openInTabRef.current?.focus();
    return () => {
      // Restore focus on unmount/close.
      previousFocusRef.current?.focus?.();
    };
  }, [isOpen, triggerRef]);

  // Esc closes the lightbox. The handler is attached at the document
  // level so it fires regardless of which descendant has focus.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        // Focus trap: cycle Tab and Shift+Tab within the dialog's
        // focusable elements. ~20 lines, no third-party lib.
        const root = containerRef.current;
        if (!root) return;
        const focusables = root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // Lock body scroll while the modal is open.
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  const handleOpenInTab = useCallback(() => {
    if (!data) return;
    const { sourceId, provenance } = data;
    if (!sourceId) return;
    const bbox = provenance.bbox ?? null;
    const type: ProvenanceType = provenance.type;
    const page = bbox?.page ?? provenance.chunk?.page ?? 1;
    const hash = buildViewerHash({ bbox, page, type });
    window.open(`/viewer/${sourceId}${hash}`, "_blank", "noopener,noreferrer");
    onClose();
  }, [data, onClose]);

  // PR #2: "Open image" — opens the proxy URL in a new tab.
  // `noopener,noreferrer` prevents window.opener exposure and
  // Referer leak. No-op when no imageUrl (defensive; the
  // button is hidden in that case).
  const handleOpenImage = useCallback((imageUrl: string) => {
    if (!imageUrl) return;
    window.open(imageUrl, "_blank", "noopener,noreferrer");
  }, []);

  // PR #2: "Download" — fetch with credentials, wrap in Blob,
  // trigger a synthetic <a download>. Blob URL is revoked on
  // the next tick so a second click does not accumulate
  // downloads. Filename is `figure-{N}.{png|jpg}` from the
  // figure's mimeType.
  const handleDownloadImage = useCallback(
    async (imageUrl: string, filename: string, mimeType?: string) => {
      if (!imageUrl) return;
      try {
        const res = await fetch(imageUrl, { credentials: "include" });
        if (!res.ok) {
          console.warn(
            "[EvidenceLightbox] download fetch failed",
            res.status,
            imageUrl,
          );
          return;
        }
        const blob = await res.blob();
        // Honor response Content-Type, fall back to figure
        // mimeType, then application/octet-stream.
        const blobType = blob.type || mimeType || "application/octet-stream";
        const typed = blob.type ? blob : new Blob([blob], { type: blobType });
        const objectUrl = URL.createObjectURL(typed);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      } catch (err) {
        console.warn("[EvidenceLightbox] download error", err);
      }
    },
    [],
  );

  if (!isOpen) return null;

  const { provenance, sourceTitle } = data ?? {};
  const bbox: BBox | null = provenance?.bbox ?? null;
  // PR #2: allow the ChainPager (when `Follow` is ON) to override
  // the page. Default to the provenance's natural page on
  // provenance / bbox changes; the pager only sets a new value on
  // prev/next clicks.
  const basePage: number = bbox?.page ?? provenance?.chunk?.page ?? 1;
  const page: number = navigatedPageRef.current ?? basePage;
  const type: ProvenanceType = provenance?.type ?? "chunk";

  // The current fact's table id (used by the ChainPager to find
  // the chain). Null when the fact doesn't point at a table.
  const currentTableId: string | null =
    provenance?.type === "table" && provenance?.table?.id
      ? provenance.table.id
      : null;

  // PR #2: figure-specific UI signals. `figureImageUrl` is
  // non-empty only when the backend says the figure has an
  // extracted image. The image header and Open/Download
  // buttons are gated on this; the bbox-only case keeps
  // pre-change behavior.
  const figure = provenance?.type === "figure" ? provenance?.figure : null;
  const figureImageUrl: string | null = figure?.imageUrl ?? null;
  const figureCaption: string | null = figure?.caption ?? null;
  const figureIndex: number | null = figure?.figureIndex ?? null;
  // The figure header's "page {P}" comes from the bbox (the
  // figure is anchored to a specific page).
  const figureHeaderPage: number | null = bbox?.page ?? null;
  const downloadFilename = (() => {
    if (!figureImageUrl || figureIndex == null) return null;
    const ext =
      figure?.mimeType === "image/jpeg" || figure?.mimeType === "image/jpg"
        ? "jpg"
        : "png";
    return `figure-${figureIndex}.${ext}`;
  })();

  return (
    <div
      className="evidence-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Source evidence for ${sourceTitle ?? "fact"}`}
    >
      <div
        className="evidence-lightbox__backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={containerRef}
        className="evidence-lightbox__dialog"
        data-provenance-lightbox
      >
        <header className="evidence-lightbox__header">
          <div className="evidence-lightbox__titlewrap">
            <h2 className="evidence-lightbox__title">
              {sourceTitle ?? "Source PDF"}
            </h2>
            <span className="evidence-lightbox__subtitle">
              Fact {factId ?? "—"}
              {/* PR #2: `Figure {N} (page {P})` next to the Fact id.
                  Visible regardless of imageUrl presence. */}
              {provenance?.type === "figure" && figureIndex != null ? (
                <span
                  className="evidence-lightbox__figure-tag"
                  aria-label={
                    figureHeaderPage != null
                      ? `Figure ${figureIndex} on page ${figureHeaderPage}`
                      : `Figure ${figureIndex}`
                  }
                >
                  {" · "}Figure {figureIndex}
                  {figureHeaderPage != null
                    ? ` (page ${figureHeaderPage})`
                    : ""}
                </span>
              ) : null}
            </span>
            {/*
              PR #3 of `bioprospecting-compound-authority` — show
              InChIKey + PubChem CID in the lightbox header when
              the fact has a resolved canonical. The compound object
              is populated by the server-side embed added in
              `getBioprospectingFact` (FK to `research_compounds`).
              The block is hidden entirely when the fact has no
              canonical (the resolve is still pending or was an
              extract). The user still gets the badge on the fact
              card outside the lightbox, so the absence of the
              block here is consistent with "nothing to show yet".
            */}
            {data?.compound?.canonicalName ? (
              <div className="evidence-lightbox__compound">
                <span className="evidence-lightbox__compound-name">
                  {data.compound.canonicalName}
                </span>
                {data.compound.inchiKey ? (
                  <span className="evidence-lightbox__compound-meta">
                    InChIKey: <code>{data.compound.inchiKey}</code>
                  </span>
                ) : null}
                {data.compound.pubchemCid != null ? (
                  <span className="evidence-lightbox__compound-meta">
                    PubChem CID: <code>{data.compound.pubchemCid}</code>
                  </span>
                ) : null}
                {data.compound.molecularFormula ? (
                  <span className="evidence-lightbox__compound-meta">
                    Formula: <code>{data.compound.molecularFormula}</code>
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="evidence-lightbox__actions">
            {/*
              PR #2 of bioprospecting-multipage-table-merge:
              render the "Part X of N" pager when the current
              fact's table is part of a chain. The pager is hidden
              when the chain has fewer than 2 fragments.
            */}
            {provenance?.type === "table" ? (
              <ChainPager
                tables={sourceEvidence?.tables ?? null}
                currentTableId={currentTableId}
                onNavigatePage={handleChainNavigate}
              />
            ) : null}
            {/* PR #2: "Open image" / "Download" buttons, rendered
                ONLY when the figure has an imageUrl. Read-only
                affordances (window.open + fetch + Blob). */}
            {figureImageUrl ? (
              <>
                <button
                  type="button"
                  className="evidence-lightbox__btn"
                  onClick={() => handleOpenImage(figureImageUrl)}
                  aria-label="Open figure image in new tab"
                >
                  Open image
                </button>
                {downloadFilename ? (
                  <button
                    type="button"
                    className="evidence-lightbox__btn"
                    onClick={() =>
                      handleDownloadImage(
                        figureImageUrl,
                        downloadFilename,
                        figure?.mimeType,
                      )
                    }
                    aria-label="Download figure image"
                  >
                    Download
                  </button>
                ) : null}
              </>
            ) : null}
            <button
              ref={openInTabRef}
              type="button"
              className="evidence-lightbox__btn evidence-lightbox__btn--primary"
              onClick={handleOpenInTab}
              disabled={!data?.sourceId}
              aria-label="Open in dedicated viewer tab"
            >
              Open in tab
            </button>
            <button
              type="button"
              className="evidence-lightbox__btn"
              onClick={onClose}
              aria-label="Close evidence lightbox"
            >
              Close
            </button>
          </div>
        </header>
        {provError ? (
          <div className="evidence-lightbox__error">{provError}</div>
        ) : null}
        {provLoading || !data ? (
          <div className="evidence-lightbox__loading">Loading provenance…</div>
        ) : (
          <>
            {/* PR #2: conditional image header above the PDF viewer,
                rendered ONLY when the figure has an imageUrl. The
                <img> is wrapped in role="img" + aria-label
                (screen-reader contract). width/height prevent
                layout shift; loading="lazy" defers bytes. */}
            {figureImageUrl ? (
              <div className="evidence-lightbox__figure-preview">
                <div
                  className="evidence-lightbox__figure-imagewrap"
                  role="img"
                  aria-label={figureCaption ?? "Figure preview"}
                >
                  <img
                    src={figureImageUrl}
                    alt={figureCaption ?? "Figure preview"}
                    width={figure?.width}
                    height={figure?.height}
                    loading="lazy"
                    className="evidence-lightbox__figure-image"
                  />
                </div>
                {figureCaption ? (
                  <div className="evidence-lightbox__figure-caption">
                    {figureCaption}
                  </div>
                ) : null}
              </div>
            ) : null}
            <EvidenceViewer
              doc={doc}
              isLoading={pdfLoading}
              error={pdfError}
              numPages={numPages}
              bbox={bbox}
              type={type}
              page={page}
              // PR #2: imageUrl drives the bbox color split
              // (green with-image vs purple bbox-only).
              imageUrl={figureImageUrl ?? undefined}
            />
          </>
        )}
      </div>
    </div>
  );
}
