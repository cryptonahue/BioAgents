import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";
import { COMPOUND_AUTHORITY_REASONS } from "./compoundAuthority";
import { buildIdentityKey } from "./normalize";
import type {
  BioprospectingFact,
  ExtractedBioprospectingFact,
  ExtractedClaim,
  ResearchClaim,
  ResearchEvidenceChunk,
  ResearchSource,
  ResearchSourceKind,
  ResearchTaxonRank,
  ResearchTrustTier,
} from "./types";

/**
 * Lazily-resolved Supabase client proxy. Every property access on
 * `supabase` (e.g., `supabase.from(...)`) calls `getServiceClient()`
 * fresh, so the singleton in `src/db/client.ts` is consulted on every
 * operation. This is a no-op in production (the singleton is cached
 * after first call) and makes the module fully testable: tests can
 * register a `mock.module` for `../../db/client` and the proxy will
 * resolve to the mock on each call.
 *
 * Without this proxy, `const supabase = getServiceClient()` would
 * capture the client ONCE at module load time, freezing the test
 * mock before `beforeEach` can swap it.
 */
const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getServiceClient() as unknown as Record<
      string | symbol,
      unknown
    >;
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as SupabaseClient;

const DOI_REGEX = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;

export function extractDoi(text: string): string | null {
  const match = text.match(DOI_REGEX);
  return match ? match[0] : null;
}

export async function upsertResearchSource(params: {
  sourceKind: ResearchSourceKind;
  trustTier: ResearchTrustTier;
  title: string;
  doi?: string | null;
  url?: string | null;
  filePath?: string | null;
  contentHash?: string | null;
  fileSize?: number | null;
  lastModifiedAt?: string | Date | null;
  sourceScope?: string;
  metadata?: Record<string, unknown>;
  extractionStatus?: string;
}): Promise<ResearchSource> {
  const payload = {
    source_kind: params.sourceKind,
    trust_tier: params.trustTier,
    source_scope: params.sourceScope || "global",
    title: params.title,
    doi: params.doi || null,
    url: params.url || null,
    file_path: params.filePath || null,
    content_hash: params.contentHash || null,
    file_size: params.fileSize || null,
    last_modified_at: params.lastModifiedAt
      ? new Date(params.lastModifiedAt).toISOString()
      : null,
    extraction_status: params.extractionStatus || "pending_extraction",
    metadata: params.metadata || {},
  };

  if (params.doi) {
    const { data: existing, error: findError } = await supabase
      .from("research_sources")
      .select("*")
      .ilike("doi", params.doi)
      .maybeSingle();
    if (findError) throw findError;
    if (existing) {
      const nextExtractionStatus =
        (existing as any).extraction_status === "extracted" &&
        payload.extraction_status === "pending_extraction"
          ? (existing as any).extraction_status
          : payload.extraction_status;
      const { data, error } = await supabase
        .from("research_sources")
        .update({
          ...payload,
          extraction_status: nextExtractionStatus,
          metadata: {
            ...((existing as any).metadata || {}),
            ...payload.metadata,
          },
        })
        .eq("id", (existing as any).id)
        .select("*")
        .single();
      if (error) throw error;
      return data as ResearchSource;
    }
  }

  if (params.filePath) {
    const { data: existing, error: findError } = await supabase
      .from("research_sources")
      .select("*")
      .eq("file_path", params.filePath)
      .maybeSingle();
    if (findError) throw findError;
    if (existing) {
      const nextExtractionStatus =
        (existing as any).extraction_status === "extracted" &&
        payload.extraction_status === "pending_extraction"
          ? (existing as any).extraction_status
          : payload.extraction_status;
      const { data, error } = await supabase
        .from("research_sources")
        .update({
          ...payload,
          extraction_status: nextExtractionStatus,
          metadata: {
            ...((existing as any).metadata || {}),
            ...payload.metadata,
          },
        })
        .eq("id", (existing as any).id)
        .select("*")
        .single();
      if (error) throw error;
      return data as ResearchSource;
    }
  }

  if (params.contentHash) {
    const { data: existing, error: findError } = await supabase
      .from("research_sources")
      .select("*")
      .eq("content_hash", params.contentHash)
      .maybeSingle();
    if (findError) throw findError;
    if (existing) {
      const nextExtractionStatus =
        (existing as any).extraction_status === "extracted" &&
        payload.extraction_status === "pending_extraction"
          ? (existing as any).extraction_status
          : payload.extraction_status;
      const { data, error } = await supabase
        .from("research_sources")
        .update({
          ...payload,
          extraction_status: nextExtractionStatus,
          metadata: {
            ...((existing as any).metadata || {}),
            ...payload.metadata,
          },
        })
        .eq("id", (existing as any).id)
        .select("*")
        .single();
      if (error) throw error;
      return data as ResearchSource;
    }
  }

  const { data, error } = await supabase
    .from("research_sources")
    .insert(payload)
    .select("*")
    .single();

  if (error) throw error;
  return data as ResearchSource;
}

export async function setSourceExtractionStatus(
  sourceId: string,
  status: "pending_extraction" | "extracted" | "failed_extraction",
  errorMessage?: string,
): Promise<void> {
  const { error } = await supabase
    .from("research_sources")
    .update({
      extraction_status: status,
      extraction_error: errorMessage || null,
    })
    .eq("id", sourceId);

  if (error) throw error;
}

