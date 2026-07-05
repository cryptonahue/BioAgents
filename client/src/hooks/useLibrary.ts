import { useCallback, useEffect, useState } from "preact/hooks";

/**
 * Library API hook: list papers, fetch paper metadata, and ask grounded
 * questions about a single paper.
 */

export interface LibraryPaper {
  docId: string;
  title: string;
  type?: string;
  size?: number;
  chunkCount?: number;
  lastModified?: string;
}

export interface PaperMeta {
  docId: string;
  title: string;
  type?: string;
  size?: number;
  chunkCount?: number;
  charCount?: number;
  estTokens?: number;
  doi?: string | null;
  doiUrl?: string | null;
  researchSourceId?: string | null;
  abstract?: string;
  fileUrl: string;
}

export interface AskSource {
  index: number;
  chunkIndex: number;
  snippet: string;
}

export interface AskResult {
  docId: string;
  title: string;
  mode: "full" | "rag";
  tooLarge: boolean;
  answer: string;
  sources: AskSource[];
}

export interface AskHistoryItem {
  role: "user" | "assistant";
  content: string;
}

function getAuthToken(): string | null {
  return localStorage.getItem("bioagents_auth_token");
}

/**
 * Stable per-browser user id, matching the general chat's fallback
 * (localStorage "dev_user_id"). Sent as X-User-Id so per-paper chat history
 * persists across reloads when not authenticated via JWT. When a JWT is
 * present the server uses the JWT identity and ignores this header.
 */
function getStableUserId(): string {
  let id = localStorage.getItem("dev_user_id");
  if (!id) {
    id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("dev_user_id", id);
  }
  return id;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  headers["X-User-Id"] = getStableUserId();
  return headers;
}

export function useLibraryList() {
  const [papers, setPapers] = useState<LibraryPaper[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>("");

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const res = await fetch("/api/library", {
        headers: authHeaders(),
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed to load library (${res.status})`);
      const data = await res.json();
      setPapers(Array.isArray(data.papers) ? data.papers : []);
    } catch (err: any) {
      setError(err?.message || "Failed to load library");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { papers, isLoading, error, refetch };
}

export function usePaperMeta(docId: string | undefined) {
  const [meta, setMeta] = useState<PaperMeta | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!docId) return;
    let cancelled = false;
    setIsLoading(true);
    setError("");
    (async () => {
      try {
        const res = await fetch(`/api/library/${docId}`, {
          headers: authHeaders(),
          credentials: "include",
        });
        if (!res.ok) throw new Error(`Failed to load paper (${res.status})`);
        const data = await res.json();
        if (!cancelled) setMeta(data);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || "Failed to load paper");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  return { meta, isLoading, error };
}

export async function getPaperHistory(
  docId: string,
): Promise<AskHistoryItem[]> {
  const res = await fetch(`/api/library/${docId}/history`, {
    headers: authHeaders(),
    credentials: "include",
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.turns) ? data.turns : [];
}

export async function askPaper(
  docId: string,
  question: string,
  options: { fullContext?: boolean; history?: AskHistoryItem[] } = {},
): Promise<AskResult> {
  const res = await fetch(`/api/library/${docId}/ask`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    credentials: "include",
    body: JSON.stringify({
      question,
      fullContext: options.fullContext === true,
      history: options.history || [],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Request failed (${res.status})`);
  }
  return data as AskResult;
}
