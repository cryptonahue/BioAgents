/**
 * Provenance trigger helpers — used by the citation click handlers
 * (InlineCitationText, fact cards) to route a click on a fact
 * citation into the appropriate affordance.
 *
 *  - `openProvenanceLightbox(factId, sourceId?)` is the default
 *    action: dispatches a `provenance:open` CustomEvent on
 *    `window`. The ProvenanceProvider listens for the event and
 *    mounts the EvidenceLightbox. Decoupling the trigger from the
 *    provider keeps the citation components decoupled from the
 *    context tree (they don't need to import React/Preact contexts).
 *
 *  - `openProvenanceInTab(factId, sourceId)` is the modifier-click
 *    (Ctrl / Cmd) path: it computes the dedicated viewer URL
 *    (`/viewer/:sourceId#bbox=…&page=…&type=…`) and opens it in a
 *    new tab. The sourceId is mandatory here because the dedicated
 *    route is keyed by sourceId, not factId.
 *
 * Why CustomEvent and not a context import:
 *   - Citation buttons live deep in `InlineCitationText.jsx`,
 *     which is plain JSX and does not import the contexts bundle.
 *   - Dispatching a window event keeps the trigger surface small
 *     (one helper) and lets future call sites (e.g. a future chat
 *     message bubble) wire in without dragging a context into the
 *     bundle.
 */
import { buildViewerHash, ProvenanceType } from "../hooks/useProvenance";

export const PROVENANCE_OPEN_EVENT = "provenance:open";

interface OpenLightboxDetail {
  factId: string;
  sourceId?: string | null;
  // The originating element — the lightbox restores focus to it
  // when it closes. Stored on the event so the provider does not
  // have to read the DOM.
  trigger?: HTMLElement | null;
}

export function openProvenanceLightbox(
  factId: string,
  sourceId?: string | null,
  trigger?: HTMLElement | null,
): void {
  if (typeof window === "undefined") return;
  const detail: OpenLightboxDetail = { factId, sourceId, trigger };
  window.dispatchEvent(new CustomEvent(PROVENANCE_OPEN_EVENT, { detail }));
}

export function openProvenanceInTab(
  factId: string,
  sourceId: string,
  options: {
    bbox?: { x: number; y: number; w: number; h: number; page: number; units: "pt" } | null;
    page?: number;
    type?: ProvenanceType;
  } = {},
): void {
  if (typeof window === "undefined") return;
  if (!sourceId) {
    // SourceId is mandatory for the dedicated route; the
    // ProvenanceProvider's resolver will fill it in once the
    // provenance payload arrives. If we have to fall back to
    // the fact page, just navigate to the source's root viewer
    // and let the URL hash drive the highlight.
    console.warn(
      "[provenanceTrigger] openProvenanceInTab called without a sourceId for fact",
      factId,
    );
    return;
  }
  const hash = buildViewerHash({
    bbox: options.bbox ?? null,
    page: options.page ?? 1,
    type: options.type ?? "chunk",
  });
  window.open(`/viewer/${sourceId}${hash}`, "_blank", "noopener,noreferrer");
}