export async function setSourceBioprospectingStatus(
  sourceId: string,
  params: {
    status:
      | "pending"
      | "running"
      | "extracted"
      | "failed"
      | "no_chunks"
      | "skipped";
    errorMessage?: string | null;
    factCount?: number;
  },
): Promise<void> {
  const patch: Record<string, unknown> = {
    bioprospecting_status: params.status,
    bioprospecting_error: params.errorMessage || null,
  };

  if (params.factCount != null) {
    patch.bioprospecting_fact_count = params.factCount;
  }

  if (params.status === "extracted" || params.status === "no_chunks") {
    patch.bioprospecting_extracted_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from("research_sources")
    .update(patch)
    .eq("id", sourceId);

  if (error) throw error;
}

export async function listBioprospectingSourceCandidates(params: {
  status?: string;
  sourceKind?: ResearchSourceKind;
  limit?: number;
}): Promise<ResearchSource[]> {
  let query = supabase
    .from("research_sources")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(params.limit || 25);

  if (params.status && params.status !== "all") {
    query = query.eq("bioprospecting_status", params.status);
  }

  if (params.sourceKind) {
    query = query.eq("source_kind", params.sourceKind);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as ResearchSource[];
}

export async function replaceEvidenceChunks(
  sourceId: string,
  chunks: Array<{
    documentId?: string | null;
    content: string;
    section?: string | null;
    page?: number | null;
    chunkIndex?: number | null;
    metadata?: Record<string, unknown>;
  }>,
): Promise<ResearchEvidenceChunk[]> {
  const { error: deleteError } = await supabase
    .from("research_evidence_chunks")
    .delete()
    .eq("source_id", sourceId);
  if (deleteError) throw deleteError;

  if (chunks.length === 0) return [];

  const { data, error } = await supabase
    .from("research_evidence_chunks")
    .insert(
      chunks.map((chunk) => ({
        source_id: sourceId,
        document_id: chunk.documentId || null,
        content: chunk.content,
        section: chunk.section || null,
        page: chunk.page || null,
        chunk_index: chunk.chunkIndex ?? null,
        metadata: chunk.metadata || {},
      })),
    )
    .select("*");

  if (error) throw error;
  return (data || []) as ResearchEvidenceChunk[];
}

export async function replaceClaimsForSource(
  source: ResearchSource,
  claims: ExtractedClaim[],
  evidenceChunks: ResearchEvidenceChunk[],
): Promise<ResearchClaim[]> {
  const { error: deleteError } = await supabase
    .from("research_claims")
    .delete()
    .eq("source_id", source.id);
  if (deleteError) throw deleteError;

  const chunkByIndex = new Map<number, ResearchEvidenceChunk>();
  for (const chunk of evidenceChunks) {
    if (chunk.chunk_index != null) chunkByIndex.set(chunk.chunk_index, chunk);
  }

  const validClaims = claims
    .map((claim) => {
      const evidence =
        claim.chunkIndex != null
          ? chunkByIndex.get(claim.chunkIndex)
          : undefined;
      const hasEvidence = !!evidence?.id;
      const status = hasEvidence
        ? claim.status || "supported"
        : claim.status === "open_question"
          ? "open_question"
          : "hypothesis";

      return {
        claim: claim.claim.trim(),
        claim_type: claim.claimType || "finding",
        status,
        confidence: claim.confidence || (hasEvidence ? "medium" : "low"),
        source_id: source.id,
        chunk_id: evidence?.id || null,
        doi: source.doi || null,
        trust_tier: source.trust_tier,
        metadata: {
          entities: claim.entities || [],
          extractor: "researchBrainExtractor",
          sourceTitle: source.title,
        },
      };
    })
    .filter((claim) => claim.claim.length > 0);

  if (validClaims.length === 0) return [];

  const { data, error } = await supabase
    .from("research_claims")
    .insert(validClaims)
    .select("*");

  if (error) throw error;
  return (data || []) as ResearchClaim[];
}

export async function createClaimEdges(claims: ResearchClaim[]): Promise<void> {
  const edges = claims
    .filter((claim) => claim.source_id)
    .map((claim) => ({
      from_id: claim.id,
      from_type: "claim",
      relation_type:
        claim.status === "contradicted"
          ? "contradicts"
          : claim.status === "hypothesis"
            ? "derived_from"
            : "supports",
      to_id: claim.source_id,
      to_type: "source",
      metadata: {
        status: claim.status,
        trustTier: claim.trust_tier,
      },
    }));

  if (edges.length === 0) return;

  const { error } = await supabase.from("research_edges").insert(edges);
  if (error) {
    logger.warn({ err: error }, "research_brain_edges_insert_failed");
  }
}

/**
 * Read-only helper that loads the (page, table_index) → id map for
 * a source's persisted tables. Used by
 * `replaceBioprospectingFactsForSource` to resolve the LLM's
 * `sourceTableRef` payload to a real `evidence_table_id` UUID.
 *
 * Returns an empty map when the source has no tables or the read
 * fails (caller is expected to handle the miss by logging and
 * dropping the ref).
 */
async function loadEvidenceTableIdMap(
  sourceId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!sourceId) return map;
  const { data, error } = await supabase
    .from("research_evidence_tables")
    .select("id, page, table_index")
    .eq("source_id", sourceId);
  if (error) {
    logger.warn(
      { err: error, sourceId },
      "bioprospecting_evidence_table_map_failed",
    );
    return map;
  }
  for (const row of (data || []) as Array<{
    id: string;
    page: number;
    table_index: number;
  }>) {
    map.set(`${row.page}:${row.table_index}`, row.id);
  }
  return map;
}

/**
 * Resolve an LLM-emitted `sourceTableRef` to a real
 * `evidence_table_id` UUID. Logs a structured event on miss (so
 * operators can spot LLM hallucinations) and returns `null` so the
 * fact still persists with `evidence_table_id IS NULL`.
 */
function resolveEvidenceTableId(
  fact: ExtractedBioprospectingFact,
  tableByRef: Map<string, string>,
): string | null {
  if (!fact.sourceTableRef) return null;
  const key = `${fact.sourceTableRef.page}:${fact.sourceTableRef.tableIndex}`;
  const id = tableByRef.get(key);
  if (!id) {
    logger.warn(
      {
        sourceTableRef: fact.sourceTableRef,
        sourceId: undefined,
      },
      "bioprospecting_table_ref_missing",
    );
  }
  return id ?? null;
}

export async function replaceBioprospectingFactsForSource(
  source: ResearchSource,
  facts: ExtractedBioprospectingFact[],
  evidenceChunks: ResearchEvidenceChunk[],
): Promise<BioprospectingFact[]> {
  const { error: deleteError } = await supabase
    .from("research_bioprospecting_facts")
    .delete()
    .eq("source_id", source.id);
  if (deleteError) throw deleteError;

  const chunkByIndex = new Map<number, ResearchEvidenceChunk>();
  for (const chunk of evidenceChunks) {
    if (chunk.chunk_index != null) chunkByIndex.set(chunk.chunk_index, chunk);
  }

  // Look up the source's persisted tables so we can resolve
  // `sourceTableRef` to `evidence_table_id`. A miss is logged and
  // dropped (the fact is still saved without a table FK).
  const tableByRef = await loadEvidenceTableIdMap(source.id);

  const payload = facts
    .map((fact) => {
      const chunk =
        fact.chunkIndex != null ? chunkByIndex.get(fact.chunkIndex) : undefined;
      const hasEvidence = !!chunk?.id;
      const quote = normalizeOptionalString(fact.quote);
      const evidenceTableId = resolveEvidenceTableId(fact, tableByRef);

      return {
        source_id: source.id,
        chunk_id: chunk?.id || null,
        species: normalizeOptionalString(fact.species),
        genus: normalizeOptionalString(fact.genus),
        family: normalizeOptionalString(fact.family),
        higher_taxon: normalizeOptionalString(fact.higherTaxon),
        organism_group: normalizeOptionalString(fact.organismGroup),
        geography: normalizeOptionalString(fact.geography),
        ecosystem: normalizeOptionalString(fact.ecosystem),
        organism_part: normalizeOptionalString(fact.organismPart),
        compound: normalizeOptionalString(fact.compound),
        compound_class: normalizeOptionalString(fact.compoundClass),
        molecule_type: normalizeOptionalString(fact.moleculeType),
        bioactivity: normalizeOptionalString(fact.bioactivity),
        application_area: normalizeOptionalString(fact.applicationArea),
        assay_model: normalizeOptionalString(fact.assayModel),
        result_summary: normalizeOptionalString(fact.resultSummary),
        measurement_value: normalizeOptionalNumber(fact.measurementValue),
        measurement_unit: normalizeOptionalString(fact.measurementUnit),
        measurement_direction: normalizeMeasurementDirection(
          fact.measurementDirection,
        ),
        measurement_min: normalizeOptionalNumber(fact.measurementMin),
        measurement_max: normalizeOptionalNumber(fact.measurementMax),
        timepoint: normalizeOptionalString(fact.timepoint),
        condition: normalizeOptionalString(fact.condition),
        p_value: normalizeOptionalNumber(fact.pValue),
        sample_size: normalizeOptionalInteger(fact.sampleSize),
        statistical_test: normalizeOptionalString(fact.statisticalTest),
        evidence_type: normalizeOptionalString(fact.evidenceType),
        relation_type:
          normalizeOptionalString(fact.relationType) || "reported_activity",
        status: hasEvidence
          ? fact.status || "supported"
          : fact.status === "open_question"
            ? "open_question"
            : "hypothesis",
        confidence: fact.confidence || (hasEvidence ? "medium" : "low"),
        quote,
        doi: source.doi || null,
        page: chunk?.page || null,
        evidence_table_id: evidenceTableId,
        // Compound authority columns — stamped by
        // `attachCompoundAuthority` in the extractor before this
        // function is called. The raw `compound` text above is
        // NEVER overwritten by the canonical name; these columns
        // are a parallel signal. `compound_authority_attempts`
        // defaults to 0 on fresh inserts.
        compound_canonical_id: fact.compound_canonical_id ?? null,
        compound_authority_status:
          fact.compound_authority_status ?? "pending",
        compound_authority_at: fact.compound_authority_at ?? null,
        compound_authority_error: fact.compound_authority_error ?? null,
        compound_authority_attempts: fact.compound_authority_attempts ?? 0,
        metadata: {
          entities: fact.entities || [],
          extractor: "bioprospectingExtractor",
          sourceTitle: source.title,
          chunkIndex: fact.chunkIndex ?? null,
          sourceTableRef: fact.sourceTableRef ?? null,
        },
      };
    })
    .filter((fact) =>
      [
        fact.species,
        fact.genus,
        fact.compound,
        fact.bioactivity,
        fact.application_area,
        fact.result_summary,
        fact.quote,
      ].some((value) => value && String(value).trim().length > 0),
    );

  if (payload.length === 0) return [];

  // ---------------------------------------------------------------------
  // Phase 2: inline merge. Group the payload by buildIdentityKey, then
  // process each group independently. Null-key groups (all five identity
  // fields blank) are inserted as-is, no merge. Keyed singletons and
  // keyed groups of K >= 2 go through canonical selection and edge
  // insertion; cross-source collisions (PG 23505 on the canonical row
  // because a pre-existing fact already owns the key) are re-routed:
  // the existing canonical stays put, the incoming rows become merged
  // siblings with edges pointing to the existing canonical.
  // ---------------------------------------------------------------------

  const groups: Map<string, typeof payload> = new Map();
  const nullKeyFacts: typeof payload = [];
  for (const fact of payload) {
    const key = buildIdentityKey(fact as BioprospectingFact);
    if (key === null) {
      nullKeyFacts.push(fact);
    } else {
      const bucket = groups.get(key);
      if (bucket) bucket.push(fact);
      else groups.set(key, [fact]);
    }
  }

  const inserted: BioprospectingFact[] = [];

  // Null-key group: insert as plain rows (no dedup eligibility).
  if (nullKeyFacts.length > 0) {
    const { data, error } = await supabase
      .from("research_bioprospecting_facts")
      .insert(nullKeyFacts)
      .select("*");
    if (error) throw error;
    inserted.push(...((data || []) as BioprospectingFact[]));
  }

  // Keyed groups (singletons and K >= 2).
  for (const [key, group] of groups) {
    if (group.length === 1) {
      const row = await insertCanonicalWithReroute(group[0], key);
      inserted.push(row.canonical, ...row.mergedSiblings);
    } else {
      const canonicalIndex = pickCanonicalIndex(group);
      const canonical = group[canonicalIndex];
      const siblings = group.filter((_, idx) => idx !== canonicalIndex);

      const { data: canonicalRow, error: canonicalError } = await supabase
        .from("research_bioprospecting_facts")
        .insert([canonical])
        .select("*")
        .single();

      if (canonicalError) {
        if (canonicalError.code === "23505") {
          // Cross-source collision: a pre-existing canonical owns this key.
          const existing = await findCanonicalByIdentityKey(key);
          if (!existing) throw canonicalError; // unexpected
          const { data: mergedRows, error: mergedError } = await supabase
            .from("research_bioprospecting_facts")
            .insert(
              group.map((fact) => ({
                ...fact,
                merged_into_fact_id: existing.id,
              })),
            )
            .select("*");
          if (mergedError) throw mergedError;
          const mergedIds = (mergedRows || []).map((r) => r.id as string);
          await insertMergeEdges(existing.id, mergedIds);
          inserted.push(
            existing,
            ...((mergedRows || []) as BioprospectingFact[]),
          );
          continue;
        }
        throw canonicalError;
      }

      // Canonical persisted. Insert siblings with merged_into_fact_id set
      // (the partial unique index allows siblings because the column is
      // non-NULL on those rows). Then write the K-1 edges.
      const siblingsWithParent = siblings.map((sibling) => ({
        ...sibling,
        merged_into_fact_id: canonicalRow.id,
      }));
      const { data: siblingRows, error: siblingError } = await supabase
        .from("research_bioprospecting_facts")
        .insert(siblingsWithParent)
        .select("*");
      if (siblingError) throw siblingError;
      const siblingIds = (siblingRows || []).map((r) => r.id as string);
      await insertMergeEdges(canonicalRow.id, siblingIds);
      inserted.push(
        canonicalRow as BioprospectingFact,
        ...((siblingRows || []) as BioprospectingFact[]),
      );
    }
  }

  return inserted;
}

/**
 * Canonical-selection precedence for inline merge. Verified wins over
 * any non-verified row. Within a review_status class the most recent
 * `updated_at` wins; ties break by `source_id` ascending (deterministic),
 * then by array index (stable) for the within-source case where
 * `source_id` is the same for every fact in the group.
 *
 * Exported so the test suite can verify the precedence ordering without
 * hitting the database — the function is pure.
 *
 * Returns the index into the group array.
 */
export function pickCanonicalIndex(
  group: Array<Record<string, unknown>>,
): number {
  let bestIndex = 0;
  let bestScore = canonicalScore(group[0], 0);
  for (let i = 1; i < group.length; i++) {
    const score = canonicalScore(group[i], i);
    if (compareCanonicalScores(score, bestScore) < 0) {
      bestIndex = i;
      bestScore = score;
    }
  }
  return bestIndex;
}

type CanonicalScore = {
  verified: 0 | 1;
  updatedAt: number; // ms epoch; higher = more recent
  sourceId: string;
  arrayIndex: number;
};

function canonicalScore(
  fact: Record<string, unknown>,
  arrayIndex: number,
): CanonicalScore {
  const reviewStatus = fact.review_status as string | undefined;
  const updatedAtRaw = (fact.updated_at ?? fact.created_at) as
    | string
    | number
    | Date
    | null
    | undefined;
  const updatedAt = updatedAtRaw ? new Date(updatedAtRaw).getTime() : 0;
  return {
    verified: reviewStatus === "verified" ? 0 : 1,
    updatedAt,
    sourceId: (fact.source_id as string) ?? "",
    arrayIndex,
  };
}

function compareCanonicalScores(
  candidate: CanonicalScore,
  current: CanonicalScore,
): number {
  // Lower = better. Returns negative if `candidate` should win.
  if (candidate.verified !== current.verified) {
    return candidate.verified - current.verified;
  }
  if (candidate.updatedAt !== current.updatedAt) {
    // More recent wins → larger updatedAt is better → subtract.
    return current.updatedAt - candidate.updatedAt;
  }
  if (candidate.sourceId !== current.sourceId) {
    return candidate.sourceId < current.sourceId ? -1 : 1;
  }
  // Final tiebreaker: smaller array index wins (stable order).
  return candidate.arrayIndex - current.arrayIndex;
}

/**
 * Insert a single canonical row, handling the cross-source collision case
 * (PG 23505) by re-routing: the existing pre-existing row stays as canonical,
 * the incoming row(s) become merged siblings with edges pointing to it.
 *
 * Used for keyed singleton groups. The K >= 2 case handles its own
 * re-route inline because the canonical needs to be attempted first
 * (siblings depend on the canonical's id).
 */
async function insertCanonicalWithReroute(
  fact: Record<string, unknown>,
  key: string,
): Promise<{
  canonical: BioprospectingFact;
  mergedSiblings: BioprospectingFact[];
}> {
  const { data, error } = await supabase
    .from("research_bioprospecting_facts")
    .insert([fact])
    .select("*")
    .single();

  if (!error) {
    return { canonical: data as BioprospectingFact, mergedSiblings: [] };
  }

  if (error.code !== "23505") {
    throw error;
  }

  // Cross-source collision. Look up the existing canonical and re-route.
  const existing = await findCanonicalByIdentityKey(key);
  if (!existing) throw error; // unexpected: 23505 with no matching row

  const { data: mergedRows, error: mergedError } = await supabase
    .from("research_bioprospecting_facts")
    .insert([{ ...fact, merged_into_fact_id: existing.id }])
    .select("*");
  if (mergedError) throw mergedError;
  const mergedIds = (mergedRows || []).map((r) => r.id as string);
  await insertMergeEdges(existing.id, mergedIds);
  return {
    canonical: existing,
    mergedSiblings: (mergedRows || []) as BioprospectingFact[],
  };
}

/**
 * Look up the canonical fact for a given identity_key (the row with
 * merged_into_fact_id IS NULL, if any). Returns null if the key is not
 * present in the table or if every row with that key is itself a merged
 * sibling (defensive — partial unique index prevents this in practice).
 */
async function findCanonicalByIdentityKey(
  key: string,
): Promise<BioprospectingFact | null> {
  const { data, error } = await supabase
    .from("research_bioprospecting_facts")
    .select("*")
    .eq("identity_key", key)
    .is("merged_into_fact_id", null)
    .maybeSingle();
  if (error) throw error;
  return (data as BioprospectingFact | null) ?? null;
}

/**
 * Insert K-1 edge rows pointing from each merged fact id to the canonical
 * fact id. The composite PK (canonical, merged) is the authoritative
 * uniqueness guard — duplicates (e.g., re-running the merge on the same
 * data) are silently treated as success via ON CONFLICT DO NOTHING.
 */
async function insertMergeEdges(
  canonicalId: string,
  mergedIds: string[],
): Promise<void> {
  if (mergedIds.length === 0) return;
  const rows = mergedIds.map((mergedId) => ({
    canonical_fact_id: canonicalId,
    merged_fact_id: mergedId,
    match_rule: "identity_key" as const,
  }));
  const { error } = await supabase
    .from("research_bioprospecting_fact_edges")
    .insert(rows)
    .select();
  if (error) {
    // Composite PK collision: edge already exists for this pair. Idempotent
    // re-runs hit this branch; surface other errors.
    if (error.code !== "23505") {
      logger.warn(
        { err: error, canonicalId, mergedIds },
        "bioprospecting_merge_edge_insert_failed",
      );
      throw error;
    }
  }
}

/**
 * Read-only lineage helper. Given a list of fact ids, returns the subset
 * that have been merged into a canonical via an ACTIVE edge in
 * `research_bioprospecting_fact_edges` (i.e., appear as `merged_fact_id`
 * in a row where `is_active = true`).
 *
 * bioprospecting-review-ui: switched from the `merged_into_fact_id`
 * cache column on `research_bioprospecting_facts` to the edge table
 * because the cache is NOT cleared on unmerge (the soft-delete contract
 * keeps the cache populated for the audit trail). Reading the edge
 * table with `is_active = true` is the only way to make an unmerged
 * fact invisible to the lineage query layer — see
 * `bioprospecting-semantic-dedup` spec §"Lineage Helpers Filter On
 * is_active".
 *
 * Read-only: no insert, update, or delete.
 */
export async function findMergedFactIds(
  factIds: string[],
): Promise<Set<string>> {
  const uniqueIds = Array.from(new Set(factIds.filter(Boolean)));
  if (uniqueIds.length === 0) return new Set();

  // Read from the edge table — the authoritative source of truth for
  // dedup lineage. The `eq("is_active", true)` filter is the contract
  // from the spec: an unmerged edge is invisible to this helper.
  const { data, error } = await supabase
    .from("research_bioprospecting_fact_edges")
    .select("merged_fact_id")
    .in("merged_fact_id", uniqueIds)
    .eq("is_active", true);
  if (error) throw error;
  return new Set(
    ((data || []) as Array<{ merged_fact_id: string }>).map(
      (r) => r.merged_fact_id,
    ),
  );
}

/**
 * Read-only lineage helper. Given a fact id, returns the dedup group it
 * belongs to: the canonical fact plus any merged siblings. Resolves from
 * either side (canonical or merged) — if `factId` is itself a merged
 * sibling the function still returns the canonical it points at.
 *
 * Returns `null` when the fact is standalone (no edges touch it and
 * no other row references it as a canonical).
 *
 * Read-only: no insert, update, or delete.
 */
export async function getDuplicateGroup(factId: string): Promise<{
  canonical: BioprospectingFact;
  merged: BioprospectingFact[];
} | null> {
  if (!factId) return null;

  // Touch the edge table to detect group membership cheaply.
  // bioprospecting-review-ui: filter on `is_active = true` so a
  // previously-unmerged edge is invisible to the lineage query
  // layer. The unmerge sets the flag to `false`; the soft-delete
  // contract (see design.md §"Soft-delete edge rows") is "is_active
  // = false" only.
  const { data: edges, error: edgesError } = await supabase
    .from("research_bioprospecting_fact_edges")
    .select("canonical_fact_id, merged_fact_id")
    .or(`canonical_fact_id.eq.${factId},merged_fact_id.eq.${factId}`)
    .eq("is_active", true)
    .limit(1);
  if (edgesError) throw edgesError;
  if (!edges || edges.length === 0) return null;

  // Resolve canonical id. The fact itself may be canonical (it appears
  // as canonical_fact_id) or a merged sibling (it appears as merged_fact_id).
  const row = edges[0] as { canonical_fact_id: string; merged_fact_id: string };
  const canonicalId =
    row.canonical_fact_id === factId ? factId : row.canonical_fact_id;

  // Fetch the full group: the canonical plus every row that points to it.
  // Two queries then merge: the canonical row (matched by id + null parent)
  // and the sibling rows (matched by parent). Merged in memory.
  const [
    { data: canonicalRow, error: canonicalError },
    { data: siblingRows, error: siblingsError },
  ] = await Promise.all([
    supabase
      .from("research_bioprospecting_facts")
      .select(
        "*, source:research_sources(*), chunk:research_evidence_chunks(*)",
      )
      .eq("id", canonicalId)
      .is("merged_into_fact_id", null)
      .maybeSingle(),
    supabase
      .from("research_bioprospecting_facts")
      .select(
        "*, source:research_sources(*), chunk:research_evidence_chunks(*)",
      )
      .eq("merged_into_fact_id", canonicalId),
  ]);
  if (canonicalError) throw canonicalError;
  if (siblingsError) throw siblingsError;

  const groupData = canonicalRow
    ? [canonicalRow, ...((siblingRows || []) as BioprospectingFact[])]
    : ((siblingRows || []) as BioprospectingFact[]);
  if (groupData.length === 0) return null;

  const canonical = groupData.find((r) => r.id === canonicalId) as
    | BioprospectingFact
    | undefined;
  if (!canonical) return null;

  const merged = groupData.filter(
    (r) => r.id !== canonicalId,
  ) as BioprospectingFact[];
  return { canonical, merged };
}

/**
 * Result of a single backfill invocation.
 *
 * `edgesInserted` and `edgesSkipped` always sum to `edgesProposed`
 * (a duplicate edge is counted as `skipped`, not `inserted`).
 * `examples` carries up to 10 sample groups for operator review during
 * a dry run.
 */
export type BioprospectingFactDedupBackfillResult = {
  scannedFacts: number;
  groupsFound: number;
  edgesProposed: number;
  edgesInserted: number;
  edgesSkipped: number;
  examples: Array<{
    identityKey: string;
    canonicalId: string;
    canonicalReviewStatus: string | null;
    mergedIds: string[];
  }>;
};

/**
 * One-shot backfill that dedupes the `research_bioprospecting_facts`
 * table as it exists before this change ships. Mirrors the inline merge
 * in `replaceBioprospectingFactsForSource` but is read-or-additive only
 * (no fact row is mutated).
 *
 * Algorithm:
 *   1. Read facts where `id NOT IN (SELECT merged_fact_id FROM
 *      research_bioprospecting_fact_edges)`, ordered by
 *      `(created_at, id)` and capped at `limit`.
 *   2. Compute `buildIdentityKey` in-memory for each candidate.
 *   3. Group by key (skip nulls).
 *   4. For each group of size K >= 2, pick the canonical via
 *      `pickCanonicalIndex` (verified > updated_at desc > source_id asc
 *      > id asc — same rule as inline merge).
 *   5. In `--apply` mode, INSERT edge rows
 *      `(canonical.id, sibling.id, 'identity_key')` with
 *      `ON CONFLICT (canonical_fact_id, merged_fact_id) DO NOTHING`.
 *      Composite PK collisions are counted as `edgesSkipped`.
 *   6. In `--dry-run` mode, no inserts happen; `edgesProposed` is the
 *      number of edges that WOULD be inserted.
 *
 * Idempotency: re-running with `--apply` on the same data reports
 * `edgesInserted: 0` and `edgesSkipped: edgesProposed`. The script
 * is additive only — no fact row is updated, deleted, or
 * re-canonicalized. Safe to re-run any number of times.
 */
export async function backfillBioprospectingFactDedup(params: {
  limit?: number;
  batchSize?: number;
  dryRun?: boolean;
}): Promise<BioprospectingFactDedupBackfillResult> {
  const limit = params.limit ?? 500;
  const batchSize = params.batchSize ?? 500;
  const dryRun = params.dryRun ?? true;

  // PostgREST does not support `(SELECT ...)` as the value of
  // `.not("id", "in", ...)`, so we fetch the merged ids separately
  // and apply the dedup filter in JS. For typical ingestion runs
  // (hundreds of facts) the edges table is small and this is cheap.
  const { data: edgeRows, error: edgeError } = await supabase
    .from("research_bioprospecting_fact_edges")
    .select("merged_fact_id");
  if (edgeError) {
    logger.warn({ err: edgeError }, "dedup_edges_load_failed_continuing");
  }
  const mergedIds = new Set(
    (edgeRows || []).map((r: { merged_fact_id: string }) => r.merged_fact_id),
  );

  const { data: candidateRows, error: candidateError } = await supabase
    .from("research_bioprospecting_facts")
    .select(
      "id, source_id, species, compound, bioactivity, organism_part, geography, review_status, updated_at, created_at, merged_into_fact_id",
    )
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit * 2); // over-fetch so the in-memory filter can drop merged rows

  if (candidateError) throw candidateError;

  // Drop merged siblings in JS (the postgrest `.not("id", "in", "(SELECT …)")` form is invalid).
  const dedupedRows = (candidateRows || []).filter(
    (r: { id: string }) => !mergedIds.has(r.id),
  );
  // Re-apply the limit after the in-memory filter.
  return dedupedRows.slice(0, limit) as typeof candidateRows;

  if (candidateError) throw candidateError;

  const rows = (candidateRows || []) as Array<Record<string, unknown>>;
  const scannedFacts = rows.length;

  // Group by identity key in memory. Skip null keys (all five identity
  // fields blank — not eligible for dedup).
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const key = buildIdentityKey(row as BioprospectingFact);
    if (key === null) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  // Plan edges per group. Only K >= 2 groups produce proposed edges.
  type PlannedEdge = {
    canonicalId: string;
    mergedId: string;
    identityKey: string;
    canonicalReviewStatus: string | null;
    mergedIds: string[];
  };
  const plannedEdges: PlannedEdge[] = [];
  const exampleSummaries: BioprospectingFactDedupBackfillResult["examples"] =
    [];

  for (const [identityKey, group] of groups) {
    if (group.length < 2) continue;
    const canonicalIndex = pickCanonicalIndex(group);
    const canonical = group[canonicalIndex] as Record<string, unknown>;
    const siblings = group.filter((_, idx) => idx !== canonicalIndex);

    const canonicalId = canonical.id as string;
    const canonicalReviewStatus = (canonical.review_status as string) ?? null;
    const mergedIds = siblings.map((s) => s.id as string);

    for (const mergedId of mergedIds) {
      plannedEdges.push({
        canonicalId,
        mergedId,
        identityKey,
        canonicalReviewStatus,
        mergedIds,
      });
    }

    if (exampleSummaries.length < 10) {
      exampleSummaries.push({
        identityKey,
        canonicalId,
        canonicalReviewStatus,
        mergedIds,
      });
    }
  }

  const edgesProposed = plannedEdges.length;
  let edgesInserted = 0;
  let edgesSkipped = 0;

  if (!dryRun && edgesProposed > 0) {
    // Insert in batches with ON CONFLICT DO NOTHING. Composite PK
    // (canonical, merged) is the authoritative uniqueness guard.
    for (let i = 0; i < plannedEdges.length; i += batchSize) {
      const slice = plannedEdges.slice(i, i + batchSize);
      const insertRows = slice.map((edge) => ({
        canonical_fact_id: edge.canonicalId,
        merged_fact_id: edge.mergedId,
        match_rule: "identity_key" as const,
      }));
      const { data: inserted, error: insertError } = await supabase
        .from("research_bioprospecting_fact_edges")
        .insert(insertRows)
        .select("canonical_fact_id, merged_fact_id");
      if (insertError) {
        // Composite PK collision means "already merged" — treat as
        // success. Anything else is a real error.
        if (insertError.code !== "23505") throw insertError;
        // Whole batch collided: count as skipped.
        edgesSkipped += slice.length;
        continue;
      }
      // supabase-js does not distinguish inserted vs. skipped in the
      // response for ON CONFLICT DO NOTHING. Treat the response as the
      // subset that the server actually wrote.
      const written = (inserted || []).length;
      edgesInserted += written;
      edgesSkipped += slice.length - written;
    }
  }

  return {
    scannedFacts,
    groupsFound: Array.from(groups.values()).filter((g) => g.length >= 2)
      .length,
    edgesProposed,
    edgesInserted: dryRun ? 0 : edgesInserted,
    edgesSkipped: dryRun ? edgesProposed : edgesSkipped,
    examples: exampleSummaries,
  };
}

