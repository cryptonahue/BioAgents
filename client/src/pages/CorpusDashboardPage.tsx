import { route } from "preact-router";
import { useState, useCallback } from "preact/hooks";
import {
  useIngestionRuns,
  useIngestionRunDetails,
  cancelIngestionRun,
  retryFailedFiles,
  type IngestionRun,
  type IngestionFileStatus,
} from "../hooks/useIngestionRuns";
import { useIngestionWebSocket, type IngestionNotification } from "../hooks/useIngestionWebSocket";

function formatElapsed(startedAt: string, finishedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const ms = Math.max(0, end - start);
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function ProgressBar({ processed, total }: { processed: number; total: number }) {
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  return (
    <div class="corpus-progress-bar">
      <div class="corpus-progress-fill" style={{ width: `${pct}%` }} />
      <span class="corpus-progress-label">{processed}/{total} ({pct}%)</span>
    </div>
  );
}

function MetricsBar({ run }: { run: IngestionRun }) {
  const elapsed = formatElapsed(run.startedAt, run.finishedAt || undefined);
  const speed = run.startedAt
    ? ((run.processedFiles + run.skippedFiles) / Math.max(1, Math.floor((Date.now() - new Date(run.startedAt).getTime()) / 60000))).toFixed(1)
    : "0";
  const failureRate = run.totalFiles > 0 ? Math.round((run.failedFiles / run.totalFiles) * 100) : 0;

  return (
    <div class="corpus-metrics-bar">
      <div class="corpus-metric">
        <span class="corpus-metric-value">{speed}</span>
        <span class="corpus-metric-label">files/min</span>
      </div>
      <div class="corpus-metric">
        <span class="corpus-metric-value">{failureRate}%</span>
        <span class="corpus-metric-label">failure rate</span>
      </div>
      <div class="corpus-metric">
        <span class="corpus-metric-value">${run.llmCost?.toFixed(4) ?? "0.0000"}</span>
        <span class="corpus-metric-label">LLM cost</span>
      </div>
      <div class="corpus-metric">
        <span class="corpus-metric-value">{elapsed}</span>
        <span class="corpus-metric-label">elapsed</span>
      </div>
    </div>
  );
}

function FileList({ files }: { files: IngestionFileStatus[] }) {
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const filtered = files.filter((f) => {
    if (statusFilter && f.status !== statusFilter) return false;
    if (filter && !f.filePath.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  return (
    <div class="corpus-file-list">
      <div class="corpus-file-list-toolbar">
        <input
          class="corpus-file-search"
          placeholder="Search file..."
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter((e.target as HTMLSelectElement).value)}>
          <option value="">All</option>
          <option value="processed">Processed</option>
          <option value="skipped">Skipped</option>
          <option value="failed">Failed</option>
        </select>
      </div>
      <table class="corpus-file-table">
        <thead>
          <tr>
            <th>File</th>
            <th>Status</th>
            <th>Chunks</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((f) => (
            <tr key={f.filePath}>
              <td class="corpus-file-path">{f.filePath.split("/").pop()}</td>
              <td>
                <span class={`corpus-status-badge status-${f.status}`}>
                  {f.status === "processed" ? "✓" : f.status === "skipped" ? "⊘" : "✗"}
                </span>
              </td>
              <td>{f.chunksInserted ?? "-"}</td>
              <td class="corpus-file-error">{f.error || f.reason || ""}</td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr><td colspan={4} class="corpus-empty">No files</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function CorpusDashboardPage() {
  const [statusFilter, setStatusFilter] = useState("");
  const { runs, isLoading, error, refetch } = useIngestionRuns(statusFilter);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const { run, files, isLoading: detailsLoading, refetch: refetchDetails } = useIngestionRunDetails(selectedRunId);
  const [actionError, setActionError] = useState("");
  const [isCancelling, setIsCancelling] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);

  const selectedRun = run || runs.find((r) => r.runId === selectedRunId) || null;

  const handleNotification = useCallback((notif: IngestionNotification) => {
    if (notif.runId === selectedRunId) {
      refetchDetails();
    }
    refetch();
  }, [selectedRunId, refetch, refetchDetails]);

  useIngestionWebSocket(selectedRunId, handleNotification);

  const handleCancel = async () => {
    if (!selectedRunId) return;
    setIsCancelling(true);
    setActionError("");
    try {
      await cancelIngestionRun(selectedRunId);
      refetchDetails();
      refetch();
    } catch (err: any) {
      setActionError(err?.message || "Could not cancel");
    } finally {
      setIsCancelling(false);
    }
  };

  const handleRetry = async () => {
    if (!selectedRunId) return;
    setIsRetrying(true);
    setActionError("");
    try {
      await retryFailedFiles(selectedRunId);
      refetchDetails();
      refetch();
    } catch (err: any) {
      setActionError(err?.message || "Could not retry");
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <div class="corpus-page">
      <header class="corpus-topbar">
        <div class="corpus-brand" onClick={() => route("/chat")}>
          <span>BioAgents · Corpus</span>
        </div>
        <div class="corpus-topbar-links">
          <button class="corpus-link-btn" onClick={() => route("/library")}>Library</button>
          <button class="corpus-link-btn" onClick={() => route("/chat")}>Chat</button>
          <button class="corpus-link-btn" onClick={() => route("/brain")}>Research Brain</button>
        </div>
      </header>

      <main class="corpus-main">
        <div class="corpus-header">
          <h1>Ingestion Dashboard</h1>
          <p>Document corpus monitoring — progress, errors, and costs in real time</p>
        </div>

        {actionError && <div class="corpus-error">{actionError}</div>}

        <div class="corpus-layout">
          <aside class="corpus-sidebar">
            <div class="corpus-sidebar-header">
              <h2>Runs</h2>
              <select value={statusFilter} onChange={(e) => setStatusFilter((e.target as HTMLSelectElement).value)}>
                <option value="">All</option>
                <option value="running">Running</option>
                <option value="completed">Completed</option>
                <option value="completed_with_errors">With errors</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>

            {isLoading && <div class="corpus-loading">Loading runs...</div>}
            {error && <div class="corpus-error">{error}</div>}

            <div class="corpus-run-list">
              {runs.map((r) => (
                <button
                  key={r.runId}
                  class={`corpus-run-item ${selectedRunId === r.runId ? "active" : ""}`}
                  onClick={() => setSelectedRunId(r.runId)}
                >
                  <div class="corpus-run-item-title">{r.docsPath.split("/").pop()}</div>
                  <div class="corpus-run-item-meta">
                    <span class={`corpus-run-status status-${r.status}`}>{r.status}</span>
                    <span>{r.processedFiles}/{r.totalFiles}</span>
                  </div>
                </button>
              ))}
              {runs.length === 0 && !isLoading && (
                <div class="corpus-empty">No runs. Start an ingestion from Research Brain.</div>
              )}
            </div>
          </aside>

          <section class="corpus-detail">
            {!selectedRun && (
              <div class="corpus-empty-state">
                Select a run to see details
              </div>
            )}

            {selectedRun && (
              <>
                <div class="corpus-detail-header">
                  <div>
                    <h2>{selectedRun.docsPath.split("/").pop()}</h2>
                    <p>
                      {selectedRun.status} ·{" "}
                      {new Date(selectedRun.startedAt).toLocaleString()}
                      {selectedRun.finishedAt && ` → ${new Date(selectedRun.finishedAt).toLocaleString()}`}
                    </p>
                  </div>
                  <div class="corpus-detail-actions">
                    <button
                      class="corpus-btn corpus-btn-danger"
                      disabled={isCancelling || selectedRun.status !== "running"}
                      onClick={handleCancel}
                    >
                      {isCancelling ? "Cancelling..." : "Cancel run"}
                    </button>
                    <button
                      class="corpus-btn corpus-btn-secondary"
                      disabled={isRetrying || selectedRun.failedFiles === 0}
                      onClick={handleRetry}
                    >
                      {isRetrying ? "Retrying..." : `Retry ${selectedRun.failedFiles} failed`}
                    </button>
                  </div>
                </div>

                <ProgressBar processed={selectedRun.processedFiles} total={selectedRun.totalFiles} />
                <MetricsBar run={selectedRun} />

                {detailsLoading && <div class="corpus-loading">Loading files...</div>}
                {!detailsLoading && <FileList files={files} />}
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
