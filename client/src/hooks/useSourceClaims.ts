/**
 * Fetch the extracted Research Brain claims for a source.
 *
 * Powers the "Claims" section of the dedicated viewer sidebar so that
 * "View evidence" surfaces the textual claims counted on the library
 * card (research_claims) — not only the bbox-anchored tables/figures
 * loaded by `useSourceEvidence`.
 */
import { useCallback, useEffect, useState } from "preact/hooks";

export type SourceClaimStatus =
  | "supported"
  | "partial"
  | "contradicted"
  | "hypothesis"
  | "open_question";

/**
 * The claims endpoint embeds the linked evidence chunk
 * (`chunk:research_evidence_chunks(*)`), so a claim carries the
 * `content` + `page` needed to highlight it in the viewer. Chunks
 * currently have no stored bbox (the evidence/provenance endpoints
 * return `bbox: null` for chunks), so the viewer resolves the
 * highlight via a text-layer search on `content`.
 */
export interface SourceClaimChunk {
  id: string;
  page?: number | null;
  content?: string;
  chunk_index?: number | null;
}

export interface SourceClaim {
  id: string;
  claim: string;
  claim_type?: string;
  status: SourceClaimStatus;
  confidence?: string;
  chunk_id?: string | null;
  /**
   * Verbatim source sentence the claim was extracted from (added by the
   * research-brain extractor). Preferred over the whole chunk `content`
   * for a tighter text-layer highlight when present.
   */
  quote?: string | null;
  /**
   * Where the quote was located in the PDF at INGESTION, and whether it was
   * found WORD FOR WORD.
   *
   *   anchor_bbox + anchor_verbatim      -> the paper says exactly this
   *   anchor_bbox, not verbatim          -> right passage, reworded
   *   no anchor_bbox                     -> THE QUOTE IS NOT IN THE PAPER
   *
   * The last state is a fabricated citation. Nothing else in this system can
   * see it, so the sidebar says so and draws no box.
   */
  anchor_page?: number | null;
  anchor_bbox?: any | null;
  anchor_verbatim?: boolean | null;
  /** Embedded by getSourceClaims — used for the paper's real title. */
  source?: {
    title?: string | null;
    /** When the source was last anchored. NULL = not verified yet. */
    evidence_anchored_at?: string | null;
  } | null;
  chunk?: SourceClaimChunk | null;
}

interface SourceClaimsResponse {
  claims: SourceClaim[];
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = localStorage.getItem("bioagents_auth_token");
  if (token) headers.Authorization = `Bearer ${token}`;
  let uid = localStorage.getItem("dev_user_id");
  if (!uid) {
    uid =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("dev_user_id", uid);
  }
  headers["X-User-Id"] = uid;
  return headers;
}

export function useSourceClaims(sourceId: string | null) {
  const [claims, setClaims] = useState<SourceClaim[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const refetch = useCallback(async () => {
    if (!sourceId) {
      setClaims([]);
      return;
    }
    setIsLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/research-brain/sources/${sourceId}/claims`,
        { headers: authHeaders(), credentials: "include" },
      );
      const json = (await res.json().catch(() => ({}))) as Partial<
        SourceClaimsResponse
      > & { error?: string; message?: string };
      if (!res.ok) {
        throw new Error(
          json?.message || json?.error || "Failed to load source claims",
        );
      }
      setClaims(json.claims ?? []);
    } catch (err: any) {
      setError(err?.message || "Failed to load source claims");
      setClaims([]);
    } finally {
      setIsLoading(false);
    }
  }, [sourceId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { claims, isLoading, error, refetch };
}