export type BioprospectingFactSearchParams = {
  query: string;
  limit?: number;
  measurementMin?: number;
  measurementMax?: number;
  measurementUnit?: string;
  measurementDirection?: "increase" | "decrease" | "no_change" | "mixed";
  condition?: string;
  reviewStatus?: BioprospectingReviewStatus | "all";
  sourceId?: string;
  sourceTrustTier?: ResearchTrustTier | "all";
  /**
   * Whether to include facts that have been merged into a canonical via
   * the dedup edge table (`research_bioprospecting_fact_edges`).
   *
   * **Default: `false`.** When omitted or `false`, the search applies an
   * SQL-level `id NOT IN (SELECT merged_fact_id FROM edges)` filter so
   * merged siblings never appear in the result set. Set this to `true`
   * only when the caller wants to inspect duplicates (e.g., the review
   * dashboard). The filter is applied at the SQL layer (not in JS
   * post-fetch) so result counts stay consistent with `limit`.
   *
   * Phase 3 of bioprospecting-semantic-dedup.
   */
  includeDuplicates?: boolean;
};

export type BioprospectingReviewStatus =
  | "unreviewed"
  | "verified"
  | "needs_review"
  | "incorrect"
  | "quarantined";

export async function updateBioprospectingFactReview(params: {
  factId: string;
  reviewStatus: BioprospectingReviewStatus;
  reviewNote?: string | null;
  reviewedBy?: string | null;
}): Promise<BioprospectingFact> {
  const patch = {
    review_status: params.reviewStatus,
    review_note: params.reviewNote || null,
    reviewed_by: params.reviewedBy || null,
    reviewed_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("research_bioprospecting_facts")
    .update(patch)
    .eq("id", params.factId)
    .select("*, source:research_sources(*), chunk:research_evidence_chunks(*)")
    .single();

  if (error) throw error;
  return data as BioprospectingFact;
}

export async function updateBioprospectingFactsReviewBulk(params: {
  factIds: string[];
  reviewStatus: BioprospectingReviewStatus;
  reviewNote?: string | null;
  reviewedBy?: string | null;
}): Promise<BioprospectingFact[]> {
  const factIds = Array.from(new Set(params.factIds.filter(Boolean))).slice(
    0,
    250,
  );
  if (factIds.length === 0) return [];

  const patch = {
    review_status: params.reviewStatus,
    review_note: params.reviewNote || null,
    reviewed_by: params.reviewedBy || null,
    reviewed_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("research_bioprospecting_facts")
    .update(patch)
    .in("id", factIds)
    .select("*, source:research_sources(*), chunk:research_evidence_chunks(*)");

  if (error) throw error;
  return (data || []) as BioprospectingFact[];
}

export type BioprospectingFactEntityPatch = {
  species?: string | null;
  genus?: string | null;
  family?: string | null;
  organism_group?: string | null;
  geography?: string | null;
  ecosystem?: string | null;
  organism_part?: string | null;
  compound?: string | null;
  compound_class?: string | null;
  molecule_type?: string | null;
  bioactivity?: string | null;
  application_area?: string | null;
  assay_model?: string | null;
  condition?: string | null;
};

const EDITABLE_BIOPROSPECTING_ENTITY_FIELDS = [
  "species",
  "genus",
  "family",
  "organism_group",
  "geography",
  "ecosystem",
  "organism_part",
  "compound",
  "compound_class",
  "molecule_type",
  "bioactivity",
  "application_area",
  "assay_model",
  "condition",
] as const;

export async function updateBioprospectingFactEntities(params: {
  factId: string;
  patch: BioprospectingFactEntityPatch;
  correctedBy?: string | null;
}): Promise<BioprospectingFact> {
  const { data: existing, error: existingError } = await supabase
    .from("research_bioprospecting_facts")
    .select("*")
    .eq("id", params.factId)
    .single();

  if (existingError) throw existingError;

  const sanitizedPatch: Record<string, string | null> = {};
  const changedFields: Record<
    string,
    { before: string | null; after: string | null }
  > = {};

  for (const field of EDITABLE_BIOPROSPECTING_ENTITY_FIELDS) {
    if (!(field in params.patch)) continue;
    const value = params.patch[field];
    if (value === undefined) continue;
    const nextValue =
      typeof value === "string"
        ? value.trim() || null
        : value == null
          ? null
          : String(value).trim() || null;
    const previousValue = ((existing as any)[field] as string | null) || null;
    sanitizedPatch[field] = nextValue;
    if (previousValue !== nextValue) {
      changedFields[field] = {
        before: previousValue,
        after: nextValue,
      };
    }
  }

  if (Object.keys(sanitizedPatch).length === 0) {
    return existing as BioprospectingFact;
  }

  const metadata = ((existing as any).metadata || {}) as Record<
    string,
    unknown
  >;
  const correctionHistory = Array.isArray(metadata.entityCorrectionHistory)
    ? metadata.entityCorrectionHistory
    : [];
  const correctionEntry = {
    correctedAt: new Date().toISOString(),
    correctedBy: params.correctedBy || null,
    fields: changedFields,
  };

  const patch: Record<string, unknown> = {
    ...sanitizedPatch,
    metadata: {
      ...metadata,
      lastEntityCorrection: correctionEntry,
      entityCorrectionHistory:
        Object.keys(changedFields).length > 0
          ? [...correctionHistory.slice(-19), correctionEntry]
          : correctionHistory,
    },
  };

  if (
    "species" in sanitizedPatch ||
    "genus" in sanitizedPatch ||
    "family" in sanitizedPatch
  ) {
    patch.taxonomy_status = "pending";
    patch.taxonomy_normalized_at = null;
    patch.taxonomy_error = null;
  }

  // ---------------------------------------------------------------------
  // PR #3 of `bioprospecting-compound-authority` — edit-reset hook.
  //
  // When the editor changes the raw `compound` text on a fact that
  // previously had a canonical id, the authority state is reset to
  // `pending` so the next backfill run re-resolves against the new
  // text. A `manual_edit` audit row is written capturing the text
  // diff AND the previous authority state. The previous
  // `compound_canonical_id` is intentionally kept on the row as a
  // snapshot for the audit trail — clearing it would orphan the
  // history. The new canonical resolution is the worker's job (it
  // runs on the next compound-authority tick); the editor flow does
  // NOT call PubChem synchronously.
  //
  // Condition: compound text actually changed AND the prior state
  // had a non-null canonical id. A pending fact whose compound text
  // gets edited does NOT trigger the reset — the worker would
  // already pick it up on the next tick. The new text is left
  // un-resolved here (`compound_authority_status = 'pending'`,
  // `compound_authority_at = null`, `compound_authority_error =
  // null`); the worker writes the verified/failed state when it
  // runs.
  // ---------------------------------------------------------------------
  let compoundChanged = false;
  let previousCompound: string | null = null;
  let newCompound: string | null = null;
  if ("compound" in changedFields) {
    compoundChanged = true;
    previousCompound = changedFields.compound.before;
    newCompound = changedFields.compound.after;
  }

  const priorCanonicalId = ((existing as any).compound_canonical_id as
    | string
    | null
    | undefined) ?? null;
  const priorAuthorityStatus =
    ((existing as any).compound_authority_status as string | null | undefined) ??
    null;

  if (compoundChanged && priorCanonicalId) {
    patch.compound_authority_status = "pending";
    patch.compound_authority_at = null;
    patch.compound_authority_error = null;
    // `compound_canonical_id` is intentionally NOT cleared — it is
    // the audit trail anchor.
  }

  const { data, error } = await supabase
    .from("research_bioprospecting_facts")
    .update(patch)
    .eq("id", params.factId)
    .select("*, source:research_sources(*), chunk:research_evidence_chunks(*)")
    .single();

  if (error) throw error;

  // Insert the manual_edit audit row OUTSIDE the patch update so a
  // failure here doesn't roll back the user's entity correction.
  // The row is best-effort; an audit-write failure is logged and
  // surfaced to the caller (which re-throws) but the user-facing
  // fact row is already correct.
  //
  // Spec contract (PR #3 of bioprospecting-compound-authority): the
  // editor flow writes TWO audit rows for compound text changes on
  // a fact that previously had a canonical id:
  //   1. `manual_edit`     — captures the text diff (old/new compound)
  //   2. `status_change`   — captures the authority state transition
  //                          (status flip to `pending`; canonical id
  //                          snapshot is preserved). Reason
  //                          `'edit_reset'` signals the reset was
  //                          driven by an editor's text change, not
  //                          by the worker.
  if (compoundChanged && priorCanonicalId) {
    try {
      const oldAuditValue = {
        compound: previousCompound,
        compound_canonical_id: priorCanonicalId,
        compound_authority_status:
          (priorAuthorityStatus as
            | "pending"
            | "verified"
            | "failed"
            | "skipped"
            | null) ?? "pending",
      };
      const newAuditValue = {
        compound: newCompound,
        compound_canonical_id: priorCanonicalId,
        compound_authority_status: "pending" as const,
      };
      const { error: auditError } = await supabase
        .from("compound_authority_audit")
        .insert({
          fact_id: params.factId,
          event_type: "manual_edit" as const,
          old_value: oldAuditValue,
          new_value: newAuditValue,
          user_id: params.correctedBy ?? null,
          reason: COMPOUND_AUTHORITY_REASONS.compoundTextChanged,
        });
      if (auditError) {
        logger.error(
          { err: auditError, factId: params.factId },
          "compound_authority_edit_audit_insert_failed",
        );
        throw auditError;
      }

      // Second audit row: status_change event type. The
      // `compound_canonical_id` is intentionally kept (as a snapshot)
      // on both old and new values to match the spec's "audit
      // anchor" contract — clearing it would orphan the history. The
      // `compound_authority_status` flips to `pending`; the
      // resolution to `verified`/`failed` happens on the next worker
      // tick, not synchronously here.
      const priorStatus =
        (priorAuthorityStatus as
          | "pending"
          | "verified"
          | "failed"
          | "skipped"
          | null) ?? "pending";
      const { error: statusAuditError } = await supabase
        .from("compound_authority_audit")
        .insert({
          fact_id: params.factId,
          event_type: "status_change" as const,
          old_value: {
            compound_authority_status: priorStatus,
            compound_canonical_id: priorCanonicalId,
          },
          new_value: {
            compound_authority_status: "pending" as const,
            compound_canonical_id: priorCanonicalId,
          },
          user_id: params.correctedBy ?? null,
          reason: "edit_reset",
        });
      if (statusAuditError) {
        logger.error(
          { err: statusAuditError, factId: params.factId },
          "compound_authority_edit_status_audit_insert_failed",
        );
        throw statusAuditError;
      }
    } catch (auditErr) {
      // Best-effort: log the failure but still return the updated
      // fact so the editor sees their correction succeeded. The
      // audit table is a forensic trail — losing one row is
      // recoverable from the fact's metadata.entityCorrectionHistory.
      logger.error(
        { err: auditErr, factId: params.factId },
        "compound_authority_edit_audit_insert_recovered",
      );
    }
  }

  return data as BioprospectingFact;
}

/**
 * Search bioprospecting facts by free-text query plus optional filters.
 *
 * **Important (Phase 3 of bioprospecting-semantic-dedup):** facts that
 * have been merged into a canonical via
 * `research_bioprospecting_fact_edges` are HIDDEN from the result set by
 * default. Set `includeDuplicates: true` on the params to surface them
 * (used by the review dashboard). The filter is applied at the SQL
 * layer so the post-filter row count is what gets ranked and sliced.
 *
 * All other filters (source, trust tier, review status, measurement,
 * condition) behave as before. Ranking, dedup of equal results, and
 * source filtering are untouched.
 */
export async function searchBioprospectingFacts(
  params: BioprospectingFactSearchParams,
): Promise<BioprospectingFact[]> {
  const query = params.query.trim();
  if (!query) return [];
  const limit = params.limit || 20;
  const candidates = buildSearchCandidates(query);
  const facts = new Map<string, BioprospectingFact>();
  const allowedSourceIds = await resolveBioprospectingSourceIds(params);

  // Phase 3 of bioprospecting-semantic-dedup: hide merged siblings by
  // default. PostgREST does NOT support `.not("id", "in", "(SELECT ...)")`
  // — it interprets the SQL subquery string as a UUID literal and fails
  // with PGRST202/22P02. We fetch the merged ids once and filter in JS.
  // The dedup_edges table is small (hundreds of rows in production) so
  // this is cheap. Setting `includeDuplicates: true` skips both the
  // fetch and the filter, returning canonical + merged rows.
  let mergedIds: Set<string> | null = null;
  if (!params.includeDuplicates) {
    const { data: edgeRows, error: edgeError } = await supabase
      .from("research_bioprospecting_fact_edges")
      .select("merged_fact_id");
    if (edgeError) {
      logger.warn(
        { err: edgeError },
        "bioprospecting_search_dedup_edges_load_failed_continuing",
      );
    } else {
      mergedIds = new Set(
        (edgeRows || []).map((r: { merged_fact_id: string }) => r.merged_fact_id),
      );
    }
  }

  const addFacts = (rows: BioprospectingFact[]) => {
    for (const row of rows) {
      // Drop merged siblings in JS so the `selectFacts()` SQL stays
      // simple. No-op when `mergedIds` is null (includeDuplicates=true).
      if (mergedIds && mergedIds.has(row.id)) continue;
      facts.set(row.id, row);
    }
  };

  const selectFacts = () => {
    let request = supabase
      .from("research_bioprospecting_facts")
      .select(
        "*, source:research_sources(*), chunk:research_evidence_chunks(*)",
      );
    request = applyBioprospectingSourceFilter(
      request,
      params,
      allowedSourceIds,
    );
    request = applyBioprospectingReviewFilter(request, params);
    request = applyBioprospectingMeasurementFilters(request, params);
    return request;
  };

  const taxonomyCandidates = buildTaxonomySearchCandidates(query);
  const taxonomyMatches = await findTaxaForSearchCandidates(taxonomyCandidates);

  for (const taxon of taxonomyMatches.species) {
    if (facts.size >= limit) break;
    const { data, error } = await selectFacts()
      .eq("species_taxon_id", taxon.id)
      .limit(limit);
    if (error) {
      logger.warn({ err: error, taxon }, "bioprospecting_species_taxon_failed");
    } else {
      addFacts((data || []) as BioprospectingFact[]);
    }
  }

  for (const taxon of taxonomyMatches.genus) {
    if (facts.size >= limit) break;
    const { data, error } = await selectFacts()
      .eq("genus_taxon_id", taxon.id)
      .limit(limit);
    if (error) {
      logger.warn({ err: error, taxon }, "bioprospecting_genus_taxon_failed");
    } else {
      addFacts((data || []) as BioprospectingFact[]);
    }
  }

  for (const taxon of taxonomyMatches.family) {
    if (facts.size >= limit) break;
    const { data, error } = await selectFacts()
      .eq("family_taxon_id", taxon.id)
      .limit(limit);
    if (error) {
      logger.warn({ err: error, taxon }, "bioprospecting_family_taxon_failed");
    } else {
      addFacts((data || []) as BioprospectingFact[]);
    }
  }

  const tokenCandidates = query
    .split(/\s+/)
    .map((term) => term.replace(/[^\w-]/g, ""))
    .filter((term) => term.length > 3)
    .slice(0, 8);

  for (const candidate of [...candidates, ...tokenCandidates]) {
    if (facts.size >= limit) break;
    // PostgREST rejects .or() chains whose concatenated URL exceeds its
    // header / parser limit (manifests as PGRST100 "failed to parse
    // logic tree" when the candidate is >~200 chars and the chain has
    // 8 ilike clauses). Truncate to 100 chars BEFORE escaping so the
    // longest possible payload is ~8 * (100 + 5) = 840 chars in the
    // URL — well under PostgREST's limit. ilike is substring-match so
    // we still hit long compounds that contain the truncated prefix.
    const truncated = candidate.length > 100 ? candidate.slice(0, 100) : candidate;
    const escaped = `%${escapeIlike(truncated)}%`;
    const { data, error } = await selectFacts()
      .or(
        [
          `species.ilike.${escaped}`,
          `genus.ilike.${escaped}`,
          `family.ilike.${escaped}`,
          `compound.ilike.${escaped}`,
          `bioactivity.ilike.${escaped}`,
          `application_area.ilike.${escaped}`,
          `result_summary.ilike.${escaped}`,
          `quote.ilike.${escaped}`,
        ].join(","),
      )
      .limit(limit);

    if (error) {
      logger.warn(
        { err: error, candidate },
        "bioprospecting_fact_phrase_failed",
      );
    } else {
      addFacts((data || []) as BioprospectingFact[]);
    }
  }

  if (hasBioprospectingMeasurementFilters(params) && facts.size === 0) {
    const { data, error } = await selectFacts().limit(limit);
    if (error) {
      logger.warn(
        { err: error, params },
        "bioprospecting_measurement_filter_failed",
      );
    } else {
      addFacts((data || []) as BioprospectingFact[]);
    }
  }

  return prioritizeReviewedFacts(
    prioritizeCompoundMatches(Array.from(facts.values()), query),
  ).slice(0, limit);
}

async function resolveBioprospectingSourceIds(
  params: BioprospectingFactSearchParams,
): Promise<string[] | null> {
  if (params.sourceId) return [params.sourceId];
  if (!params.sourceTrustTier || params.sourceTrustTier === "all") return null;

  const { data, error } = await supabase
    .from("research_sources")
    .select("id")
    .eq("trust_tier", params.sourceTrustTier);

  if (error) throw error;
  return (data || []).map((row: any) => row.id);
}

function applyBioprospectingSourceFilter(
  request: any,
  params: BioprospectingFactSearchParams,
  allowedSourceIds: string[] | null,
) {
  if (params.sourceId) return request.eq("source_id", params.sourceId);
  if (!allowedSourceIds) return request;
  if (allowedSourceIds.length === 0)
    return request.in("source_id", ["__none__"]);
  return request.in("source_id", allowedSourceIds);
}

function applyBioprospectingMeasurementFilters(
  request: any,
  params: BioprospectingFactSearchParams,
) {
  let next = request;
  if (params.measurementMin != null) {
    next = next.gte("measurement_value", params.measurementMin);
  }
  if (params.measurementMax != null) {
    next = next.lte("measurement_value", params.measurementMax);
  }
  if (params.measurementUnit) {
    next = next.eq("measurement_unit", params.measurementUnit);
  }
  if (params.measurementDirection) {
    next = next.eq("measurement_direction", params.measurementDirection);
  }
  if (params.condition) {
    next = next.ilike("condition", `%${escapeIlike(params.condition)}%`);
  }
  return next;
}

function applyBioprospectingReviewFilter(
  request: any,
  params: BioprospectingFactSearchParams,
) {
  if (params.reviewStatus && params.reviewStatus !== "all") {
    return request.eq("review_status", params.reviewStatus);
  }

  if (params.reviewStatus === "all") {
    return request;
  }

  return request.not("review_status", "in", "(incorrect,quarantined)");
}

function hasBioprospectingMeasurementFilters(
  params: BioprospectingFactSearchParams,
): boolean {
  return Boolean(
    params.measurementMin != null ||
    params.measurementMax != null ||
    params.measurementUnit ||
    params.measurementDirection ||
    params.condition,
  );
}

function prioritizeCompoundMatches(
  facts: BioprospectingFact[],
  query: string,
): BioprospectingFact[] {
  const queryTerms = query
    .toLowerCase()
    .split(/[^a-z0-9-]+/g)
    .filter((term) => term.length >= 4 && !COMPOUND_MATCH_STOP_WORDS.has(term));
  if (queryTerms.length === 0) return facts;

  const compoundMatches = facts.filter((fact) => {
    const compound =
      `${fact.compound || ""} ${fact.compound_class || ""}`.toLowerCase();
    return compound && queryTerms.some((term) => compound.includes(term));
  });

  return compoundMatches.length > 0 ? compoundMatches : facts;
}

function prioritizeReviewedFacts(
  facts: BioprospectingFact[],
): BioprospectingFact[] {
  const reviewRank = (fact: BioprospectingFact) => {
    if (fact.review_status === "verified") return 0;
    if (fact.review_status === "needs_review") return 2;
    return 1;
  };

  return [...facts].sort((left, right) => reviewRank(left) - reviewRank(right));
}

const COMPOUND_MATCH_STOP_WORDS = new Set([
  "show",
  "with",
  "under",
  "over",
  "above",
  "below",
  "than",
  "thermal",
  "stress",
  "increase",
  "increases",
  "increased",
  "decrease",
  "decreases",
  "decreased",
]);

type TaxonomySearchCandidateSet = Record<ResearchTaxonRank, string[]>;

type TaxonomySearchMatch = {
  id: string;
  rank: ResearchTaxonRank;
  canonical_name: string;
  normalized_name: string;
};

function buildTaxonomySearchCandidates(
  query: string,
): TaxonomySearchCandidateSet {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter((token) => token.length > 1);
  const species = new Set<string>();
  const genus = new Set<string>();
  const family = new Set<string>();
  const higherTaxon = new Set<string>();

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const first = tokens[index];
    const second = tokens[index + 1];
    if (first.length >= 4 && second.length >= 3) {
      species.add(normalizeTaxonSearchName(`${first} ${second}`));
      genus.add(normalizeTaxonSearchName(first));
    }
  }

  for (const token of tokens) {
    const normalized = normalizeTaxonSearchName(token);
    if (normalized.length < 4) continue;
    if (/idae$/i.test(token)) {
      family.add(normalized);
      continue;
    }
    if (/^[A-Z][a-zA-Z-]{3,}$/.test(token)) {
      genus.add(normalized);
    } else {
      higherTaxon.add(normalized);
    }
  }

  return {
    species: Array.from(species),
    genus: Array.from(genus),
    family: Array.from(family),
    higher_taxon: Array.from(higherTaxon),
  };
}

async function findTaxaForSearchCandidates(
  candidates: TaxonomySearchCandidateSet,
): Promise<{
  species: TaxonomySearchMatch[];
  genus: TaxonomySearchMatch[];
  family: TaxonomySearchMatch[];
}> {
  const result = {
    species: [] as TaxonomySearchMatch[],
    genus: [] as TaxonomySearchMatch[],
    family: [] as TaxonomySearchMatch[],
  };

  for (const rank of ["species", "genus", "family"] as const) {
    const names = candidates[rank];
    if (names.length === 0) continue;

    const direct = await findTaxaByNormalizedNames(rank, names);
    const alias = await findTaxaByAliases(rank, names);
    const seen = new Map<string, TaxonomySearchMatch>();
    for (const taxon of [...direct, ...alias]) seen.set(taxon.id, taxon);
    result[rank] = Array.from(seen.values());
  }

  return result;
}

async function findTaxaByNormalizedNames(
  rank: ResearchTaxonRank,
  names: string[],
): Promise<TaxonomySearchMatch[]> {
  const { data, error } = await supabase
    .from("research_taxa")
    .select("id, rank, canonical_name, normalized_name")
    .eq("rank", rank)
    .in("normalized_name", names);
  if (error) {
    logger.warn({ err: error, rank, names }, "research_taxa_lookup_failed");
    return [];
  }
  return (data || []) as TaxonomySearchMatch[];
}

async function findTaxaByAliases(
  rank: ResearchTaxonRank,
  names: string[],
): Promise<TaxonomySearchMatch[]> {
  const { data, error } = await supabase
    .from("research_taxon_aliases")
    .select("taxon:research_taxa(id, rank, canonical_name, normalized_name)")
    .in("normalized_alias", names);
  if (error) {
    logger.warn(
      { err: error, rank, names },
      "research_taxa_alias_lookup_failed",
    );
    return [];
  }

  return (data || [])
    .map((row: any) => row.taxon)
    .filter((taxon: TaxonomySearchMatch | null) => taxon?.rank === rank);
}

function normalizeTaxonSearchName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOptionalInteger(value: unknown): number | null {
  const parsed = normalizeOptionalNumber(value);
  return parsed != null ? Math.trunc(parsed) : null;
}

function normalizeMeasurementDirection(value: unknown): string | null {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (
    normalized === "increase" ||
    normalized === "decrease" ||
    normalized === "no_change" ||
    normalized === "mixed"
  ) {
    return normalized;
  }
  return null;
}

export async function listSources(): Promise<ResearchSource[]> {
  const { data, error } = await supabase
    .from("research_sources")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []) as ResearchSource[];
}

