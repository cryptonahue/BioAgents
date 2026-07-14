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
import {
  TrustBadge,
  TrustNote,
  trustOf,
  trustSummary,
} from "../components/EvidenceTrust";
import { parseViewerHash, ProvenanceType } from "../hooks/useProvenance";
import { BBox } from "../lib/bbox";

interface ViewerPageProps {
  sourceId?: string;
}

/**
 * The claim's verification state is a SEMANTIC badge color. Basecoat ships only
 * `destructive`, so the states map onto the project `data-tone` family — see
 * `badges.css`. A hypothesis or an open question is not a verdict, so it stays
 * neutral rather than borrowing a status hue it has not earned.
 */
function claimTone(
  status: string,
): "success" | "warning" | "danger" | "neutral" {
  if (status === "supported") return "success";
  if (status === "partial") return "warning";
  if (status === "contradicted") return "danger";
  return "neutral";
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

  // Which page the viewer shows. When an all-pages claim search is
  // active, the found bbox carries the page it matched on, so the
  // viewer jumps there once the scan resolves; until then it holds
  // whatever `activePage` was (null for a claim → no forced jump).
  const effectivePage: number | undefined = searchActive
    ? chunkHighlight.bbox?.page ?? activePage ?? undefined
    : activePage ?? undefined;

  function highlightStored(page: number, type: ProvenanceType, bbox: BBox | null) {
    setSearchContent(null);
    setSearchPage(null);
    setActiveType(type);
    setActivePage(page);
    setActiveBbox(bbox);
  }

  // `page` may be null: claims often carry a verbatim quote but no
  // resolvable page (the in-process ingestion path does not persist
  // evidence-chunk rows, so the claim→chunk→page link is empty). A
  // null page puts the search into all-pages mode; the viewer then
  // follows the page the search lands on (see `effectivePage`).
  function highlightChunk(page: number | null, content: string) {
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
      <div className="empty viewer-page__empty">
        <header>
          <p>No source id in URL.</p>
        </header>
        <section>
          <button
            type="button"
            className="btn"
            data-variant="outline"
            onClick={() => history.back()}
          >
            Go back
          </button>
        </section>
      </div>
    );
  }

  // The paper's real title. The header used to read "Source e9db7c7b" — a
  // truncated primary key, shown to a scientist, naming nothing.
  const sourceTitle =
    (evidence as unknown as { title?: string } | null)?.title ??
    claims.find((c) => c.source?.title)?.source?.title ??
    null;

  // How much of this paper's evidence we can actually stand behind. The user
  // asked for a quality panel; it belongs HERE — where they are deciding
  // whether to believe the citations — and not buried in an admin page.
  const summary = trustSummary(
    claims.map((c) => ({ bbox: c.anchor_bbox, verbatim: c.anchor_verbatim })),
  );

  return (
    <div className="viewer-page">
      <header className="viewer-page__topbar">
        <button
          type="button"
          className="btn viewer-page__back"
          data-variant="outline"
          data-size="sm"
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
          page={effectivePage}
          showZoomControls
        />
        <aside className="viewer-page__sidebar" aria-label="Evidence list">
          <h3>Evidence</h3>
          {claims.length ? (
            <section>
              <h4>Claims ({claims.length})</h4>
              <div className="viewer-page__trust-summary">
                {summary.verbatim > 0 ? (
                  <TrustBadge level="verbatim" />
                ) : null}
                {summary.approximate > 0 ? (
                  <TrustBadge level="approximate" />
                ) : null}
                {summary["not-found"] > 0 ? (
                  <TrustBadge level="not-found" />
                ) : null}
              </div>
              <ul className="viewer-page__claims">
                {claims.map((c) => {
                  const chunk = c.chunk;
                  // Prefer the verbatim quote (the exact sentence the claim
                  // was extracted from) over the whole chunk for a tighter
                  // highlight; fall back to the chunk content.
                  const searchText = c.quote || chunk?.content || "";
                  const page = c.anchor_page ?? chunk?.page ?? null;
                  const trust = trustOf(c.anchor_bbox, c.anchor_verbatim);
                  // A citation we could not locate gets no box, and says why.
                  // Clicking it would launch a search of a document that does
                  // not contain the text — an animation of a failure.
                  const canHighlight = !!searchText && trust !== "not-found";
                  return (
                    <li key={c.id} className="viewer-page__claim">
                      <button
                        type="button"
                        className="btn viewer-page__claim-btn"
                        data-variant="outline"
                        data-size="sm"
                        disabled={!canHighlight}
                        onClick={() => {
                          if (!canHighlight) return;
                          // The box was found at INGESTION, by looking for the
                          // quote in the PDF's text layer, and stored. Use it:
                          // the highlight is instant instead of re-scanning the
                          // document on every click (a second on a paper,
                          // fifteen on a book).
                          if (c.anchor_bbox && page) {
                            highlightStored(page, "chunk", c.anchor_bbox as BBox);
                            return;
                          }
                          // Not yet anchored (this paper predates the anchoring
                          // pass): fall back to searching in the browser.
                          highlightChunk(page, searchText);
                        }}
                      >
                        <span className="viewer-page__claim-head">
                          <span
                            className="badge claim-status"
                            data-tone={claimTone(c.status)}
                          >
                            {c.status.replace(/_/g, " ")}
                          </span>
                          <TrustBadge level={trust} page={page} />
                        </span>
                        <span className="claim-text">{c.claim}</span>
                        {/*
                          THE QUOTE, WHERE THE CLAIM IS.

                          The card showed only the synthesised claim while the
                          viewer highlighted the verbatim quote — two texts,
                          worded differently, and the user asked to trust they
                          matched. They read the mismatch as a bug in the
                          highlight. It was not: we were never showing them what
                          was about to be highlighted.

                          Now what you read is what gets highlighted.
                        */}
                        {c.quote ? (
                          <span className="evidence-quote viewer-page__claim-quote">
                            {c.quote}
                          </span>
                        ) : null}
                        <TrustNote level={trust} />
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
                        className="btn"
                        data-variant="outline"
                        data-size="sm"
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
                      className="btn"
                      data-variant="outline"
                      data-size="sm"
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
            <div className="empty">
              <header>
                <p>No extracted evidence for this source.</p>
              </header>
            </div>
          ) : null}
        </aside>
      </main>
    </div>
  );
}
