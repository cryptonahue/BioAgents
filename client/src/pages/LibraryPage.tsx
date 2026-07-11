import { useState } from "preact/hooks";
import { route } from "preact-router";
import { useLibraryList } from "../hooks";
import type { LibraryPaper } from "../hooks/useLibrary";
import { fetchPaperAbstract } from "../hooks/useLibrary";
import { Icon } from "../components/icons";
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
 * Single Library card. Manages its own hover state so the FULL abstract is
 * fetched lazily (once, cached) from the detail endpoint on first hover/focus
 * and revealed via a CSS expand — keeping the list payload light. The title is
 * clamped to two lines and reveals in full on hover (native tooltip + expand).
 */
function PaperCard({ paper }: { paper: LibraryPaper }) {
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
                    ? "Sin evidencias"
                    : `${paper.evidenceCount} evidencia${
                        paper.evidenceCount === 1 ? "" : "s"
                      }`}
                </span>
              )}
              {typeof paper.bioprospectingFactCount === "number" &&
                paper.bioprospectingFactCount > 0 && (
                  <span className="paper-biofacts">
                    {paper.bioprospectingFactCount} datos
                  </span>
                )}
              {paper.trustTier && (
                <span
                  className={`paper-trust paper-trust--${paper.trustTier}`}
                  title={`Trust tier: ${trustLabel(paper.trustTier)}`}
                >
                  {trustLabel(paper.trustTier)}
                </span>
              )}
              {paper.type && (
                <span className="paper-tag">{paper.type.toUpperCase()}</span>
              )}
              {paper.chunkCount != null && (
                <span>{paper.chunkCount} fragmentos</span>
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
              <span key={`t-${t}`} className="paper-chip paper-chip--taxon">
                {t}
              </span>
            ))}
            {paper.geography?.map((g) => (
              <span key={`g-${g}`} className="paper-chip paper-chip--geo">
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
            className="paper-action paper-action--primary"
            onClick={() => route(`/library/${paper.docId}`)}
          >
            <Icon name="messageSquare" size={15} />
            <span>Chat with paper</span>
          </button>
          <button
            className="paper-action paper-action--secondary"
            aria-label={`View evidence for ${paper.title || "paper"}`}
            onClick={() => route(`/library/${paper.docId}/viewer`)}
          >
            <Icon name="microscope" size={15} />
            <span>View evidence</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function LibraryPage({ coralGptMode = false }: LibraryPageProps) {
  const { papers, isLoading, error, refetch } = useLibraryList();
  const [uploadError, setUploadError] = useState("");
  const [isUploading, setIsUploading] = useState(false);

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
      <header className="library-topbar">
        <div className="library-brand" onClick={() => route("/chat")}>
          <img src="/images/token.png" alt="" width={24} height={24} />
          <span className="library-brand-text">
            {coralGptMode ? "CoralGPT" : "BioAgents"} · Library
          </span>
        </div>
        <button className="library-link-btn" onClick={() => route("/chat")}>
          <Icon name="messageSquare" size={16} />
          <span>Go to chat</span>
        </button>
        <button className="library-link-btn" onClick={() => route("/brain")}>
          <Icon name="brainCircuit" size={16} />
          <span>Research Brain</span>
        </button>
      </header>

      <main className="library-main">
        <div className="library-heading">
          <h1>Paper library</h1>
          <p>
            Papers ingested into the knowledge base. Open one to read it
            and ask questions answered only from its content.
          </p>
        </div>

        <div className="brain-upload-row">
          <label className="library-link-btn brain-upload-btn">
            <Icon name="upload" size={16} />
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
        </div>

        {isLoading && <div className="library-state">Loading papers…</div>}

        {error && !isLoading && (
          <div className="library-state library-state-error">
            <p>{error}</p>
            <button className="library-link-btn" onClick={() => refetch()}>
              <Icon name="refresh" size={16} />
              <span>Retry</span>
            </button>
          </div>
        )}

        {!isLoading && !error && papers.length === 0 && (
          <div className="library-state">
            No papers ingested yet. Add files to the documents folder
            (KNOWLEDGE_DOCS_PATH) and restart the server.
          </div>
        )}

        {!isLoading && !error && papers.length > 0 && (
          <div className="library-grid">
            {papers.map((paper) => (
              <PaperCard key={paper.docId} paper={paper} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