export async function getSource(
  sourceId: string,
): Promise<ResearchSource | null> {
  const { data, error } = await supabase
    .from("research_sources")
    .select("*")
    .eq("id", sourceId)
    .maybeSingle();
  if (error) throw error;
  return (data || null) as ResearchSource | null;
}

export async function getSourceClaims(
  sourceId: string,
): Promise<ResearchClaim[]> {
  const { data, error } = await supabase
    .from("research_claims")
    .select("*, source:research_sources(*), chunk:research_evidence_chunks(*)")
    .eq("source_id", sourceId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []) as ResearchClaim[];
}

export async function getSourceEvidenceChunk(
  sourceId: string,
  chunkIndex: number,
): Promise<ResearchEvidenceChunk | null> {
  const { data, error } = await supabase
    .from("research_evidence_chunks")
    .select("*")
    .eq("source_id", sourceId)
    .eq("chunk_index", chunkIndex)
    .maybeSingle();

  if (error) throw error;
  return (data || null) as ResearchEvidenceChunk | null;
}

export async function getClaim(claimId: string): Promise<ResearchClaim | null> {
  const { data, error } = await supabase
    .from("research_claims")
    .select("*, source:research_sources(*), chunk:research_evidence_chunks(*)")
    .eq("id", claimId)
    .maybeSingle();
  if (error) throw error;
  return (data || null) as ResearchClaim | null;
}

