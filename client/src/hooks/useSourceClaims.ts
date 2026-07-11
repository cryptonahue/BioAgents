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

export interface SourceClaim {
  id: string;
  claim: string;
  claim_type?: string;
  status: SourceClaimStatus;
  confidence?: string;
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
