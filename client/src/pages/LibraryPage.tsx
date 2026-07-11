import { useState } from "preact/hooks";
import { route } from "preact-router";
import { useLibraryList } from "../hooks";
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
              <div key={paper.docId} className="paper-card-wrap">
                <div className="paper-card">
                  <div className="paper-card-top">
                    <div className="paper-card-icon">
                      <Icon name="bookOpen" size={22} />
                    </div>
                    <div className="paper-card-body">
                      <h3 className="paper-card-title">{paper.title}</h3>
                      <div className="paper-card-meta">
                        {typeof paper.evidenceCount === "number" && (
                          <span
                            className={`paper-evidence${
                              paper.evidenceCount === 0
                                ? " paper-evidence--empty"
                                : ""
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
                        {paper.type && (
                          <span className="paper-tag">{paper.type.toUpperCase()}</span>
                        )}
                        {paper.chunkCount != null && (
                          <span>{paper.chunkCount} fragmentos</span>
                        )}
                        {paper.size ? <span>{formatSize(paper.size)}</span> : null}
                      </div>
                    </div>
                  </div>
                  {/*
                    Card footer with two explicit actions. Primary
                    ("Chat with paper") routes to the grounded RAG page.
                    Secondary ("View evidence") routes to the library
                    viewer, which resolves the docId to its underlying
                    research source and shows the provenance viewer. Both
                    navigate within the SPA (same tab). Two labelled
                    buttons replace the previous whole-card button +
                    "view source" badge so each action is unambiguous.

                    Note: the list endpoint (GET /api/library) does not
                    return researchSourceId — only the detail endpoint
                    does — so resolution is deferred to the viewer page.
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
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
