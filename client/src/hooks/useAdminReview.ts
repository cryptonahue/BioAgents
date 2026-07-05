import { useCallback, useEffect, useState } from "preact/hooks";

/**
 * useAdminReview — admin-only hooks for the Bioprospecting Review UI.
 *
 * Six hooks that wrap the four new admin-only routes
 * (`/api/research-brain/contradictions`,
 * `/api/research-brain/contradictions/stats`,
 * `/api/research-brain/dedup/events`,
 * `/api/research-brain/dedup/:factId/unmerge`) plus the existing
 * per-row `POST /api/research-brain/contradictions/:id/resolve` route
 * for the bulk resolve action.
 *
 * All hooks are thin wrappers over `fetch`; they reuse the same auth
 * pattern as `useIngestionRuns` — the request includes the JWT
 * `Authorization: Bearer ...` header and `credentials: "include"` so
 * the server can also pick up the cookie.
 */

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = localStorage.getItem("bioagents_auth_token");
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function jsonOrError(res: Response, fallback: string): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || data?.error || fallback);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Types — mirror the backend response shapes in
// `src/services/researchBrain/types.ts` and `reviewService.ts`.
// ---------------------------------------------------------------------------

export type AdminContradictionStatus =
  | "unresolved"
  | "resolved"
  | "dismissed";

export interface AdminContradiction {
  id: string;
  source_id: string;
  source_fact_id: string;
  conflicting_fact_id: string;
  contradiction_type: string;
  evidence_pack: Record<string, unknown>;
  rule_version: string | null;
  llm_version: string | null;
  resolution_status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminContradictionsResponse {
  contradictions: AdminContradiction[];
  total: number;
  limit: number;
  offset: number;
}

export interface StatsWindow {
  found: number;
  resolved: number;
  dismissed: number;
  pending: number;
  merges: number;
  unmerges: number;
}

export interface AdminStats {
  today: StatsWindow;
  last7d: StatsWindow;
}

export type DedupEventWindow = "24h" | "7d" | "30d" | "all";

export type ReasonCategory =
  | "false_positive"
  | "different_compound"
  | "measurement_error"
  | "other";

export interface RecentDedupEvent {
  eventId: string;
  factId: string;
  canonicalId: string;
  mergedFactId: string;
  matchRule: "identity_key" | "embedding";
  mergedAt: string;
  unmergedAt: string | null;
  unmergedBy: string | null;
  isActive: boolean;
  reasonCode: ReasonCategory | null;
  reasonDetail: string | null;
}

export interface AdminDedupEventsResponse {
  events: RecentDedupEvent[];
}

// ---------------------------------------------------------------------------
// `useAdminContradictions` — paginated, filtered, admin-only feed.
// ---------------------------------------------------------------------------

export interface UseAdminContradictionsParams {
  status?: AdminContradictionStatus | "all";
  sourceId?: string | null;
  /** 0-indexed page number (page size fixed at 50 by the route). */
  page?: number;
}

export function useAdminContradictions(
  params: UseAdminContradictionsParams = {},
) {
  const [data, setData] = useState<AdminContradictionsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const query = new URLSearchParams();
      if (params.status && params.status !== "all") {
        query.set("status", params.status);
      }
      if (params.sourceId) query.set("sourceId", params.sourceId);
      const page = Math.max(0, params.page ?? 0);
      query.set("limit", "50");
      query.set("offset", String(page * 50));
      const res = await fetch(
        `/api/research-brain/contradictions?${query.toString()}`,
        { headers: getAuthHeaders(), credentials: "include" },
      );
      const json = await jsonOrError(res, "Failed to load contradictions");
      setData({
        contradictions: Array.isArray(json.contradictions)
          ? json.contradictions
          : [],
        total: Number(json.total) || 0,
        limit: Number(json.limit) || 50,
        offset: Number(json.offset) || 0,
      });
    } catch (err: any) {
      setError(err?.message || "Failed to load contradictions");
    } finally {
      setIsLoading(false);
    }
  }, [params.status, params.sourceId, params.page]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, isLoading, error, refetch: fetchData };
}

// ---------------------------------------------------------------------------
// `useResolveContradiction` — single mutation (re-uses existing route).
// ---------------------------------------------------------------------------

export function useResolveContradiction() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const mutate = useCallback(
    async (
      contradictionId: string,
      resolutionStatus: "resolved" | "dismissed",
    ) => {
      setIsLoading(true);
      setError("");
      try {
        const res = await fetch(
          `/api/research-brain/contradictions/${contradictionId}/resolve`,
          {
            method: "POST",
            headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ resolutionStatus }),
          },
        );
        await jsonOrError(res, "Failed to resolve contradiction");
      } catch (err: any) {
        setError(err?.message || "Failed to resolve contradiction");
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  return { mutate, isLoading, error };
}

