import { useState } from "preact/hooks";
import { route } from "preact-router";
import { useLibraryList } from "../hooks";
import type { LibraryPaper } from "../hooks/useLibrary";
import { fetchPaperAbstract, deleteLibraryPaper } from "../hooks/useLibrary";
import { Icon } from "../components/icons";
import { BUTTON_ICON_CLASS } from "../components/ui/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { uploadResearchBrainSource } from "../hooks/useResearchBrain";

interface LibraryPageProps {
  path?: string;
  coralGptMode?: boolean;
}

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/**
 * Derive a human-readable display title from the paper filename. Prefers a
 * real structured title when the server resolved one from
 * research_sources.metadata; otherwise strips the trailing
 * `_YEAR_Publisher-…` metadata segment and the extension, then turns
 * separators into spaces. Best-effort — never throws, falls back to the raw
 * filename.
 */
function displayTitle(paper: LibraryPaper): string {
  if (paper.metaTitle && paper.metaTitle.trim().length > 3) {
    return paper.metaTitle.trim();
  }
  const raw = paper.title || "";
  let s = raw.replace(/\.[a-z0-9]+$/i, "");
  // Drop a trailing metadata tail that starts at a 4-digit year.
  s = s.replace(/[_\-\s]((?:19|20)\d{2})[_\-\s].*$/, "");
  s = s
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || raw;
}

/** Sub-line combining year and publisher, e.g. "2018 · Springer". */
function subline(paper: LibraryPaper): string {
  const parts: string[] = [];
  if (paper.year != null) parts.push(String(paper.year));
  if (paper.publisher) parts.push(paper.publisher);
  return parts.join(" · ");
}

function trustLabel(tier?: string): string {
  if (!tier) return "";
  return tier.replace(/[_-]+/g, " ");
}

/**
 * The trust tier is a SEMANTIC badge color: the two vetted tiers earn the
 * success tone, everything else stays neutral. Basecoat has no `success`
 * variant, so this maps onto the project `data-tone` — see `badges.css`.
 */
function trustTone(tier?: string): "success" | "neutral" {
  return tier === "foundational" || tier === "curated" ? "success" : "neutral";
}

/**
 * Small, subtle destructive action shared by the card and the row. Confirms
 * before deleting (window.confirm), then removes the paper and its evidence
 * server-side and asks the parent to refresh the list on success. Errors are
 * surfaced through the page-level `onError` affordance. The click is stopped
 * from bubbling so it never triggers the card/row navigation.
 */
