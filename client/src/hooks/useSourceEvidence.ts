/**
 * Fetch the full evidence (tables + figures + chunks) for a source.
 *
 * Used by the dedicated viewer route to render the evidence sidebar
 * alongside the PDF. The lightbox does not need this endpoint — it
 * uses `useProvenance` for the single-fact chain.
 */
import { useCallback, useEffect, useState } from "preact/hooks";

import { BBox } from "../lib/bbox";

export interface SourceEvidenceTable {
  id: string;
  page: number;
  tableIndex: number;
  headers: string[];
  rows: string[][];
  markdown: string;
  bbox: BBox;
  extractionProvider: "local" | "mistral";
  extractionConfidence: number;
  /**
   * PR #2 of bioprospecting-multipage-table-merge: FK to the
   * previous fragment in a multi-page chain. `null` = chain head.
   * The viewer walks this field to render the "Part X of N"
   * badge + pager.
   */
  continuesFromId?: string | null;
}

export interface SourceEvidenceFigure {
  id: string;
  page: number;
  figureIndex: number;
  bbox: BBox;
  caption: string | null;
}

export interface SourceEvidenceChunk {
  id: string;
  page: number;
  chunkIndex: number;
  content: string;
  bbox: BBox | null;
}

export interface SourceEvidenceResponse {
  sourceId: string;
  tables: SourceEvidenceTable[];
  figures: SourceEvidenceFigure[];
  chunks: SourceEvidenceChunk[];
}

function getAuthToken(): string | null {
  return localStorage.getItem("bioagents_auth_token");
}

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

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  headers["X-User-Id"] = getStableUserId();
  return headers;
}

export function useSourceEvidence(sourceId: string | null) {
  const [data, setData] = useState<SourceEvidenceResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const refetch = useCallback(async () => {
    if (!sourceId) {
      setData(null);
      return;
    }
    setIsLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/research-brain/sources/${sourceId}/evidence`,
        {
          headers: authHeaders(),
          credentials: "include",
        },
      );
      const json = (await res.json().catch(() => ({}))) as Partial<
        SourceEvidenceResponse
      > & { error?: string; message?: string };
      if (!res.ok) {
        throw new Error(
          json?.message || json?.error || "Failed to load source evidence",
        );
      }
      setData(json as SourceEvidenceResponse);
    } catch (err: any) {
      setError(err?.message || "Failed to load source evidence");
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [sourceId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, isLoading, error, refetch };
}
