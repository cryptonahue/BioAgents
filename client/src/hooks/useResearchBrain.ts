import { useCallback, useEffect, useState } from "preact/hooks";

export interface ResearchSource {
  id: string;
  source_kind: string;
  trust_tier: "internal" | "external";
  title: string;
  doi?: string | null;
  file_path?: string | null;
  extraction_status: string;
  extraction_error?: string | null;
  created_at?: string;
}

export interface ResearchClaim {
  id: string;
  claim: string;
  claim_type: string;
  status: string;
  confidence: string;
  trust_tier: "internal" | "external";
  doi?: string | null;
  source?: ResearchSource;
  chunk?: {
    content: string;
    chunk_index?: number | null;
    section?: string | null;
    page?: number | null;
  };
}

export interface ResearchEvidenceChunk {
  id: string;
  source_id: string;
  document_id?: string | null;
  content: string;
  section?: string | null;
  page?: number | null;
  chunk_index?: number | null;
  metadata?: Record<string, unknown>;
}

export interface ResearchBrainQueryPlan {
  questionType: string;
  intentLabel: string;
  strategy: string;
  answerSections: string[];
  shouldUseExternalLiterature: boolean;
  cautions: string[];
}

export interface ResearchBrainBioprospectingFact {
  id: string;
  status: string;
  confidence: string;
  trustTier: "internal" | "external";
  reviewStatus:
    | "unreviewed"
    | "verified"
    | "needs_review"
    | "incorrect"
    | "quarantined";
  reviewNote?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  lastEntityCorrection?: ResearchBrainEntityCorrection | null;
  entityCorrectionHistory?: ResearchBrainEntityCorrection[];
  matchType: string;
  evidenceStrength: "direct" | "indirect" | "hypothesis" | "unknown";
  evidenceLabel: string;
  queryMatches: string[];
  sourceTitle?: string | null;
  doi?: string | null;
  doiUrl?: string | null;
  paperUrl?: string | null;
  evidenceUrl?: string | null;
  chunkIndex?: number | null;
  page?: number | null;
  species?: string | null;
  genus?: string | null;
  family?: string | null;
  organismGroup?: string | null;
  geography?: string | null;
  ecosystem?: string | null;
  organismPart?: string | null;
  compound?: string | null;
  compoundClass?: string | null;
  moleculeType?: string | null;
  bioactivity?: string | null;
  applicationArea?: string | null;
  assayModel?: string | null;
  resultSummary?: string | null;
  // PR #3 of bioprospecting-compound-authority — canonical
  // resolution state for the compound. The fields are populated
  // server-side by the worker / editor flow. The client uses them
  // to render the CompoundAuthorityBadge and to enrich the
  // provenance lightbox.
  compoundCanonicalId?: string | null;
  compoundAuthorityStatus?: "pending" | "verified" | "failed" | "skipped" | null;
  compoundAuthorityAt?: string | null;
  compoundAuthorityError?: string | null;
  compoundAuthorityAttempts?: number | null;
  // Convenience fields that the search response can hydrate via
  // a left-join on `research_compounds`. Optional — when the
  // canonical id is set, the server may return the display name +
  // InChIKey + PubChem CID in the row. The badge uses these to
  // avoid a second round-trip.
  compoundCanonicalName?: string | null;
  compoundInchiKey?: string | null;
  compoundPubchemCid?: number | null;
  measurementValue?: number | null;
  measurementUnit?: string | null;
  measurementDirection?: string | null;
  measurementMin?: number | null;
  measurementMax?: number | null;
  timepoint?: string | null;
  condition?: string | null;
  pValue?: number | null;
  sampleSize?: number | null;
  statisticalTest?: string | null;
  evidenceType?: string | null;
  relationType?: string;
  quote?: string | null;
  snippet?: string;
}

export interface ResearchBrainEntityCorrection {
  correctedAt?: string | null;
  correctedBy?: string | null;
  fields: Record<string, { before?: string | null; after?: string | null }>;
}

export interface ResearchBrainEvidenceSource {
  id: string;
  title: string;
  trustTier: "internal" | "external";
  kind: string;
  doi?: string | null;
  doiUrl?: string | null;
  paperUrl?: string | null;
}

export interface ResearchBrainEvidencePack {
  question: string;
  queryPlan: ResearchBrainQueryPlan;
  bioprospectingFacts: ResearchBrainBioprospectingFact[];
  supportedClaims: ResearchClaim[];
  partialClaims: ResearchClaim[];
  contradictions: ResearchClaim[];
  openQuestions: ResearchClaim[];
  sources: ResearchBrainEvidenceSource[];
}

export interface ResearchBrainSearchParams {
  query: string;
  limit?: number;
  measurementMin?: number;
  measurementMax?: number;
  measurementUnit?: string;
  measurementDirection?: "increase" | "decrease" | "no_change" | "mixed";
  condition?: string;
  reviewStatus?: ResearchBrainReviewStatus | "all";
  evidenceStrength?: "direct" | "indirect" | "hypothesis" | "unknown" | "all";
  sourceId?: string;
  sourceTrustTier?: "internal" | "external" | "all";
}

export type ResearchBrainReviewStatus =
  | "unreviewed"
  | "verified"
  | "needs_review"
  | "incorrect"
  | "quarantined";

