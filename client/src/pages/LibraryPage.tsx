import { route } from "preact-router";
import { useLibraryList } from "../hooks";
import { Icon } from "../components/icons";

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

  return (
    <div className="library-page">
      <header className="library-topbar">
        <div className="library-brand" onClick={() => route("/chat")}>
          <img src="/images/token.png" alt="" width={24} height={24} />
          <span className="library-brand-text">
            {coralGptMode ? "CoralGPT" : "BioAgents"} · Biblioteca
          </span>
        </div>
        <button className="library-link-btn" onClick={() => route("/chat")}>
          <Icon name="messageSquare" size={16} />
          <span>Ir al chat</span>
        </button>
      </header>

      <main className="library-main">
        <div className="library-heading">
          <h1>Biblioteca de papers</h1>
          <p>
            Papers ingestados en la base de conocimiento. Abrí uno para leerlo y
            hacer preguntas respondidas solo con su contenido.
          </p>
        </div>

        {isLoading && <div className="library-state">Cargando papers…</div>}

        {error && !isLoading && (
          <div className="library-state library-state-error">
            <p>{error}</p>
            <button className="library-link-btn" onClick={() => refetch()}>
              <Icon name="refresh" size={16} />
              <span>Reintentar</span>
            </button>
          </div>
        )}

        {!isLoading && !error && papers.length === 0 && (
          <div className="library-state">
            No hay papers ingestados todavía. Agregá archivos a la carpeta de
            documentos (KNOWLEDGE_DOCS_PATH) y reiniciá el servidor.
          </div>
        )}

        {!isLoading && !error && papers.length > 0 && (
          <div className="library-grid">
            {papers.map((paper) => (
              <button
                key={paper.docId}
                className="paper-card"
                onClick={() => route(`/library/${paper.docId}`)}
              >
                <div className="paper-card-icon">
                  <Icon name="bookOpen" size={22} />
                </div>
                <div className="paper-card-body">
                  <h3 className="paper-card-title">{paper.title}</h3>
                  <div className="paper-card-meta">
                    {paper.type && (
                      <span className="paper-tag">{paper.type.toUpperCase()}</span>
                    )}
                    {paper.chunkCount != null && (
                      <span>{paper.chunkCount} fragmentos</span>
                    )}
                    {paper.size ? <span>{formatSize(paper.size)}</span> : null}
                  </div>
                </div>
                <div className="paper-card-arrow">
                  <Icon name="chevronRight" size={18} />
                </div>
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
