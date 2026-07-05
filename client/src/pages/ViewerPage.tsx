/**
 * Dedicated full-screen viewer route: /viewer/:sourceId.
 *
 * Mounts the same EvidenceViewer used by the lightbox, but with
 * hash-driven state (page, bbox, type) and a back button that
 * returns the user to the previous route.
 *
 * The route is also a deep-link target — the "Open in tab" button
 * in the lightbox navigates here with the resolved provenance
 * serialized in the URL hash, and the route restores it on mount.
 *
 * PR #2 of bioprospecting-multipage-table-merge: the sidebar
 * table list now shows a "Part X of N" suffix on chain members,
 * computed from the cached evidence via `useTableChain`.
 */
import { useEffect } from "preact/hooks";
import { route } from "preact-router";

import { EvidenceViewer } from "../components/EvidenceViewer";
import { usePdfDocument } from "../hooks/usePdfDocument";
import { useSourceEvidence } from "../hooks/useSourceEvidence";
import { useTableChain, computeTableChain } from "../hooks/useTableChain";
import { parseViewerHash } from "../hooks/useProvenance";

interface ViewerPageProps {
  sourceId?: string;
}

export function ViewerPage({ sourceId }: ViewerPageProps) {
  const id = sourceId ?? "";
  const { doc, isLoading, error, numPages, goToPage } = usePdfDocument(id);
  const { data: evidence } = useSourceEvidence(id);

  // Hash-driven state. We re-read on every render via the viewer
  // (which already listens to `hashchange`), but on first mount we
  // also surface the title into the document so browser tabs read
  // the source title.
  useEffect(() => {
    if (evidence?.sourceId) {
      // intentionally read the hash for any side effects; the actual
      // bbox / page / type is consumed by EvidenceViewer.
      parseViewerHash(window.location.hash);
    }
  }, [evidence?.sourceId]);

  if (!id) {
    return (
      <div className="viewer-page__empty">
        <p>No source id in URL.</p>
        <button type="button" onClick={() => history.back()}>
          Go back
        </button>
      </div>
    );
  }

  const sourceTitle =
    (evidence as unknown as { title?: string } | null)?.title ?? null;

  return (
    <div className="viewer-page">
      <header className="viewer-page__topbar">
        <button
          type="button"
          className="viewer-page__back"
          onClick={() => {
            if (window.history.length > 1) {
              history.back();
            } else {
              route("/library", true);
            }
          }}
          aria-label="Back to library"
        >
          ‹ Back
        </button>
        <h1 className="viewer-page__title">{sourceTitle ?? `Source ${id.slice(0, 8)}`}</h1>
        <div className="viewer-page__spacer" />
      </header>
      <main className="viewer-page__main">
        <EvidenceViewer
          doc={doc}
          isLoading={isLoading}
          error={error}
          numPages={numPages}
        />
        <aside className="viewer-page__sidebar" aria-label="Evidence list">
          <h3>Evidence</h3>
          {evidence?.tables?.length ? (
            <section>
              <h4>Tables ({evidence.tables.length})</h4>
              <ul>
                {evidence.tables.map((t) => {
                  // PR #2: compute the chain this table belongs
                  // to via the pure helper. We avoid a hook call
                  // here (no React rules violation) by using
                  // computeTableChain directly. The chain is in
                  // page-ascending order; the current table's
                  // index in the chain is the "Part X" position.
                  // Single-fragment tables show no suffix.
                  const chain = computeTableChain(evidence.tables, t.id);
                  const chainIdx = chain.findIndex((f) => f.id === t.id);
                  const partSuffix =
                    chain.length > 1 && chainIdx >= 0
                      ? ` · Part ${chainIdx + 1} of ${chain.length}`
                      : "";
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => goToPage(t.page).then(() => undefined)}
                      >
                        Page {t.page} · Table {t.tableIndex}
                        {partSuffix}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          {evidence?.figures?.length ? (
            <section>
              <h4>Figures ({evidence.figures.length})</h4>
              <ul>
                {evidence.figures.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => goToPage(f.page).then(() => undefined)}
                    >
                      Page {f.page} · Figure {f.figureIndex}
                      {f.caption ? `: ${f.caption}` : ""}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {!evidence?.tables?.length && !evidence?.figures?.length ? (
            <p className="viewer-page__sidebar-empty">
              No extracted evidence for this source.
            </p>
          ) : null}
        </aside>
      </main>
    </div>
  );
}