export interface ResearchBrainFactEntityPatch {
  species?: string | null;
  genus?: string | null;
  family?: string | null;
  organismGroup?: string | null;
  geography?: string | null;
  ecosystem?: string | null;
  organismPart?: string | null;
  compound?: string | null;
  compoundClass?: string | null;
  moleculeType?: string | null;
  bioactivity?: string | null;
  applicationArea?: string | null;
  assayModel?: string | null;
  condition?: string | null;
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

function authHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  headers["X-User-Id"] = getStableUserId();
  return headers;
}

export function useResearchBrainSources() {
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const res = await fetch("/api/research-brain/sources", {
        headers: authHeaders(),
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(
          data?.message || data?.error || "Failed to load Research Brain",
        );
      setSources(Array.isArray(data.sources) ? data.sources : []);
    } catch (err: any) {
      setError(err?.message || "Failed to load Research Brain");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { sources, isLoading, error, refetch };
}

export function useResearchBrainClaims(sourceId?: string | null) {
  const [claims, setClaims] = useState<ResearchClaim[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const refetch = useCallback(async () => {
    if (!sourceId) return;
    setIsLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/research-brain/sources/${sourceId}/claims`,
        {
          headers: authHeaders(),
          credentials: "include",
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(
          data?.message || data?.error || "Failed to load claims",
        );
      setClaims(Array.isArray(data.claims) ? data.claims : []);
    } catch (err: any) {
      setError(err?.message || "Failed to load claims");
    } finally {
      setIsLoading(false);
    }
  }, [sourceId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { claims, isLoading, error, refetch };
}

export function useResearchBrainChunk(
  sourceId?: string | null,
  chunkIndex?: number | null,
) {
  const [chunk, setChunk] = useState<ResearchEvidenceChunk | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const refetch = useCallback(async () => {
    if (!sourceId || chunkIndex == null) {
      setChunk(null);
      return;
    }
    setIsLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/research-brain/sources/${sourceId}/chunks/${chunkIndex}`,
        {
          headers: authHeaders(),
          credentials: "include",
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(
          data?.message || data?.error || "Failed to load fragment",
        );
      setChunk(data.chunk || null);
    } catch (err: any) {
      setChunk(null);
      setError(err?.message || "Failed to load fragment");
    } finally {
      setIsLoading(false);
    }
  }, [sourceId, chunkIndex]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { chunk, isLoading, error, refetch };
}

export function useResearchBrainEvidenceSearch(initialQuery = "Acropora") {
  const [evidencePack, setEvidencePack] =
    useState<ResearchBrainEvidencePack | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const search = useCallback(async (params: ResearchBrainSearchParams) => {
    if (!params.query.trim()) return;
    setIsLoading(true);
    setError("");
    try {
      const res = await fetch("/api/research-brain/search", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        credentials: "include",
        body: JSON.stringify({
          query: params.query,
          limit: params.limit || 12,
          measurementMin: params.measurementMin,
          measurementMax: params.measurementMax,
          measurementUnit: params.measurementUnit,
          measurementDirection: params.measurementDirection,
          condition: params.condition,
          reviewStatus: params.reviewStatus,
          evidenceStrength: params.evidenceStrength,
          sourceId: params.sourceId,
          sourceTrustTier: params.sourceTrustTier,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          data?.message || data?.error || "Failed to search evidence",
        );
      }
      setEvidencePack(data.evidencePack || null);
    } catch (err: any) {
      setError(err?.message || "Failed to search evidence");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    search({ query: initialQuery, limit: 12 });
  }, [initialQuery, search]);

  return { evidencePack, isLoading, error, search };
}

export async function uploadResearchBrainSource(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch("/api/research-brain/sources/upload", {
    method: "POST",
    headers: authHeaders(),
    credentials: "include",
    body: formData,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(data?.message || data?.error || "Failed to upload paper");
  return data;
}

export async function reextractResearchBrainSource(sourceId: string) {
  const res = await fetch(`/api/research-brain/sources/${sourceId}/extract`, {
    method: "POST",
    headers: authHeaders(),
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(data?.message || data?.error || "Failed to extract claims");
  return data;
}

export async function updateBioprospectingFactReview(
  factId: string,
  reviewStatus: ResearchBrainReviewStatus,
  reviewNote?: string | null,
) {
  const res = await fetch(
    `/api/research-brain/bioprospecting/facts/${factId}/review`,
    {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      credentials: "include",
      body: JSON.stringify({ reviewStatus, reviewNote }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data?.message || data?.error || "Failed to update fact review",
    );
  }
  return data.fact;
}

export async function updateBioprospectingFactsReviewBulk(
  factIds: string[],
  reviewStatus: ResearchBrainReviewStatus,
  reviewNote?: string | null,
) {
  const res = await fetch(
    "/api/research-brain/bioprospecting/facts/review-bulk",
    {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      credentials: "include",
      body: JSON.stringify({ factIds, reviewStatus, reviewNote }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data?.message || data?.error || "Failed to bulk update fact reviews",
    );
  }
  return data;
}

export async function updateBioprospectingFactEntities(
  factId: string,
  patch: ResearchBrainFactEntityPatch,
) {
  const res = await fetch(
    `/api/research-brain/bioprospecting/facts/${factId}/entities`,
    {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      credentials: "include",
      body: JSON.stringify(patch),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data?.message || data?.error || "Failed to update fact entities",
    );
  }
  return data.fact;
}
