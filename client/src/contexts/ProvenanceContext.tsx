/**
 * ProvenanceContext — top-level provider that owns the
 * EvidenceLightbox lifecycle and listens for the global
 * `provenance:open` window event emitted by `provenanceTrigger`.
 *
 * The provider is mounted once at the root of the app (both
 * `LegacyAppShell` and `CoralAppShell`). The lightbox is rendered
 * inline at the provider's level, so it floats over the whole app
 * regardless of which page or component fired the event.
 *
 * Wire-up flow:
 *   1. `openProvenanceLightbox(factId, sourceId, trigger)` dispatches
 *      a `provenance:open` CustomEvent on `window`.
 *   2. This provider's `useEffect` subscribes to the event and
 *      stores `factId` + the sourceId hint (if any) + the trigger
 *      element ref into state.
 *   3. The lightbox renders, fetches provenance for `factId`, and
 *      on close clears the state.
 *   4. When the user clicks the lightbox's "Open in tab" button,
 *      the lightbox calls `openProvenanceInTab` directly (no event
 *      hop needed); the helper opens the new tab and closes the
 *      lightbox.
 *
 * SourceId hint:
 *   The trigger may pass an optional `sourceId` if the caller
 *   already knows it (e.g., the LibraryPage renders a list of
 *   facts that already carry the source id). When the hint is
 *   missing, the lightbox resolves the source from the provenance
 *   payload (one extra round-trip, but no data loss).
 */
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { createContext } from "preact";
import type { ComponentChildren } from "preact";

import { EvidenceLightbox } from "../components/EvidenceLightbox";
import { PROVENANCE_OPEN_EVENT } from "../utils/provenanceTrigger";

interface ProvenanceContextValue {
  isOpen: boolean;
  factId: string | null;
  sourceIdHint: string | null;
  openLightbox: (factId: string, sourceId?: string | null) => void;
  closeLightbox: () => void;
}

const ProvenanceContext = createContext<ProvenanceContextValue | null>(null);

interface ProvenanceProviderProps {
  children: ComponentChildren;
}

export function ProvenanceProvider({ children }: ProvenanceProviderProps) {
  const [factId, setFactId] = useState<string | null>(null);
  const [sourceIdHint, setSourceIdHint] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const closeLightbox = useCallback(() => {
    setFactId(null);
    setSourceIdHint(null);
    // Don't clear triggerRef synchronously — the lightbox reads it
    // on its unmount effect to restore focus. Clearing in the same
    // tick would race with the unmount.
    setTimeout(() => {
      triggerRef.current = null;
    }, 0);
  }, []);

  const openLightbox = useCallback(
    (nextFactId: string, nextSourceId?: string | null) => {
      if (!nextFactId) return;
      setFactId(nextFactId);
      setSourceIdHint(nextSourceId ?? null);
    },
    [],
  );

  // Subscribe to the global "provenance:open" event so any
  // component (citation, fact card, future message bubble) can
  // open the lightbox without importing the context. The detail
  // carries the originating element so the lightbox can restore
  // focus to it on close.
  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<{
        factId: string;
        sourceId?: string | null;
        trigger?: HTMLElement | null;
      }>;
      const detail = custom.detail;
      if (!detail?.factId) return;
      triggerRef.current = detail.trigger ?? (document.activeElement as HTMLElement | null);
      openLightbox(detail.factId, detail.sourceId ?? null);
    };
    window.addEventListener(PROVENANCE_OPEN_EVENT, handler as EventListener);
    return () =>
      window.removeEventListener(
        PROVENANCE_OPEN_EVENT,
        handler as EventListener,
      );
  }, [openLightbox]);

  // The `sourceIdHint` is not currently consumed by the lightbox —
  // it is reserved for a future "open the lightbox before the
  // provenance resolves" optimization (e.g., pre-warming the PDF
  // download). Keeping it in the context means the call site does
  // not need to be revisited.
  void sourceIdHint;

  const value = useMemo<ProvenanceContextValue>(
    () => ({
      isOpen: factId != null,
      factId,
      sourceIdHint,
      openLightbox,
      closeLightbox,
    }),
    [factId, sourceIdHint, openLightbox, closeLightbox],
  );

  return (
    <ProvenanceContext.Provider value={value}>
      {children}
      <EvidenceLightbox
        factId={factId}
        isOpen={factId != null}
        onClose={closeLightbox}
        triggerRef={triggerRef}
      />
    </ProvenanceContext.Provider>
  );
}

export function useProvenanceContext(): ProvenanceContextValue {
  const ctx = useContext(ProvenanceContext);
  if (!ctx) {
    // We deliberately return a no-op shape rather than throwing —
    // the badge component on a fact card can be rendered outside
    // the provider (e.g., in tests) and the helpers still need to
    // resolve. The "no-op" path opens no lightbox and just returns.
    return {
      isOpen: false,
      factId: null,
      sourceIdHint: null,
      openLightbox: () => undefined,
      closeLightbox: () => undefined,
    };
  }
  return ctx;
}
