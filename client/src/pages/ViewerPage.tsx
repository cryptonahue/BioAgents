/**
 * Dedicated full-screen viewer route: /viewer/:sourceId.
 *
 * Mounts the same EvidenceViewer used by the lightbox. The bbox /
 * type / page it highlights are held in local state, seeded from the
 * URL hash on mount (so deep links + reload restore the highlight —
 * spec "Hash survives reload") and updated when the user clicks an
 * item in the evidence sidebar.
 *
 * The route is also a deep-link target — the "Open in tab" button
 * in the lightbox navigates here with the resolved provenance
 * serialized in the URL hash, and the route restores it on mount.
 *
 * Sidebar clicks:
 *   - Tables / figures carry a stored bbox → highlight directly.
 *   - Claims resolve to their evidence chunk. Chunks have no stored
 *     bbox, so the chunk's text is searched in the page's text layer
 *     (useTextChunkHighlight); a hit highlights the run(s), a miss
 *     surfaces the "text-only" badge.
 *
 * PR #2 of bioprospecting-multipage-table-merge: the sidebar
 * table list now shows a "Part X of N" suffix on chain members,
 * computed from the cached evidence via `useTableChain`.
 */
import { useState } from "preact/hooks";
import { route } from "preact-router";

import { EvidenceViewer } from "../components/EvidenceViewer";
import { usePdfDocument } from "../hooks/usePdfDocument";
import { useSourceEvidence } from "../hooks/useSourceEvidence";
import { useSourceClaims } from "../hooks/useSourceClaims";
import { computeTableChain } from "../hooks/useTableChain";
import { useTextChunkHighlight } from "../hooks/useTextChunkHighlight";
import { parseViewerHash, ProvenanceType } from "../hooks/useProvenance";
import { BBox } from "../lib/bbox";

interface ViewerPageProps {
  sourceId?: string;
}

export function ViewerPage({ sourceId }: ViewerPageProps) {
  const id = sourceId ?? "";
  const { doc, isLoading, error, numPages } = usePdfDocument(id);
  const { data: evidence } = useSourceEvidence(id);
  const { claims } = useSourceClaims(id);

  // Highlight state. Seeded once from the URL hash so a deep link /
  // reload restores the bbox, type, and page (spec: "Hash survives
  // reload"). Sidebar clicks below overwrite these.
  const initialHash = parseViewerHash(window.location.hash);
  const [activeBbox, setActiveBbox] = useState<BBox | null>(initialHash.bbox);
  const [activeType, setActiveType] = useState<ProvenanceType>(
    initialHash.type,
  );
  const [activePage, setActivePage] = useState<number | null>(
    initialHash.bbox ? initialHash.page : null,
  );

  // Text-chunk fallback. When a clicked claim resolves to a chunk
  // (which never has a stored bbox), we set the chunk's content +
  // page here and let the search hook produce a point-space rect. A
  // hit becomes the highlight; a miss flips the type to "text-only".
  const [searchContent, setSearchContent] = useState<string | null>(null);
  const [searchPage, setSearchPage] = useState<number | null>(null);
  const searchActive = searchContent != null;
  const chunkHighlight = useTextChunkHighlight({
    doc,
    page: searchPage,
    content: searchContent,
    enabled: !!doc && searchActive,
  });

  // Effective highlight passed to the viewer. When a claim search is
  // active its result wins; otherwise the directly-set bbox (tables /
  // figures) applies. All values are prop-driven, so the viewer
  // follows them and the overlay + page-jump both fire.
  const effectiveBbox: BBox | null = searchActive
    ? chunkHighlight.bbox
    : activeBbox;
  const effectiveType: ProvenanceType = searchActive
    ? chunkHighlight.type ?? activeType
    : activeType;

  function highlightStored(page: number, type: ProvenanceType, bbox: BBox | null) {
    setSearchContent(null);
    setSearchPage(null);
    setActiveType(type);
    setActivePage(page);
    setActiveBbox(bbox);
  }

  function highlightChunk(page: number, content: string) {
    setActiveBbox(null);
    // Provisional type until the search resolves; the hook flips it
    // to "text-only" on a miss.
    setActiveType("chunk");
    setActivePage(page);
    setSearchPage(page);
    setSearchContent(content);
  }

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
          bbox={effectiveBbox}
          type={effectiveType}
          page={activePage ?? undefined}
          showZoomControls
        />
        <aside className="viewer-page__sidebar" aria-label="Evidence list">
          <h3>Evidence</h3>
          {claims.length ? (
            <section>
              <h4>Claims ({claims.length})</h4>
              <ul className="viewer-page__claims">
                {claims.map((c) => {
                  const chunk = c.chunk;
                  const canHighlight = !!chunk?.content && chunk?.page != null;
                  return (
                    <li key={c.id} className="viewer-page__claim">
                      <button
                        type="button"
                        className="viewer-page__claim-btn"
                        disabled={!canHighlight}
                        onClick={() => {
                          if (chunk?.content && chunk?.page != null) {
                            highlightChunk(chunk.page, chunk.content);
                          }
                        }}
                      >
                        <span
                          className={`claim-status claim-status--${c.status}`}
                        >
                          {c.status.replace(/_/g, " ")}
                        </span>
                        <span className="claim-text">{c.claim}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
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
                        onClick={() =>
                          highlightStored(t.page, "table", t.bbox ?? null)
                        }
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
                      onClick={() =>
                        highlightStored(f.page, "figure", f.bbox ?? null)
                      }
                    >
                      Page {f.page} · Figure {f.figureIndex}
                      {f.caption ? `: ${f.caption}` : ""}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {!claims.length &&
          !evidence?.tables?.length &&
          !evidence?.figures?.length ? (
            <p className="viewer-page__sidebar-empty">
              No extracted evidence for this source.
            </p>
          ) : null}
        </aside>
      </main>
    </div>
  );
}
