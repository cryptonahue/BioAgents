/**
 * Fetch a single fact's full provenance chain (table|figure|chunk|text-only).
 *
 * Used by the EvidenceLightbox to render the highlight overlay and by
 * the dedicated viewer route to deep-link from a fact citation. The
 * backend resolves precedence per design §6.3:
 *   table → figure → chunk → text-only
 */
import { useCallback, useEffect, useState } from "preact/hooks";

import { BBox, PDFJS_RENDER_SCALE } from "../lib/bbox";

export type ProvenanceType = "table" | "figure" | "chunk" | "text-only";

export interface ProvenanceTable {
  id: string;
  page: number;
  tableIndex: number;
  headers: string[];
  rows: string[][];
  markdown: string;
  bbox: BBox;
  extractionProvider: "local" | "mistral";
  extractionConfidence: number;
}

export interface ProvenanceFigure {
  id: string;
  page: number;
  figureIndex: number;
  bbox: BBox;
  caption: string | null;
  /**
   * PR #2 of figure-image-extraction: the four image fields are
   * populated by the `/evidence` endpoint when the figure has an
   * extracted image in S3 (storage_path IS NOT NULL). When the
   * figure is bbox-only, all four are undefined and the lightbox
   * degrades to the pre-change purple-bbox behavior. The
   * `/facts/:id/provenance` endpoint does not currently surface
   * these (the design's open question #2 defers that to a later
   * change); the lightbox therefore tolerates their absence.
   */
  imageUrl?: string;
  width?: number;
  height?: number;
  mimeType?: string;
}

export interface ProvenanceChunk {
  id: string;
  page: number;
  chunkIndex: number;
  content: string;
}

export interface ProvenanceCompound {
  canonicalName: string | null;
  inchiKey: string | null;
  pubchemCid: number | null;
  molecularFormula: string | null;
}

export interface ProvenanceCompoundAuthority {
  status: "pending" | "verified" | "failed" | "skipped" | null;
  canonicalId: string | null;
  at: string | null;
  error: string | null;
  attempts: number | null;
}

export interface ProvenanceResponse {
  factId: string;
  sourceId: string | null;
  sourceTitle: string;
  doi: string | null;
  // PR #3 of bioprospecting-compound-authority — the resolved
  // canonical compound (if any) and the authority state on the
  // fact. The lightbox header shows InChIKey + PubChem CID from
  // `compound.inchiKey` + `compound.pubchemCid` when the fact has
  // a resolved canonical, and the badge variant from
  // `compoundAuthority.status`.
  compound: ProvenanceCompound | null;
  compoundAuthority: ProvenanceCompoundAuthority;
  provenance: {
    type: ProvenanceType;
    table: ProvenanceTable | null;
    figure: ProvenanceFigure | null;
    chunk: ProvenanceChunk | null;
    bbox: BBox | null;
  };
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

export function useProvenance(factId: string | null) {
  const [data, setData] = useState<ProvenanceResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const refetch = useCallback(async () => {
    if (!factId) {
      setData(null);
      return;
    }
    setIsLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/research-brain/facts/${factId}/provenance`,
        {
          headers: authHeaders(),
          credentials: "include",
        },
      );
      const json = (await res
        .json()
        .catch(() => ({}))) as Partial<ProvenanceResponse> & {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        throw new Error(
          json?.message || json?.error || "Failed to load provenance",
        );
      }
      setData(json as ProvenanceResponse);
    } catch (err: any) {
      setError(err?.message || "Failed to load provenance");
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [factId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, isLoading, error, refetch };
}

/**
 * Parse a URL hash into a structured `bbox|page|type` payload.
 *
 * The viewer reads this on mount and on `hashchange` so deep links
 * survive reload (spec: "Hash survives reload"). Unknown keys are
 * ignored; missing keys fall back to defaults.
 */
export interface HashState {
  bbox: BBox | null;
  page: number;
  type: ProvenanceType;
}

export function parseViewerHash(hash: string): HashState {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const bboxRaw = params.get("bbox");
  const pageRaw = params.get("page");
  const typeRaw = params.get("type");

  let bbox: BBox | null = null;
  if (bboxRaw) {
    const parts = bboxRaw.split(",").map((s) => Number(s));
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      bbox = {
        x: parts[0],
        y: parts[1],
        w: parts[2],
        h: parts[3],
        page: pageRaw && Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : 1,
        units: "pt",
      };
    }
  }

  const page =
    pageRaw && Number.isFinite(Number(pageRaw))
      ? Math.max(1, Number(pageRaw))
      : 1;

  const type: ProvenanceType =
    typeRaw === "table" ||
    typeRaw === "figure" ||
    typeRaw === "chunk" ||
    typeRaw === "text-only"
      ? typeRaw
      : "chunk";

  return { bbox, page, type };
}

/**
 * Build a deep-linkable hash for a fact's provenance. Used by the
 * lightbox's "Open in tab" button and by the dedicated viewer to
 * serialize its current state.
 */
export function buildViewerHash(state: HashState): string {
  const params = new URLSearchParams();
  if (state.bbox) {
    const { x, y, w, h } = state.bbox;
    params.set("bbox", `${x},${y},${w},${h}`);
  }
  params.set("page", String(state.page));
  params.set("type", state.type);
  return `#${params.toString()}`;
}

export { PDFJS_RENDER_SCALE };
