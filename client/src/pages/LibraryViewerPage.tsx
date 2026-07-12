/**
 * Library-scoped viewer: /library/:docId/viewer.
 *
 * Resolves `docId` to its underlying `researchSourceId` via the
 * existing `/api/library/:docId` endpoint, then delegates to
 * `ViewerPage` for the actual PDF rendering. The two URL forms
 * (`/viewer/:sourceId` and `/library/:docId/viewer`) share the
 * same EvidenceViewer + bbox contract.
 */
import { usePaperMeta } from "../hooks/useLibrary";
import { ViewerPage } from "./ViewerPage";

interface LibraryViewerPageProps {
  docId?: string;
}

export function LibraryViewerPage({ docId }: LibraryViewerPageProps) {
  const id = docId ?? "";
  const { meta, isLoading, error } = usePaperMeta(id);

  if (!id) {
    return (
      <div className="empty viewer-page__empty">
        <header>
          <p>No document id in URL.</p>
        </header>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="empty viewer-page__empty">
        <header>
          <p>Resolving source…</p>
        </header>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty viewer-page__empty" data-tone="danger">
        <header>
          <h3>Could not load this document</h3>
          <p>{error}</p>
        </header>
      </div>
    );
  }

  const sourceId = meta?.researchSourceId;
  if (!sourceId) {
    return (
      <div className="empty viewer-page__empty">
        <header>
          <p>This document is not linked to a Research Brain source.</p>
        </header>
      </div>
    );
  }

  return <ViewerPage sourceId={sourceId} />;
}