export async function searchClaims(params: {
  query: string;
  trustTier?: ResearchTrustTier | "all";
  limit?: number;
}): Promise<ResearchClaim[]> {
  const query = params.query.trim();
  if (!query) return [];
  const limit = params.limit || 12;
  const doi = extractDoi(query);
  const candidates = buildSearchCandidates(query);
  const claimMap = new Map<string, ResearchClaim>();

  const addClaims = (claims: ResearchClaim[]) => {
    for (const claim of claims) claimMap.set(claim.id, claim);
  };

  const selectClaims = () =>
    supabase
      .from("research_claims")
      .select(
        "*, source:research_sources(*), chunk:research_evidence_chunks(*)",
      );

  const applyTrustTier = <T extends ReturnType<typeof selectClaims>>(
    builder: T,
  ): T => {
    if (params.trustTier && params.trustTier !== "all") {
      return builder.eq("trust_tier", params.trustTier) as T;
    }
    return builder;
  };

  if (doi) {
    let sourceBuilder = supabase
      .from("research_sources")
      .select("id")
      .ilike("doi", doi);

    if (params.trustTier && params.trustTier !== "all") {
      sourceBuilder = sourceBuilder.eq("trust_tier", params.trustTier);
    }

    const { data: sources, error: sourceError } = await sourceBuilder.limit(8);
    if (sourceError) {
      logger.warn(
        { err: sourceError, doi },
        "research_source_doi_search_failed",
      );
    }

    const sourceIds = (sources || [])
      .map((source: any) => source.id)
      .filter(Boolean);
    if (sourceIds.length > 0) {
      const { data, error } = await applyTrustTier(selectClaims())
        .in("source_id", sourceIds)
        .limit(limit);
      if (error) throw error;
      addClaims((data || []) as ResearchClaim[]);
    }
  }

  // Build an OR of individual words so the match does not require the
  // full phrase to appear verbatim in the claim. We strip diacritics so
  // "antifungica" matches "antifungal", and we include both the raw
  // and the diacritic-stripped forms so a query without accents still
  // matches claims with accents and vice versa.
  const rawWords = query
    .split(/\s+/)
    .map((term) => term.replace(/[^\w-]/g, ""))
    .filter((term) => term.length > 2)
    .slice(0, 10);
  const strippedWords = rawWords
    .map((w) => stripDiacritics(w))
    .filter((w) => w.length > 2);
  const allTerms = Array.from(new Set([...rawWords, ...strippedWords]));
  const orExpr = allTerms
    .map((w) => w.replace(/'/g, "''"))
    .join(" | ");

  // The english textSearch config in Postgres does not tokenize
  // accented characters ("antifungica" doesn't match "antifungal"), so
  // if the query contains any diacritic we skip textSearch and fall
  // back to per-word ilike (which IS accent-sensitive at the byte
  // level but our search loop below uses both raw + stripped forms).
  const queryHasDiacritics = /[áéíóúàèìòùäëïöüâêîôûñç]/i.test(query);

  let builder = supabase
    .from("research_claims")
    .select("*, source:research_sources(*), chunk:research_evidence_chunks(*)")
    .limit(limit);

  if (params.trustTier && params.trustTier !== "all") {
    builder = builder.eq("trust_tier", params.trustTier);
  }

  if (orExpr) {
    // Build an OR-of-ilikes for each word (with its diacritic-stripped
    // variant) so the search finds claims containing any of the query
    // words regardless of accent marks.
    const orClauses = allTerms
      .map((w) => `claim.ilike.%${escapeIlike(w)}%`)
      .join(",");
    builder = builder.or(orClauses);
  } else {
    builder = builder.ilike("claim", `%${escapeIlike(query)}%`);
  }

  const { data, error } = await builder;
  if (error) {
    logger.warn({ err: error, query }, "research_claim_search_failed");
    const fallback = await supabase
      .from("research_claims")
      .select(
        "*, source:research_sources(*), chunk:research_evidence_chunks(*)",
      )
      .ilike("claim", `%${query}%`)
      .limit(limit);
    if (fallback.error) throw fallback.error;
    addClaims((fallback.data || []) as ResearchClaim[]);
  } else {
    addClaims((data || []) as ResearchClaim[]);
  }

  // Try each candidate phrase first, then fall back to individual
  // diacritic-stripped words so accent/spelling variants still match
  // claims whose text uses the canonical (non-accented) form.
  const triedSearches = new Set<string>();
  const searchTerms: string[] = [];
  for (const candidate of candidates) {
    searchTerms.push(candidate);
    const stripped = stripDiacritics(candidate);
    if (stripped !== candidate) searchTerms.push(stripped);
  }
  for (const w of allTerms) {
    if (w.length >= 3) {
      searchTerms.push(w);
      const stripped = stripDiacritics(w);
      if (stripped !== w) searchTerms.push(stripped);
    }
  }

  for (const term of searchTerms) {
    if (claimMap.size >= limit) break;
    if (triedSearches.has(term)) continue;
    triedSearches.add(term);

    const claimSearch = await applyTrustTier(selectClaims())
      .ilike("claim", `%${escapeIlike(term)}%`)
      .limit(limit);

    if (claimSearch.error) {
      logger.warn(
        { err: claimSearch.error, term },
        "research_claim_phrase_search_failed",
      );
    } else {
      addClaims((claimSearch.data || []) as ResearchClaim[]);
    }

    if (claimMap.size >= limit) break;

    let chunkBuilder = supabase
      .from("research_evidence_chunks")
      .select("id, source_id")
      .ilike("content", `%${escapeIlike(term)}%`)
      .limit(limit);

    const { data: chunks, error: chunkError } = await chunkBuilder;
    if (chunkError) {
      logger.warn(
        { err: chunkError, term },
        "research_evidence_chunk_phrase_search_failed",
      );
      continue;
    }

    const chunkIds = (chunks || [])
      .map((chunk: any) => chunk.id)
      .filter(Boolean);
    if (chunkIds.length === 0) continue;

    const chunkClaims = await applyTrustTier(selectClaims())
      .in("chunk_id", chunkIds)
      .limit(limit);

    if (chunkClaims.error) throw chunkClaims.error;
    addClaims((chunkClaims.data || []) as ResearchClaim[]);
  }

  return hydrateMissingClaimChunks(
    Array.from(claimMap.values()).slice(0, limit),
  );
}

async function hydrateMissingClaimChunks(
  claims: ResearchClaim[],
): Promise<ResearchClaim[]> {
  const missing = claims.filter((claim) => claim.source_id && !claim.chunk);
  if (missing.length === 0) return claims;

  const bySource = new Map<string, ResearchClaim[]>();
  for (const claim of missing) {
    const sourceId = claim.source_id;
    if (!sourceId) continue;
    bySource.set(sourceId, [...(bySource.get(sourceId) || []), claim]);
  }

  for (const [sourceId, sourceClaims] of bySource.entries()) {
    const { data: chunks, error } = await supabase
      .from("research_evidence_chunks")
      .select("*")
      .eq("source_id", sourceId)
      .order("chunk_index", { ascending: true })
      .limit(180);

    if (error) {
      logger.warn({ err: error, sourceId }, "research_chunk_hydration_failed");
      continue;
    }

    const evidenceChunks = (chunks || []) as ResearchEvidenceChunk[];
    if (evidenceChunks.length === 0) continue;

    for (const claim of sourceClaims) {
      const bestChunk = findBestChunkForClaim(claim.claim, evidenceChunks);
      if (!bestChunk) continue;
      claim.chunk = bestChunk;
      claim.chunk_id = bestChunk.id;
    }
  }

  return claims;
}

// Strip Spanish/accented diacritics to enable accent-insensitive matching
// against claim text. Maps accented Latin letters to their ASCII base.
const DIACRITIC_MAP: Record<string, string> = {
  á: "a", é: "e", í: "i", ó: "o", ú: "u",
  à: "a", è: "e", ì: "i", ò: "o", ù: "u",
  ä: "a", ë: "e", ï: "i", ö: "o", ü: "u",
  â: "a", ê: "e", î: "i", ô: "o", û: "u",
  ñ: "n", ç: "c",
};

function stripDiacritics(s: string): string {
  return s.replace(/[áéíóúàèìòùäëïöüâêîôûñç]/g, (m) => DIACRITIC_MAP[m] || m);
}

function buildSearchCandidates(query: string): string[] {
  const candidates = new Set<string>();
  const cleaned = query.replace(/\s+/g, " ").trim();
  // Add a diacritic-stripped variant so accent-insensitive searches
  // still match (e.g. "antifungica" finds "antifungal").
  const stripped = stripDiacritics(cleaned);

  const quoted = cleaned.match(/["“”']([^"“”']{8,})["“”']/g) || [];
  for (const match of quoted) {
    candidates.add(match.replace(/^["“”']|["“”']$/g, "").trim());
  }

  for (const part of cleaned.split(/[:：]/g)) {
    const value = part.trim();
    if (value.length >= 12) candidates.add(value);
  }

  const afterEsto = cleaned.match(/\besto\s*:?\s*(.{12,})$/i);
  if (afterEsto?.[1]) candidates.add(afterEsto[1].trim());

  const withoutDoiPrefix = cleaned.replace(/\bdoi\s*:?\s*/i, "").trim();
  if (withoutDoiPrefix.length >= 12 && withoutDoiPrefix.length <= 260) {
    candidates.add(withoutDoiPrefix);
  }

  if (cleaned.length >= 12 && cleaned.length <= 260) candidates.add(cleaned);

  // Add the diacritic-stripped whole query as a candidate so
  // "antifungica" can match claims containing "antifungal".
  if (stripped !== cleaned && stripped.length >= 12 && stripped.length <= 260) {
    candidates.add(stripped);
  }

  return Array.from(candidates)
    .map((candidate) => candidate.replace(/\s+/g, " ").trim())
    .filter((candidate) => candidate.length >= 12)
    .sort((a, b) => b.length - a.length)
    .slice(0, 5);
}

function escapeIlike(value: string): string {
  return value.replace(/[%_\\]/g, (match) => `\\${match}`);
}

function findBestChunkForClaim(
  claim: string,
  chunks: ResearchEvidenceChunk[],
): ResearchEvidenceChunk | null {
  const claimWords = importantWords(claim);
  if (claimWords.length === 0) return null;

  let best: { chunk: ResearchEvidenceChunk; score: number } | null = null;
  for (const chunk of chunks) {
    const content = chunk.content.toLowerCase();
    const score = claimWords.reduce(
      (total, word) => total + (content.includes(word) ? 1 : 0),
      0,
    );

    if (!best || score > best.score) {
      best = { chunk, score };
    }
  }

  return best && best.score >= Math.min(4, claimWords.length)
    ? best.chunk
    : null;
}

function importantWords(text: string): string[] {
  const stopWords = new Set([
    "about",
    "according",
    "after",
    "also",
    "among",
    "both",
    "from",
    "have",
    "into",
    "that",
    "their",
    "these",
    "this",
    "through",
    "with",
    "without",
  ]);

  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter((word) => word.length >= 5 && !stopWords.has(word)),
    ),
  ).slice(0, 24);
}

/**
 * Fetch all bioprospecting facts for a given source, with source and chunk relations.
 */
export async function getBioprospectingFactsForSource(
  sourceId: string,
): Promise<BioprospectingFact[]> {
  const { data, error } = await supabase
    .from("research_bioprospecting_facts")
    .select("*, source:research_sources(*), chunk:research_evidence_chunks(*)")
    .eq("source_id", sourceId);

  if (error) throw error;
  return (data || []) as BioprospectingFact[];
}

/**
 * Fetch a single bioprospecting fact by id, with source, chunk,
 * evidence_table, evidence_figure, and compound_canonical relations
 * embedded.
 *
 * The provenance-viewer endpoint (PR #2 of
 * `bioprospecting-pdf-provenance-viewer`) uses this loader to
 * resolve `GET /api/research-brain/facts/:factId/provenance` in a
 * single round-trip. The relation aliases match the FK column
 * names — Supabase's embedded-resource syntax is
 * `alias:table!fk_column(*)` and the column names we have on
 * `research_bioprospecting_facts` are exactly `evidence_table_id`
 * and `evidence_figure_id`. PR #3 of
 * `bioprospecting-compound-authority` adds the
 * `compound_canonical:research_compounds!compound_canonical_id(*)`
 * embed so the lightbox can show InChIKey + PubChem CID on
 * resolved facts.
 */
export async function getBioprospectingFact(
  factId: string,
): Promise<BioprospectingFact | null> {
  if (!factId) return null;
  const { data, error } = await supabase
    .from("research_bioprospecting_facts")
    .select(
      "*, source:research_sources(*), chunk:research_evidence_chunks(*), evidence_table:research_evidence_tables!evidence_table_id(*), evidence_figure:research_evidence_figures!evidence_figure_id(*), compound_canonical:research_compounds!compound_canonical_id(*)",
    )
    .eq("id", factId)
    .maybeSingle();
  if (error) throw error;
  return (data || null) as BioprospectingFact | null;
}
