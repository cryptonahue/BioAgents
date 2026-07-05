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
      <div className="viewer-page__empty">
        <p>No document id in URL.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="viewer-page__empty">
        <p>Resolving source…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="viewer-page__empty">
        <p>Failed to load document: {error}</p>
      </div>
    );
  }

  const sourceId = meta?.researchSourceId;
  if (!sourceId) {
    return (
      <div className="viewer-page__empty">
        <p>This document is not linked to a Research Brain source.</p>
      </div>
    );
  }

  return <ViewerPage sourceId={sourceId} />;
}
