import { useCallback, useEffect, useState } from "preact/hooks";

export interface IngestionRun {
  runId: string;
  docsPath: string;
  status: "running" | "completed" | "completed_with_errors" | "failed" | "cancelled";
  totalFiles: number;
  processedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  llmCost: number;
  startedAt: string;
  finishedAt?: string;
  cancelledAt?: string;
}

export interface IngestionFileStatus {
  filePath: string;
  status: "processed" | "skipped" | "failed";
  chunksInserted?: number;
  sourceId?: string;
  error?: string;
  reason?: string;
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = localStorage.getItem("bioagents_auth_token");
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function useIngestionRuns(statusFilter?: string) {
  const [runs, setRuns] = useState<IngestionRun[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchRuns = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      params.set("limit", "20");

      const res = await fetch(`/api/research-brain/ingestion/runs?${params}`, {
        headers: getAuthHeaders(),
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || "Failed to load runs");
      setRuns(Array.isArray(data.runs) ? data.runs : []);
    } catch (err: any) {
      setError(err?.message || "Failed to load runs");
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  return { runs, isLoading, error, refetch: fetchRuns };
}

export function useIngestionRunDetails(runId: string | null) {
  const [run, setRun] = useState<IngestionRun | null>(null);
  const [files, setFiles] = useState<IngestionFileStatus[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchDetails = useCallback(async () => {
    if (!runId) { setRun(null); setFiles([]); return; }
    setIsLoading(true);
    setError("");
    try {
      const [runRes, filesRes] = await Promise.all([
        fetch(`/api/research-brain/ingestion/runs/${runId}`, {
          headers: getAuthHeaders(),
          credentials: "include",
        }),
        fetch(`/api/research-brain/ingestion/runs/${runId}/files`, {
          headers: getAuthHeaders(),
          credentials: "include",
        }),
      ]);
      const [runData, filesData] = await Promise.all([
        runRes.json().catch(() => ({})),
        filesRes.json().catch(() => ({})),
      ]);
      if (!runRes.ok) throw new Error(runData?.message || runData?.error || "Failed to load run");
      setRun(runData.run || null);
      setFiles(Array.isArray(filesData.files) ? filesData.files : []);
    } catch (err: any) {
      setError(err?.message || "Failed to load run details");
    } finally {
      setIsLoading(false);
    }
  }, [runId]);

  useEffect(() => { fetchDetails(); }, [fetchDetails]);

  return { run, files, isLoading, error, refetch: fetchDetails };
}

export async function cancelIngestionRun(runId: string): Promise<void> {
  const res = await fetch(`/api/research-brain/ingestion/runs/${runId}/cancel`, {
    method: "POST",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "Failed to cancel run");
}

export async function retryFailedFiles(runId: string): Promise<void> {
  const res = await fetch(`/api/research-brain/ingestion/runs/${runId}/retry-failed`, {
    method: "POST",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "Failed to retry failed files");
}
