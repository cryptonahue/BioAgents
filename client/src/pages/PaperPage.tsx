import { useEffect, useRef, useState } from "preact/hooks";
import { route } from "preact-router";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { askPaper, getPaperHistory, usePaperMeta, type AskSource } from "../hooks";
import { Icon } from "../components/icons";
import { useResearchBrainChunk, useResearchBrainClaims } from "../hooks/useResearchBrain";

interface PaperPageProps {
  path?: string;
  docId?: string;
  coralGptMode?: boolean;
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  sources?: AskSource[];
  mode?: "full" | "rag";
  tooLarge?: boolean;
}

const FULL_CONTEXT_TOKEN_LIMIT = 120000;

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string);
}

function readFocusedFragmentFromUrl(): number | null {
  const params = new URLSearchParams(window.location.search);
  const raw =
    params.get("fragmento") ||
    params.get("fragment") ||
    window.location.hash.match(/fragmento?-(\d+)/i)?.[1] ||
    window.location.hash.match(/chunk-(\d+)/i)?.[1];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function PaperPage({ docId, coralGptMode = false }: PaperPageProps) {
  const { meta, isLoading, error } = usePaperMeta(docId);
  const { claims, isLoading: claimsLoading } = useResearchBrainClaims(
    meta?.researchSourceId,
  );
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [fullContext, setFullContext] = useState(false);
  const [isAsking, setIsAsking] = useState(false);
  const [askError, setAskError] = useState("");
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [focusedFragment, setFocusedFragment] = useState<number | null>(null);
  const {
    chunk: focusedChunk,
    isLoading: focusedChunkLoading,
    error: focusedChunkError,
  } = useResearchBrainChunk(meta?.researchSourceId, focusedFragment);
  const messagesRef = useRef<HTMLDivElement>(null);

  // Load persisted history for this paper on open.
  useEffect(() => {
    if (!docId) return;
    setFocusedFragment(readFocusedFragmentFromUrl());
    let cancelled = false;
    (async () => {
      const history = await getPaperHistory(docId);
      if (cancelled || history.length === 0) return;
      setTurns(
        history.map((h) => ({ role: h.role, content: h.content })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const focusedClaim =
    focusedFragment == null
      ? null
      : claims.find(
          (claim) => Number(claim.chunk?.chunk_index) === focusedFragment,
        ) || null;
  const focusedEvidenceContent =
    focusedClaim?.chunk?.content || focusedChunk?.content || "";
  const focusedEvidencePage = focusedClaim?.chunk?.page || focusedChunk?.page;

  const fullContextTooBig =
    meta?.estTokens != null && meta.estTokens > FULL_CONTEXT_TOKEN_LIMIT;

  const canEmbed =
    meta?.type === "pdf" || meta?.type === "md" || meta?.type === "txt";

  const viewerSrc =
    meta?.fileUrl && focusedEvidencePage
      ? `${meta.fileUrl}#page=${focusedEvidencePage}`
      : meta?.fileUrl;

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      if (messagesRef.current) {
        messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
      }
    });
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const question = input.trim();
    if (!question || isAsking || !docId) return;

    setAskError("");
    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    const nextTurns: ChatTurn[] = [...turns, { role: "user", content: question }];
    setTurns(nextTurns);
    setInput("");
    setIsAsking(true);
    scrollToBottom();

    try {
      const result = await askPaper(docId, question, { fullContext, history });
      setTurns([
        ...nextTurns,
        {
          role: "assistant",
          content: result.answer,
          sources: result.sources,
          mode: result.mode,
          tooLarge: result.tooLarge,
        },
      ]);
      scrollToBottom();
    } catch (err: any) {
      setAskError(err?.message || "Could not respond");
      setTurns(nextTurns);
    } finally {
      setIsAsking(false);
    }
  };

  return (
    <div className="paper-page">
      <header className="library-topbar">
        <div className="library-brand" onClick={() => route("/library")}>
          <Icon name="chevronLeft" size={18} />
          <span className="library-brand-text">Library</span>
        </div>
        <div className="paper-topbar-title" title={meta?.title}>
          {meta?.title || (isLoading ? "Loading…" : "Paper")}
        </div>
        <button className="library-link-btn" onClick={() => route("/chat")}>
          <Icon name="messageSquare" size={16} />
          <span>General chat</span>
        </button>
      </header>

      {error && (
        <div className="library-state library-state-error">{error}</div>
      )}

      {!error && (
        <div className="paper-split">
          {/* Viewer */}
          <section className="paper-viewer">
            {focusedFragment != null && (
              <div className="paper-evidence-focus">
                <div className="paper-evidence-focus-header">
                  <span>Fragment {focusedFragment}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setFocusedFragment(null);
                      if (docId) route(`/library/${docId}`, true);
                    }}
                    aria-label="Cerrar fragmento enfocado"
                  >
                    ×
                  </button>
                </div>
                {focusedClaim ? (
                  <>
                    <p className="paper-evidence-focus-claim">
                      {focusedClaim.claim}
                    </p>
                    {focusedEvidenceContent && (
                      <blockquote>
                        {focusedEvidenceContent.slice(0, 900)}
                        {focusedEvidenceContent.length > 900 ? "…" : ""}
                      </blockquote>
                    )}
                  </>
                ) : focusedChunkLoading ? (
                  <p className="paper-evidence-focus-empty">
                    Loading fragment…
                  </p>
                ) : focusedEvidenceContent ? (
                  <blockquote>
                    {focusedEvidenceContent.slice(0, 1100)}
                    {focusedEvidenceContent.length > 1100 ? "…" : ""}
                  </blockquote>
                ) : focusedChunkError ? (
                  <p className="paper-evidence-focus-empty">
                    Could not load that fragment: {focusedChunkError}
                  </p>
                ) : (
                  <p className="paper-evidence-focus-empty">
                    The fragment is selected, but no associated text was
                    found in Research Brain.
                  </p>
                )}
              </div>
            )}
            {isLoading && <div className="library-state">Loading…</div>}
            {!isLoading && meta && canEmbed && (
              <iframe
                className="paper-iframe"
                src={viewerSrc}
                title={meta.title}
              />
            )}
            {!isLoading && meta && !canEmbed && (
              <div className="library-state">
                <p>The embedded preview is not available for this file type.</p>
                <a
                  className="library-link-btn"
                  href={meta.fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="download" size={16} />
                  <span>Open file</span>
                </a>
              </div>
            )}
          </section>

          {/* Chat */}
          <section className="paper-chat">
            <div className="paper-chat-header">
              <div className="paper-chat-meta">
                {meta?.doi && (
                  <a
                    className="paper-doi"
                    href={meta.doiUrl || `https://doi.org/${meta.doi}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open DOI"
                  >
                    DOI: {meta.doi}
                  </a>
                )}
                {meta?.estTokens != null && (
                  <span className="paper-tokens">
                    ~{meta.estTokens.toLocaleString()} tokens
                  </span>
                )}
              </div>
            </div>

            {meta?.researchSourceId && (
              <div className="paper-claims-strip">
                <div className="paper-claims-strip-title">
                  <Icon name="brainCircuit" size={15} />
                  <span>Extracted claims</span>
                </div>
                {claimsLoading && <span>Loading claims…</span>}
                {!claimsLoading && claims.length === 0 && (
                  <span>No extracted claims yet.</span>
                )}
                {!claimsLoading && claims.length > 0 && (
                  <div className="paper-claims-mini-list">
                    {claims.slice(0, 4).map((claim) => (
                      <div key={claim.id} className="paper-claim-mini">
                        <span>{claim.status}</span>
                        <p>{claim.claim}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="paper-chat-messages" ref={messagesRef}>
              {turns.length === 0 && (
                <div className="paper-chat-empty">
                  <Icon name="sparkles" size={20} />
                  <p>
                    Ask questions about this paper. Answers are based solely
                    on its content and cite the fragments used.
                  </p>
                </div>
              )}

              {turns.map((turn, i) => (
                <div
                  key={i}
                  className={`paper-msg paper-msg-${turn.role}`}
                >
                  {turn.role === "assistant" ? (
                    <>
                      {turn.tooLarge && (
                        <div className="paper-notice">
                          The paper is too large for full-context; it was
                          answered with fragment search (RAG).
                        </div>
                      )}
                      <div
                        className="paper-msg-content"
                        dangerouslySetInnerHTML={{
                          __html: renderMarkdown(turn.content),
                        }}
                      />
                      {turn.sources && turn.sources.length > 0 && (
                        <div className="paper-sources">
                          <div className="paper-sources-label">Sources</div>
                          <div className="paper-sources-chips">
                            {turn.sources.map((s) => {
                              const key = `${i}-${s.index}`;
                              return (
                                <button
                                  key={key}
                                  className={`paper-source-chip ${activeSource === key ? "active" : ""}`}
                                  onClick={() =>
                                    setActiveSource(
                                      activeSource === key ? null : key,
                                    )
                                  }
                                  title={`Fragment ${s.chunkIndex}`}
                                >
                                  [{s.index}]
                                </button>
                              );
                            })}
                          </div>
                          {turn.sources.map((s) => {
                            const key = `${i}-${s.index}`;
                            if (activeSource !== key) return null;
                            return (
                              <div key={key} className="paper-source-detail">
                                <span className="paper-source-detail-idx">
                                  [{s.index}] fragmento {s.chunkIndex}
                                </span>
                                <p>{s.snippet}…</p>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="paper-msg-content">{turn.content}</div>
                  )}
                </div>
              ))}

              {isAsking && (
                <div className="paper-msg paper-msg-assistant">
                  <div className="paper-typing">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              )}
            </div>

            {askError && <div className="paper-chat-error">{askError}</div>}

            <form className="paper-chat-input" onSubmit={handleSubmit}>
              <div className="paper-context-toggle">
                <label
                  className={`paper-toggle ${fullContextTooBig ? "disabled" : ""}`}
                  title={
                    fullContextTooBig
                      ? "The paper exceeds the full-context limit; RAG will be used."
                      : "Send the full paper text as context"
                  }
                >
                  <input
                    type="checkbox"
                    checked={fullContext && !fullContextTooBig}
                    disabled={fullContextTooBig}
                    onChange={(e) =>
                      setFullContext((e.target as HTMLInputElement).checked)
                    }
                  />
                  <span>Use full paper</span>
                </label>
                <span className="paper-mode-hint">
                  {fullContext && !fullContextTooBig
                    ? "Contexto completo"
                    : "RAG (fragmentos)"}
                </span>
              </div>
              <div className="paper-input-row">
                <input
                  type="text"
                  className="paper-input"
                  placeholder="Ask something about this paper…"
                  value={input}
                  onInput={(e) => setInput((e.target as HTMLInputElement).value)}
                  disabled={isAsking}
                />
                <button
                  type="submit"
                  className="paper-send-btn"
                  disabled={isAsking || !input.trim()}
                >
                  <Icon name="send" size={16} />
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