function DeletePaperButton({
  paper,
  onDeleted,
  onError,
}: {
  paper: LibraryPaper;
  onDeleted: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const title = displayTitle(paper);

  const doDelete = async () => {
    if (busy) return;
    setBusy(true);
    onError("");
    try {
      await deleteLibraryPaper(paper.docId);
      setConfirmOpen(false);
      onDeleted();
    } catch (err: any) {
      onError(err?.message || "Could not delete the paper");
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="btn paper-action-delete"
        data-variant="outline"
        data-size="icon"
        onClick={(e) => {
          e.stopPropagation();
          setConfirmOpen(true);
        }}
        title={`Delete "${title}"`}
        aria-label={`Delete ${title}`}
      >
        <Icon name="trash" size={15} className={BUTTON_ICON_CLASS} />
      </button>
      <ConfirmDialog
        open={confirmOpen}
        title="Delete paper"
        message={`"${title}" and all its evidence will be permanently removed. This can't be undone.`}
        confirmLabel="Delete"
        busy={busy}
        onConfirm={doDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

/**
 * Single Library card. Manages its own hover state so the FULL abstract is
 * fetched lazily (once, cached) from the detail endpoint on first hover/focus
 * and revealed via a CSS expand — keeping the list payload light. The title is
 * clamped to two lines and reveals in full on hover (native tooltip + expand).
 */
function PaperCard({
  paper,
  onDeleted,
  onError,
}: {
  paper: LibraryPaper;
  onDeleted: () => void;
  onError: (msg: string) => void;
}) {
  const [abstract, setAbstract] = useState<string>("");
  const [loadedAbstract, setLoadedAbstract] = useState(false);
  const title = displayTitle(paper);
  const sub = subline(paper);

  const loadAbstract = () => {
    if (loadedAbstract) return;
    setLoadedAbstract(true);
    fetchPaperAbstract(paper.docId).then((text) => {
      if (text) setAbstract(text);
    });
  };

  return (
    <div className="paper-card-wrap">
      <div
        className="paper-card"
        onMouseEnter={loadAbstract}
        onFocusCapture={loadAbstract}
      >
        <div className="paper-card-top">
          <div className="paper-card-icon">
            <Icon name="bookOpen" size={22} />
          </div>
          <div className="paper-card-body">
            <h3 className="paper-card-title" title={title}>
              {title}
            </h3>
            {sub && <div className="paper-card-subtitle">{sub}</div>}
            <div className="paper-card-meta">
              {typeof paper.evidenceCount === "number" && (
                <span
                  className={`paper-evidence${
                    paper.evidenceCount === 0 ? " paper-evidence--empty" : ""
                  }`}
                >
                  <Icon name="microscope" size={12} />
                  {paper.evidenceCount === 0
                    ? "No evidence"
                    : `${paper.evidenceCount} evidence`}
                </span>
              )}
              {typeof paper.bioprospectingFactCount === "number" &&
                paper.bioprospectingFactCount > 0 && (
                  <span className="badge" data-tone="violet">
                    {paper.bioprospectingFactCount} facts
                  </span>
                )}
              {paper.trustTier && (
                <span
                  className="badge paper-trust"
              data-tone={trustTone(paper.trustTier)}
                  title={`Trust tier: ${trustLabel(paper.trustTier)}`}
                >
                  {trustLabel(paper.trustTier)}
                </span>
              )}
              {paper.type && (
                <span className="badge paper-tag" data-tone="neutral">
                  {paper.type.toUpperCase()}
                </span>
              )}
              {paper.chunkCount != null && (
                <span>{paper.chunkCount} fragments</span>
              )}
              {paper.size ? (
                <span title={`${paper.size} bytes`}>
                  {formatSize(paper.size)}
                </span>
              ) : null}
              {paper.doiUrl && (
                <a
                  className="paper-doi-link"
                  href={paper.doiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  DOI
                </a>
              )}
            </div>
          </div>
        </div>

        {(paper.taxa?.length || paper.geography?.length) ? (
          <div className="paper-chips">
            {paper.taxa?.map((t) => (
              <span
                key={`t-${t}`}
                className="badge paper-chip--taxon"
                data-tone="brand"
              >
                {t}
              </span>
            ))}
            {paper.geography?.map((g) => (
              <span key={`g-${g}`} className="badge" data-tone="info">
                <Icon name="mapPin" size={11} />
                {g}
              </span>
            ))}
          </div>
        ) : null}

        {abstract && (
          <p className="paper-card-abstract" title={abstract}>
            {abstract}
          </p>
        )}

        {/*
          Card footer with two explicit actions. Primary ("Chat with paper")
          routes to the grounded RAG page. Secondary ("View evidence") routes
          to the library viewer, which resolves the docId to its underlying
          research source and shows the provenance viewer. Both navigate within
          the SPA (same tab). Kept exactly as before.
        */}
        <div className="paper-card-actions">
          <button
            className="btn paper-action"
            data-variant="primary"
            onClick={() => route(`/library/${paper.docId}`)}
          >
            <Icon name="messageSquare" size={15} className={BUTTON_ICON_CLASS} />
            <span>Chat with paper</span>
          </button>
          <button
            className="btn paper-action"
            data-variant="outline"
            aria-label={`View evidence for ${paper.title || "paper"}`}
            onClick={() => route(`/library/${paper.docId}/viewer`)}
          >
            <Icon name="microscope" size={15} className={BUTTON_ICON_CLASS} />
            <span>View evidence</span>
          </button>
          <DeletePaperButton
            paper={paper}
            onDeleted={onDeleted}
            onError={onError}
          />
        </div>
      </div>
    </div>
  );
}

/** Compact list-view row — same data as the card, laid out horizontally. */
function PaperRow({
  paper,
  onDeleted,
  onError,
}: {
  paper: LibraryPaper;
  onDeleted: () => void;
  onError: (msg: string) => void;
}) {
  const title = displayTitle(paper);
  const sub = subline(paper);
  return (
    <div className="paper-row">
      <div className="paper-row-icon">
        <Icon name="bookOpen" size={18} />
      </div>
      <div className="paper-row-main">
        <div className="paper-row-titleline">
          <span className="paper-row-title" title={title}>
            {title}
          </span>
          {sub && <span className="paper-row-sub">{sub}</span>}
        </div>
        <div className="paper-row-meta">
          {typeof paper.evidenceCount === "number" && (
            <span
              className={`paper-evidence${
                paper.evidenceCount === 0 ? " paper-evidence--empty" : ""
              }`}
            >
              <Icon name="microscope" size={11} />
              {paper.evidenceCount === 0
                ? "No evidence"
                : `${paper.evidenceCount} ev.`}
            </span>
          )}
          {paper.chunkCount != null && <span>{paper.chunkCount} frag.</span>}
          {typeof paper.bioprospectingFactCount === "number" &&
            paper.bioprospectingFactCount > 0 && (
              <span className="badge" data-tone="violet">
                {paper.bioprospectingFactCount} facts
              </span>
            )}
          {paper.trustTier && (
            <span
              className="badge paper-trust"
              data-tone={trustTone(paper.trustTier)}
              title={`Trust tier: ${trustLabel(paper.trustTier)}`}
            >
              {trustLabel(paper.trustTier)}
            </span>
          )}
          {paper.doiUrl && (
            <a
              className="paper-doi-link"
              href={paper.doiUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              DOI
            </a>
          )}
        </div>
      </div>
      <div className="paper-row-actions">
        <button
          className="btn paper-action"
          data-variant="primary"
          onClick={() => route(`/library/${paper.docId}`)}
          title="Chat with paper"
        >
          <Icon name="messageSquare" size={15} className={BUTTON_ICON_CLASS} />
          <span>Chat</span>
        </button>
        <button
          className="btn paper-action"
          data-variant="outline"
          aria-label={`View evidence for ${paper.title || "paper"}`}
          onClick={() => route(`/library/${paper.docId}/viewer`)}
          title="View evidence"
        >
          <Icon name="microscope" size={15} className={BUTTON_ICON_CLASS} />
          <span>Evidence</span>
        </button>
        <DeletePaperButton
          paper={paper}
          onDeleted={onDeleted}
          onError={onError}
        />
      </div>
    </div>
  );
}

type LibraryView = "list" | "grid";
const LIBRARY_VIEW_KEY = "library_view_mode";
function getInitialView(): LibraryView {
  try {
    const v = localStorage.getItem(LIBRARY_VIEW_KEY);
    if (v === "grid" || v === "list") return v;
  } catch {
    // localStorage unavailable — fall through to default
  }
  return "list";
}

export function LibraryPage({ coralGptMode = false }: LibraryPageProps) {
  const { papers, isLoading, error, refetch } = useLibraryList();
  const [uploadError, setUploadError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [viewMode, setViewMode] = useState<LibraryView>(getInitialView());

  const setView = (v: LibraryView) => {
    setViewMode(v);
    try {
      localStorage.setItem(LIBRARY_VIEW_KEY, v);
    } catch {
      // ignore — non-persistent is fine
    }
  };

  const handleUpload = async (file?: File) => {
    if (!file) return;
    setIsUploading(true);
    setUploadError("");
    try {
      await uploadResearchBrainSource(file);
      await refetch();
    } catch (err: any) {
      setUploadError(err?.message || "Could not load the paper");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="library-page">
      <main className="library-main">
        <div className="library-heading">
          <h1>Paper library</h1>
          <p>
            Papers ingested into the knowledge base. Open one to read it
            and ask questions answered only from its content.
          </p>
        </div>

        <div className="brain-upload-row">
          <label className="btn library-link-btn brain-upload-btn" data-variant="outline">
            <Icon name="upload" size={16} className={BUTTON_ICON_CLASS} />
            <span>{isUploading ? "Loading…" : "Upload paper"}</span>
            <input
              type="file"
              accept=".pdf,.md,.txt,.docx"
              disabled={isUploading}
              onChange={(e) =>
                handleUpload((e.target as HTMLInputElement).files?.[0])
              }
            />
          </label>
          {uploadError && <span className="brain-error">{uploadError}</span>}
          <div className="library-view-toggle">
            <button
              className="btn library-view-btn"
              data-variant="ghost"
              data-size="icon-sm"
              data-tone={viewMode === "list" ? "brand" : undefined}
              onClick={() => setView("list")}
              title="List view"
              aria-label="List view"
              aria-pressed={viewMode === "list"}
            >
              <Icon name="list" size={16} className={BUTTON_ICON_CLASS} />
            </button>
            <button
              className="btn library-view-btn"
              data-variant="ghost"
              data-size="icon-sm"
              data-tone={viewMode === "grid" ? "brand" : undefined}
              onClick={() => setView("grid")}
              title="Card view"
              aria-label="Card view"
              aria-pressed={viewMode === "grid"}
            >
              <Icon name="grid" size={16} className={BUTTON_ICON_CLASS} />
            </button>
          </div>
        </div>

        {deleteError && (
          <div className="library-state library-state-error">
            <p>{deleteError}</p>
          </div>
        )}

        {isLoading && <div className="library-state">Loading papers…</div>}

        {error && !isLoading && (
          <div className="library-state library-state-error">
            <p>{error}</p>
            <button
              className="btn library-link-btn"
              data-variant="outline"
              onClick={() => refetch()}
            >
              <Icon name="refresh" size={16} className={BUTTON_ICON_CLASS} />
              <span>Retry</span>
            </button>
          </div>
        )}

        {!isLoading && !error && papers.length === 0 && (
          <div className="empty">
            <header>
              <h3>No papers yet</h3>
              <p>
                Add files to the documents folder (KNOWLEDGE_DOCS_PATH) and
                restart the server.
              </p>
            </header>
          </div>
        )}

        {!isLoading && !error && papers.length > 0 && (
          viewMode === "grid" ? (
            <div className="library-grid">
              {papers.map((paper) => (
                <PaperCard
                  key={paper.docId}
                  paper={paper}
                  onDeleted={refetch}
                  onError={setDeleteError}
                />
              ))}
            </div>
          ) : (
            <div className="library-list">
              {papers.map((paper) => (
                <PaperRow
                  key={paper.docId}
                  paper={paper}
                  onDeleted={refetch}
                  onError={setDeleteError}
                />
              ))}
            </div>
          )
        )}
      </main>
    </div>
  );
}
