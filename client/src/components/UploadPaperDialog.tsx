/**
 * Upload a paper: drop it, pick it, or paste a URL — then watch what happens
 * to it.
 *
 * THE PROGRESS IS NOT DECORATION.
 *
 * The upload used to run the whole pipeline inside one request — parse, embed
 * every chunk, an LLM pass for claims, another for bioprospecting facts, then
 * anchoring — two to five minutes behind a gateway that gives up after a
 * hundred. So it did not fail; it LIED. The browser said "Failed to upload
 * paper" while the server quietly finished, and the paper turned up in the
 * library anyway, with the user believing it had not.
 *
 * The server now returns as soon as the file is safe and works behind the
 * response. This dialog asks what it is doing and says so. Showing the stages
 * is what makes the honest answer possible.
 *
 * And one of those stages is "Verifying citations against the PDF". Watching it
 * go by tells the user something no marketing copy can: that this system checks
 * its own work.
 */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

type Mode = "file" | "url";

interface StageRow {
  stage: string;
  label: string;
  state: "done" | "active" | "pending";
}

interface Status {
  sourceId: string;
  stage: string;
  label: string;
  detail: string | null;
  error: string | null;
  done: boolean;
  failed: boolean;
  progress: number;
  stages: StageRow[];
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("bioagents_auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface UploadPaperDialogProps {
  open: boolean;
  onClose: () => void;
  /** Fired once the paper is fully ingested, so the library can refresh. */
  onIngested?: (sourceId: string) => void;
}

export function UploadPaperDialog({
  open,
  onClose,
  onIngested,
}: UploadPaperDialogProps) {
  const [mode, setMode] = useState<Mode>("file");
  const [url, setUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<number | null>(null);

  const reset = useCallback(() => {
    setBusy(false);
    setError(null);
    setStatus(null);
    setUrl("");
    setDragging(false);
  }, []);

  // Stop polling when the dialog closes — a modal nobody is looking at has no
  // business hammering the server.
  useEffect(() => {
    if (open) return;
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
  }, [open]);

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const watch = useCallback(
    (sourceId: string) => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const res = await fetch(
            `/api/research-brain/sources/${sourceId}/ingest-status`,
            { headers: authHeaders() },
          );
          if (!res.ok) return;
          const next: Status = await res.json();
          setStatus(next);
          if (next.done || next.failed) {
            if (pollRef.current) window.clearInterval(pollRef.current);
            pollRef.current = null;
            setBusy(false);
            if (next.done) onIngested?.(sourceId);
          }
        } catch {
          // A dropped poll is not a failed ingestion. Keep watching.
        }
      }, 1500);
    },
    [onIngested],
  );

  const uploadFile = useCallback(
    async (file: File) => {
      setError(null);
      setBusy(true);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/research-brain/sources/upload", {
          method: "POST",
          headers: authHeaders(),
          body: form,
        });
        const json = await res.json();
        if (!res.ok || !json?.sourceId) {
          throw new Error(json?.message || json?.error || "Upload failed");
        }
        watch(json.sourceId);
      } catch (e: any) {
        setError(e?.message ?? "Upload failed");
        setBusy(false);
      }
    },
    [watch],
  );

  const uploadUrl = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/research-brain/sources/upload-url", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const json = await res.json();
      if (!res.ok || !json?.sourceId) {
        throw new Error(json?.message || json?.error || "Could not fetch that URL");
      }
      watch(json.sourceId);
    } catch (e: any) {
      setError(e?.message ?? "Could not fetch that URL");
      setBusy(false);
    }
  }, [url, watch]);

  if (!open) return null;

  const running = busy || (!!status && !status.done && !status.failed);

  return (
    <div
      className="upload-dialog__backdrop"
      onClick={(e) => {
        // Never close mid-ingest by a stray click. The work would continue
        // invisibly, which is the exact confusion this dialog exists to end.
        if (e.target === e.currentTarget && !running) onClose();
      }}
    >
      <div
        className="upload-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Add a paper"
      >
        <header className="upload-dialog__header">
          <h2 className="upload-dialog__title">Add a paper</h2>
          <button
            type="button"
            className="btn"
            data-variant="ghost"
            data-size="sm"
            onClick={() => {
              if (running) return;
              reset();
              onClose();
            }}
            disabled={running}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        {/* ---- Once it is running, the choice is behind us. Show the work. ---- */}
        {status ? (
          <section className="upload-dialog__body">
            <ol className="upload-stages">
              {status.stages.map((s) => (
                <li
                  key={s.stage}
                  className={`upload-stage upload-stage--${s.state}`}
                >
                  <span className="upload-stage__dot" aria-hidden="true">
                    {s.state === "done" ? "✓" : s.state === "active" ? "•" : ""}
                  </span>
                  <span className="upload-stage__label">{s.label}</span>
                </li>
              ))}
            </ol>

            {status.detail ? (
              <p className="upload-dialog__detail">{status.detail}</p>
            ) : null}

            {status.failed ? (
              <p className="upload-dialog__error">
                {status.error ?? "Ingestion failed."}
              </p>
            ) : null}

            {status.done ? (
              <>
                <p className="upload-dialog__done">
                  Ready. Its citations have been checked against the PDF.
                </p>
                <div className="upload-dialog__actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      reset();
                      onClose();
                    }}
                  >
                    Done
                  </button>
                </div>
              </>
            ) : null}
          </section>
        ) : (
          <section className="upload-dialog__body">
            <div className="upload-dialog__tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "file"}
                className="btn"
                data-variant={mode === "file" ? "default" : "ghost"}
                data-size="sm"
                onClick={() => setMode("file")}
              >
                Upload a file
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "url"}
                className="btn"
                data-variant={mode === "url" ? "default" : "ghost"}
                data-size="sm"
                onClick={() => setMode("url")}
              >
                From a URL
              </button>
            </div>

            {mode === "file" ? (
              <div
                className={`upload-drop ${dragging ? "upload-drop--over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const file = e.dataTransfer?.files?.[0];
                  if (file) uploadFile(file);
                }}
                onClick={() => inputRef.current?.click()}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  hidden
                  onChange={(e) => {
                    const file = (e.currentTarget as HTMLInputElement)
                      .files?.[0];
                    if (file) uploadFile(file);
                  }}
                />
                <p className="upload-drop__title">
                  Drop a PDF here, or click to choose one
                </p>
                <p className="upload-drop__hint">
                  We will read it, index it, and check every citation it
                  produces against the PDF itself.
                </p>
              </div>
            ) : (
              <div className="upload-url">
                <label className="upload-url__label" htmlFor="paper-url">
                  Link to a PDF
                </label>
                <div className="upload-url__row">
                  <input
                    id="paper-url"
                    className="input"
                    type="url"
                    placeholder="https://www.mdpi.com/…/pdf"
                    value={url}
                    onInput={(e) => setUrl(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") uploadUrl();
                    }}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={uploadUrl}
                    disabled={!url.trim() || busy}
                  >
                    Fetch
                  </button>
                </div>
                <p className="upload-drop__hint">
                  The link must point at the PDF itself, not a landing page.
                </p>
              </div>
            )}

            {error ? <p className="upload-dialog__error">{error}</p> : null}
          </section>
        )}
      </div>
    </div>
  );
}