// ---------------------------------------------------------------------------
// `useBulkResolveContradictions` — N×mutation with optimistic UI + rollback.
//
// The bulk action is implemented client-side as N parallel calls to the
// per-row `POST /contradictions/:id/resolve` route (the design
// decision documented in design.md §"Bulk resolve is N×single-call").
// A 50-cap mirrors the page size so a single operator click never
// fans out beyond the visible row set.
//
// On partial failure the failed rows are rolled back (re-added to the
// visible set) and the per-row error is surfaced through the returned
// `results` array. The hook does NOT block the table on bulk-action
// errors — the UI is expected to refetch via `useAdminContradictions`
// when the operator dismisses the toast.
// ---------------------------------------------------------------------------

export interface BulkResolveResult {
  id: string;
  ok: boolean;
  error?: string;
}

const BULK_RESOLVE_CAP = 50;

export function useBulkResolveContradictions() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const mutate = useCallback(
    async (
      ids: string[],
      resolutionStatus: "resolved" | "dismissed",
    ): Promise<BulkResolveResult[]> => {
      setIsLoading(true);
      setError("");
      const sliced = ids.slice(0, BULK_RESOLVE_CAP);
      try {
        const settled = await Promise.allSettled(
          sliced.map(async (id) => {
            const res = await fetch(
              `/api/research-brain/contradictions/${id}/resolve`,
              {
                method: "POST",
                headers: {
                  ...getAuthHeaders(),
                  "Content-Type": "application/json",
                },
                credentials: "include",
                body: JSON.stringify({ resolutionStatus }),
              },
            );
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              throw new Error(
                data?.message || data?.error || "Failed to resolve",
              );
            }
            return id;
          }),
        );
        const results: BulkResolveResult[] = settled.map((s, i) => {
          const id = sliced[i];
          if (s.status === "fulfilled") {
            return { id, ok: true };
          }
          return {
            id,
            ok: false,
            error: (s.reason && s.reason.message) || "Failed to resolve",
          };
        });
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) {
          setError(
            `${failed.length} of ${sliced.length} failed: ${failed[0].error}`,
          );
        }
        return results;
      } catch (err: any) {
        setError(err?.message || "Bulk resolve failed");
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  return { mutate, isLoading, error };
}

// ---------------------------------------------------------------------------
// `useDedupEvents` — paginated, time-windowed dedup feed.
// ---------------------------------------------------------------------------

export interface UseDedupEventsParams {
  since?: DedupEventWindow;
  page?: number;
}

export function useDedupEvents(params: UseDedupEventsParams = {}) {
  const [data, setData] = useState<AdminDedupEventsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const query = new URLSearchParams();
      query.set("since", params.since ?? "7d");
      const page = Math.max(0, params.page ?? 0);
      query.set("limit", "50");
      query.set("offset", String(page * 50));
      const res = await fetch(
        `/api/research-brain/dedup/events?${query.toString()}`,
        { headers: getAuthHeaders(), credentials: "include" },
      );
      const json = await jsonOrError(res, "Failed to load dedup events");
      setData({
        events: Array.isArray(json.events) ? json.events : [],
      });
    } catch (err: any) {
      setError(err?.message || "Failed to load dedup events");
    } finally {
      setIsLoading(false);
    }
  }, [params.since, params.page]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, isLoading, error, refetch: fetchData };
}

// ---------------------------------------------------------------------------
// `useUnmergeFact` — mutation for the unmerge dialog.
// ---------------------------------------------------------------------------

export interface UnmergePayload {
  factId: string;
  reasonCode: ReasonCategory;
  reasonDetail?: string | null;
}

export function useUnmergeFact() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const mutate = useCallback(async (payload: UnmergePayload) => {
    setIsLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/research-brain/dedup/${payload.factId}/unmerge`,
        {
          method: "POST",
          headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            reasonCode: payload.reasonCode,
            reasonDetail: payload.reasonDetail ?? null,
          }),
        },
      );
      return await jsonOrError(res, "Failed to unmerge fact");
    } catch (err: any) {
      setError(err?.message || "Failed to unmerge fact");
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { mutate, isLoading, error };
}

// ---------------------------------------------------------------------------
// `useAdminStats` — single stats card fetch.
// ---------------------------------------------------------------------------

export function useAdminStats() {
  const [data, setData] = useState<AdminStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const res = await fetch(
        "/api/research-brain/contradictions/stats",
        { headers: getAuthHeaders(), credentials: "include" },
      );
      const json = await jsonOrError(res, "Failed to load stats");
      setData(json as AdminStats);
    } catch (err: any) {
      setError(err?.message || "Failed to load stats");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, isLoading, error, refetch: fetchData };
}
