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
  /** Number of Research Brain claims extracted from this paper. Omitted when
   * the count could not be computed (so the UI hides the pill instead of
   * showing a misleading 0). */
  evidenceCount?: number;
  lastModified?: string;
  /** Resolved research_sources.id (now returned by the list endpoint so the
   * card can link/expand without a second resolve). */
  researchSourceId?: string;
  /** DOI + resolvable URL, from research_sources. Omitted when unknown. */
  doi?: string;
  doiUrl?: string;
  /** Publication year (structured metadata or parsed from the filename). */
  year?: number;
  /** Publisher/journal hint (metadata.journal/publisher or filename). */
  publisher?: string;
  /** A real title from research_sources.metadata.title, when present. */
  metaTitle?: string;
  /** research_sources.trust_tier, when present. */
  trustTier?: string;
  /** research_sources.bioprospecting_fact_count, when present. */
  bioprospectingFactCount?: number;
  /** Up to 4 distinct organism names studied (species preferred, else genus). */
  taxa?: string[];
  /** Distinct geography strings from the bioprospecting facts. */
  geography?: string[];
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

/* ---------------------------------------------------------------------------
 * The list is SERVER-side: searched, filtered, sorted and paged in Postgres.
 * The client holds the QUERY, never the corpus. See
 * `documentation/docs/CORALGPT.md` for the endpoint contract.
 * ------------------------------------------------------------------------- */

export type LibrarySort = "year" | "evidence" | "title";
export type LibraryDirection = "asc" | "desc";

export interface LibraryQuery {
  q: string;
  taxon: string;
  geography: string;
  year: string;
  trustTier: string;
  sort: LibrarySort;
  dir: LibraryDirection;
  page: number;
  pageSize: number;
}

export const LIBRARY_DEFAULT_QUERY: LibraryQuery = {
  q: "",
  taxon: "",
  geography: "",
  year: "",
  trustTier: "",
  // Recency is the triage default: the newest work is the likeliest to matter.
  sort: "year",
  dir: "desc",
  page: 1,
  pageSize: 25,
};

/** The four filter axes (search and sort are not "filters" — they do not clear). */
export function activeFilterCount(query: LibraryQuery): number {
  return [query.taxon, query.geography, query.year, query.trustTier].filter(
    Boolean,
  ).length;
}

/**
 * Serialize a query into the endpoint's search params. Empty values are
 * OMITTED, not sent blank, so the request URL stays readable and every default
 * stays the server's to decide.
 */
export function buildLibraryQueryString(query: LibraryQuery): string {
  const params = new URLSearchParams();
  if (query.q.trim()) params.set("q", query.q.trim());
  if (query.taxon) params.set("taxon", query.taxon);
  if (query.geography) params.set("geography", query.geography);
  if (query.year) params.set("year", query.year);
  if (query.trustTier) params.set("trustTier", query.trustTier);
  params.set("sort", query.sort);
  params.set("dir", query.dir);
  params.set("page", String(query.page));
  params.set("pageSize", String(query.pageSize));
  return params.toString();
}

export interface LibraryFacetValue {
  value: string | number;
  count: number;
}

export interface LibraryFacets {
  taxa: LibraryFacetValue[];
  geography: LibraryFacetValue[];
  years: LibraryFacetValue[];
  trustTiers: LibraryFacetValue[];
}

const EMPTY_FACETS: LibraryFacets = {
  taxa: [],
  geography: [],
  years: [],
  trustTiers: [],
};

/**
 * One page of papers. `total` is the size of the WHOLE result set (before the
 * page window), which is what the pagination control and the result count are
 * built from — `papers.length` is only ever the size of this page.
 */
export function useLibraryList(query: LibraryQuery) {
  const [papers, setPapers] = useState<LibraryPaper[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>("");

  const search = buildLibraryQueryString(query);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/library?${search}`, {
        headers: authHeaders(),
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed to load library (${res.status})`);
      const data = await res.json();
      setPapers(Array.isArray(data.papers) ? data.papers : []);
      setTotal(Number(data.total) || 0);
      setTotalPages(Math.max(1, Number(data.totalPages) || 1));
    } catch (err: any) {
      setError(err?.message || "Failed to load library");
      setPapers([]);
      setTotal(0);
      setTotalPages(1);
    } finally {
      setIsLoading(false);
    }
  }, [search]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { papers, total, totalPages, isLoading, error, refetch };
}

/**
 * The filter vocabulary. Fetched ONCE per page load, not per keystroke: the
 * facets are global (they describe the corpus, not the current result set) and
 * only change when a paper is added or removed. `refetch` exists so an upload
 * or a delete can refresh them.
 */
export function useLibraryFacets() {
  const [facets, setFacets] = useState<LibraryFacets>(EMPTY_FACETS);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/library/facets", {
        headers: authHeaders(),
        credentials: "include",
      });
      if (!res.ok) return;
      const data = await res.json();
      setFacets({
        taxa: Array.isArray(data.taxa) ? data.taxa : [],
        geography: Array.isArray(data.geography) ? data.geography : [],
        years: Array.isArray(data.years) ? data.years : [],
        trustTiers: Array.isArray(data.trustTiers) ? data.trustTiers : [],
      });
    } catch {
      // Non-fatal: the filters simply stay empty. The list still works.
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { facets, refetch };
}

/**
 * On-demand, cached fetch of a paper's abstract from the detail endpoint.
 * Used by the Library card to reveal the full abstract on hover without
 * bloating the (O(1)-query) list payload with text per paper. Cached per
 * docId for the page lifetime so repeated hovers do not re-fetch.
 */
const abstractCache = new Map<string, string>();

export async function fetchPaperAbstract(docId: string): Promise<string> {
  const cached = abstractCache.get(docId);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(`/api/library/${docId}`, {
      headers: authHeaders(),
      credentials: "include",
    });
    if (!res.ok) return "";
    const data = await res.json().catch(() => ({}));
    const abstract = typeof data?.abstract === "string" ? data.abstract : "";
    abstractCache.set(docId, abstract);
    return abstract;
  } catch {
    return "";
  }
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

/**
 * Delete a paper from the library. DESTRUCTIVE: removes the knowledge/vector
 * chunks, the research source (cascades to evidence/claims/facts), and the
 * original file on disk. Auth is required server-side; we send the same auth
 * headers/credentials as the other library calls. Throws on non-ok so the
 * caller can surface an error and avoid a misleading list refresh.
 */
export async function deleteLibraryPaper(docId: string): Promise<void> {
  const res = await fetch(`/api/library/${docId}`, {
    method: "DELETE",
    headers: authHeaders(),
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      data?.message || data?.error || `Delete failed (${res.status})`,
    );
  }
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
