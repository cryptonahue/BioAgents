export type ResearchSourceKind =
  | "paper"
  | "dataset"
  | "external_result"
  | "artifact";

export type ResearchTrustTier = "internal" | "external";

export type ResearchClaimStatus =
  | "supported"
  | "partial"
  | "contradicted"
  | "hypothesis"
  | "open_question";

export type ResearchSource = {
  id: string;
  source_kind: ResearchSourceKind;
  trust_tier: ResearchTrustTier;
  source_scope: string;
  title: string;
  doi?: string | null;
  url?: string | null;
  file_path?: string | null;
  content_hash?: string | null;
  file_size?: number | null;
  last_modified_at?: string | null;
  extraction_status: string;
  extraction_error?: string | null;
  bioprospecting_status?: string;
  bioprospecting_error?: string | null;
  bioprospecting_fact_count?: number;
  bioprospecting_extracted_at?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

export type ResearchEvidenceChunk = {
  id: string;
  source_id: string;
  document_id?: string | null;
  content: string;
  section?: string | null;
  page?: number | null;
  chunk_index?: number | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

export type ResearchClaim = {
  id: string;
  claim: string;
  claim_type: string;
  status: ResearchClaimStatus;
  confidence: string;
  source_id?: string | null;
  chunk_id?: string | null;
  doi?: string | null;
  trust_tier: ResearchTrustTier;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  source?: ResearchSource;
  chunk?: ResearchEvidenceChunk;
};

export type EvidencePackClaim = {
  id: string;
  claim: string;
  claimType: string;
  status: ResearchClaimStatus;
  confidence: string;
  trustTier: ResearchTrustTier;
  sourceId?: string | null;
  sourceTitle?: string | null;
  doi?: string | null;
  url?: string | null;
  doiUrl?: string | null;
  paperUrl?: string | null;
  evidenceUrl?: string | null;
  chunkId?: string | null;
  chunkIndex?: number | null;
  section?: string | null;
  page?: number | null;
  snippet?: string;
};

export type EvidencePackEntityCorrection = {
  correctedAt?: string | null;
  correctedBy?: string | null;
  fields: Record<string, { before?: string | null; after?: string | null }>;
};

export type EvidencePackBioprospectingFact = {
  id: string;
  status: ResearchClaimStatus;
  confidence: string;
  trustTier: ResearchTrustTier;
  reviewStatus:
    | "unreviewed"
    | "verified"
    | "needs_review"
    | "incorrect"
    | "quarantined";
  reviewNote?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  lastEntityCorrection?: EvidencePackEntityCorrection | null;
  entityCorrectionHistory?: EvidencePackEntityCorrection[];
  matchType:
    | "direct_species"
    | "same_genus"
    | "genus_level"
    | "same_family"
    | "compound_or_activity"
    | "ecological_analogy"
    | "keyword_match";
  evidenceStrength: "direct" | "indirect" | "hypothesis" | "unknown";
  evidenceLabel: string;
  queryMatches: string[];
  speciesTaxonId?: string | null;
  genusTaxonId?: string | null;
  familyTaxonId?: string | null;
  sourceId?: string | null;
  sourceTitle?: string | null;
  doi?: string | null;
  url?: string | null;
  doiUrl?: string | null;
  paperUrl?: string | null;
  evidenceUrl?: string | null;
  chunkId?: string | null;
  chunkIndex?: number | null;
  page?: number | null;
  species?: string | null;
  genus?: string | null;
  family?: string | null;
  higherTaxon?: string | null;
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
  relationType: string;
  quote?: string | null;
  snippet?: string;
};

export type EvidencePackSource = {
  id: string;
  title: string;
  trustTier: ResearchTrustTier;
  kind: ResearchSourceKind;
  doi?: string | null;
  url?: string | null;
  doiUrl?: string | null;
  paperUrl?: string | null;
};

export type BioprospectingQuestionType =
  | "species_exploration"
  | "molecule_exploration"
  | "activity_search"
  | "comparison"
  | "application_search"
  | "evidence_audit"
  | "quantitative_search"
  | "reef_context"
  | "unknown";

export type EvidencePackQueryPlan = {
  questionType: BioprospectingQuestionType;
  intentLabel: string;
  strategy: string;
  answerSections: string[];
  shouldUseExternalLiterature: boolean;
  cautions: string[];
};

export type EvidencePack = {
  question: string;
  queryPlan: EvidencePackQueryPlan;
  bioprospectingFacts: EvidencePackBioprospectingFact[];
  supportedClaims: EvidencePackClaim[];
  partialClaims: EvidencePackClaim[];
  contradictions: EvidencePackClaim[];
  openQuestions: EvidencePackClaim[];
  sources: EvidencePackSource[];
  contradictionWarnings: EvidencePackContradiction[];
};

export type ExtractedClaim = {
  claim: string;
  claimType?: string;
  status?: ResearchClaimStatus;
  confidence?: string;
  chunkIndex?: number;
  entities?: string[];
};

export type BioprospectingFact = {
  id: string;
  source_id?: string | null;
  chunk_id?: string | null;
  claim_id?: string | null;
  species_taxon_id?: string | null;
  genus_taxon_id?: string | null;
  family_taxon_id?: string | null;
  taxonomy_status?: "pending" | "normalized" | "skipped" | "failed";
  taxonomy_normalized_at?: string | null;
  taxonomy_error?: string | null;
  species?: string | null;
  genus?: string | null;
  family?: string | null;
  higher_taxon?: string | null;
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
  result_summary?: string | null;
  measurement_value?: number | string | null;
  measurement_unit?: string | null;
  measurement_direction?: string | null;
  measurement_min?: number | string | null;
  measurement_max?: number | string | null;
  timepoint?: string | null;
  condition?: string | null;
  p_value?: number | string | null;
  sample_size?: number | null;
  statistical_test?: string | null;
  evidence_type?: string | null;
  relation_type: string;
  status: ResearchClaimStatus;
  confidence: string;
  review_status?:
    | "unreviewed"
    | "verified"
    | "needs_review"
    | "incorrect"
    | "quarantined";
  review_note?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  quote?: string | null;
  doi?: string | null;
  page?: number | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  /**
   * Database-generated identity key (5-tuple
   * species|compound|bioactivity|organism_part|geography, normalized).
   * Populated by `buildIdentityKey`/the `identity_key` GENERATED column.
   * Read-only; the source of truth is the database.
   */
  identity_key?: string | null;
  /**
   * Set on non-canonical rows: the id of the canonical fact that this
   * row was merged into. `null`/undefined for canonical and standalone
   * facts. Inverse of `research_bioprospecting_fact_edges.merged_fact_id`.
   */
  merged_into_fact_id?: string | null;
  /**
   * FK to the row in `research_evidence_tables` that this fact was
   * extracted from (when the LLM grounded the fact in a specific
   * table row). `null` for prose-grounded facts and for facts whose
   * source PDF has not been table-extracted yet. The
   * `/api/research-brain/facts/:id/provenance` endpoint (PR #2)
   * uses this column as the first-precedence provenance link.
   */
  evidence_table_id?: string | null;
  /**
   * FK to the row in `research_evidence_figures` that this fact was
   * extracted from. `null` for table/prose-grounded facts. The
   * provenance endpoint treats this as the second-precedence link
   * (after `evidence_table_id`).
   */
  evidence_figure_id?: string | null;
  /**
   * FK to the canonical row in `research_compounds` that this fact's
   * `compound` text was resolved to. `null` for unknown / extract /
   * not-yet-resolved facts. The raw `compound` text is never
   * overwritten; this column is a parallel signal for UI display and
   * admin views. Set by `attachCompoundAuthority` (extractor sync
   * path) or `attachCanonicalToFact` (worker + admin paths).
   */
  compound_canonical_id?: string | null;
  /**
   * Lifecycle marker for the fact's compound-authority state.
   * `'pending'` is the default for fresh inserts; `'verified'` is set
   * on alias-table or PubChem hit; `'skipped'` is set when the
   * `looksLikeExtract` predicate matches the raw `compound` text;
   * `'failed'` is reserved for the backfill worker's exhaustion case
   * (5 PubChem 404s in 24h). Source: `compound_authority_audit`.
   */
  compound_authority_status?: CompoundStatus;
  /**
   * Server timestamp of the last authority action on this fact.
   * `null` for facts that have never been resolved (and for
   * `'pending'` fresh inserts). The backfill worker's 24h re-check
   * window reads this column to decide whether a fact is eligible
   * for another attempt.
   */
  compound_authority_at?: string | null;
  /**
   * Last error message for the authority attempt (e.g. PubChem 404
   * excerpt). `null` on success and on `'skipped'`.
   */
  compound_authority_error?: string | null;
  /**
   * Operational counter incremented on each backfill miss. Survives
   * worker restart. Drives the 5-retry-then-`failed` policy in
   * `compoundAuthority.normalizeBioprospectingCompounds` (PR #2).
   * 5th column added in the same migration as the 4 spec'd ones.
   */
  compound_authority_attempts?: number;
  source?: ResearchSource;
  chunk?: ResearchEvidenceChunk;
};

/**
 * Lineage edge between a canonical fact and a fact that was collapsed
 * into it by deduplication. Mirrors the schema of
 * `public.research_bioprospecting_fact_edges`.
 */
export type BioprospectingFactEdge = {
  canonical_fact_id: string;
  merged_fact_id: string;
  match_rule: "identity_key" | "embedding";
  merged_at: string;
};

export type ResearchTaxonRank = "species" | "genus" | "family" | "higher_taxon";

export type ResearchTaxon = {
  id: string;
  rank: ResearchTaxonRank;
  canonical_name: string;
  normalized_name: string;
  parent_id?: string | null;
  status: string;
  external_ids?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

export type ResearchTaxonAlias = {
  id: string;
  taxon_id: string;
  alias: string;
  normalized_alias: string;
  source: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

/**
 * Lifecycle marker for a fact's compound-authority state. Mirrors
 * the `compound_authority_status` CHECK constraint on
 * `research_bioprospecting_facts`. Used by
 * `src/services/researchBrain/compoundAuthority.ts` and surfaced in
 * audit JSONB payloads.
 */
export type CompoundStatus = "pending" | "verified" | "failed" | "skipped";

/**
 * A canonical chemistry identity. One row per molecule the Research
 * Brain has resolved. The `normalized_name` is the dedup key; the
 * `status` records provenance (`'curated'`, `'pubchem'`, `'manual'`,
 * `'local'`, `'chebi'`).
 */
export type ResearchCompound = {
  id: string;
  canonical_name: string;
  normalized_name: string;
  inchi_key: string | null;
  pubchem_cid: number | null;
  chebi_id: number | null;
  molecular_formula: string | null;
  iupac_name: string | null;
  compound_kind: "small_molecule" | "peptide" | "protein" | "lipid" | "other";
  status: "local" | "pubchem" | "chebi" | "manual" | "curated";
  external_ids: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

/**
 * A surface form (synonym, trade name, IUPAC name, reviewer spelling
 * variant) that resolves to a canonical compound. The fast lookup
 * path that avoids a PubChem round-trip on every extraction.
 */
export type ResearchCompoundAlias = {
  id: string;
  compound_id: string;
  alias: string;
  normalized_alias: string;
  source: "local_extraction" | "pubchem" | "chebi" | "manual" | "curated";
  confidence: "high" | "medium" | "low";
  metadata: Record<string, unknown>;
  created_at: string;
};

/**
 * Structured JSONB-diff audit row from `compound_authority_audit`.
 * Read-rare (admin only), insert-heavy (every status change and
 * manual edit). The table is partitioned monthly by `created_at`.
 *
 * `event_type` discriminates the kind of change:
 *   - `'status_change'`: a fact transitioned (e.g. pending -> verified)
 *   - `'manual_edit'`:    a human edited `fact.compound` text
 *   - `'manual_alias_add'`: an admin added a new alias
 *
 * `old_value` / `new_value` shapes vary by `event_type`; see
 * `openspec/changes/bioprospecting-compound-authority/specs/...`
 * for the exact contract.
 */
export type CompoundAuthorityAuditEvent = {
  id: string;
  fact_id: string;
  event_type: "status_change" | "manual_edit" | "manual_alias_add";
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  user_id: string | null;
  reason: string | null;
  created_at: string;
};

export type ExtractedBioprospectingFact = {
  species?: string;
  genus?: string;
  family?: string;
  higherTaxon?: string;
  organismGroup?: string;
  geography?: string;
  ecosystem?: string;
  organismPart?: string;
  compound?: string;
  compoundClass?: string;
  moleculeType?: string;
  bioactivity?: string;
  applicationArea?: string;
  assayModel?: string;
  resultSummary?: string;
  measurementValue?: number;
  measurementUnit?: string;
  measurementDirection?: string;
  measurementMin?: number;
  measurementMax?: number;
  timepoint?: string;
  condition?: string;
  pValue?: number;
  sampleSize?: number;
  statisticalTest?: string;
  evidenceType?: string;
  relationType?: string;
  status?: ResearchClaimStatus;
  confidence?: string;
  quote?: string;
  chunkIndex?: number;
  entities?: string[];
  /**
   * Optional reference to a specific cell in a specific table
   * extracted from the source PDF. Set by the LLM when it grounds a
   * fact in tabular data; resolved to a `evidence_table_id` (UUID)
   * in `replaceBioprospectingFactsForSource` and threaded into the
   * persisted row.
   *
   * Coordinates:
   *   - `page`: 1-indexed PDF page
   *   - `tableIndex`: 0-based ordinal of the table on the page
   *   - `rowIndex`: 0-based ordinal of the row in the table body
   *     (header rows do not count; row 0 is the first data row)
   *
   * The `page` + `tableIndex` pair is sufficient to look up the
   * `evidence_table_id`; `rowIndex` is recorded for future
   * cell-level provenance but not required for the FK link today.
   */
  sourceTableRef?: {
    page: number;
    tableIndex: number;
    rowIndex?: number;
  };
  /**
   * Compound authority state, stamped by `attachCompoundAuthority`
   * in the extractor before the fact is handed to
   * `replaceBioprospectingFactsForSource`. The raw `compound` text
   * is NEVER overwritten; these fields are a parallel signal.
   *
   * On a fresh extraction the resolver sets:
   *   - alias-table hit  -> status='verified', canonicalId=<id>, at=NOW()
   *   - extract value    -> status='skipped', canonicalId=null, error='extract_or_mixture'
   *   - miss             -> status='pending', canonicalId=null, error=null
   *
   * Calling `attachCompoundAuthority` twice on the same fact is a
   * no-op on a previously-stamped `'verified'` state (the second
   * call does not clobber it with a `'pending'` re-resolution).
   */
  compound_canonical_id?: string | null;
  compound_authority_status?: CompoundStatus;
  compound_authority_at?: string | null;
  compound_authority_error?: string | null;
  compound_authority_attempts?: number;
};

export type ResearchBioprospectingContradiction = {
  id: string;
  fact_a_id: string;
  fact_b_id: string;
  conflict_type: string;
  severity: string;
  explanation: string | null;
  status: string;
  detected_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  metadata: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// discovery-persistence (v1): relational row shapes for
// research_discoveries + research_discovery_evidence.
//
// These types back the write-through path in the discovery agent and the
// future read endpoint (PR #2). v1 does NOT change the in-memory Discovery
// type — that stays in src/types/core.ts and is the source of truth for
// planning / reply / paper generation.
// ---------------------------------------------------------------------------

/**
 * Lifecycle marker for a discovery's re-evaluation status. Mirrors
 * the `reeval_status` CHECK constraint on `research_discoveries`.
 * v1 always writes `'none'` (the column default). PR #2 (re-evaluation)
 * will transition rows through the other values.
 */
export type ResearchDiscoveryReevalStatus =
  | "none"
  | "pending"
  | "clean"
  | "extended"
  | "contradicted";

/**
 * One row of `research_discoveries`. The column names match the SQL
 * table exactly (snake_case) so the Supabase `.from("research_discoveries")
 * .select("*")` payload can be cast directly to this type.
 *
 * `evidence` is the in-process join from `getDiscoveriesForConversation`
 * (PR #2) — the v1 read path returns `[]` for this field per the spec.
 */
export type ResearchDiscovery = {
  id: string;
  discovery_group_id: string;
  conversation_id: string;
  message_id: string | null;
  supersedes_discovery_id: string | null;
  is_current: boolean;
  superseded_at: string | null;
  title: string;
  claim: string;
  summary: string;
  novelty: string | null;
  artifacts: AnalysisArtifact[];
  discovery_key: string;
  reeval_status: ResearchDiscoveryReevalStatus;
  reeval_notes: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * One row of `research_discovery_evidence`. `task_id` references a
 * `PlanTask.id` (TEXT in JSONB, no FK). `source_url` is forward-compat
 * (PR #2 will populate it on re-eval). `evidence_archived` is a
 * denormalized badge — the v1 read path always returns `false` per
 * spec limitation §8.2; PR #2 will compute the real value from the
 * plan tree.
 */
export type ResearchDiscoveryEvidence = {
  id: string;
  discovery_id: string;
  task_id: string;
  job_id: string | null;
  explanation: string;
  source_url: string | null;
  evidence_archived: boolean;
  created_at: string;
};

export type EvidencePackContradiction = {
  id: string;
  contradictionType: string;
  sourceA: {
    factId: string;
    claim: string;
    sourceTitle: string | null;
    doi: string | null;
    value: string;
    provenance: string;
  };
  sourceB: {
    factId: string;
    claim: string;
    sourceTitle: string | null;
    doi: string | null;
    value: string;
    provenance: string;
  };
  conflictSummary: string;
  severity: string;
  explanation: string | null;
  status: "open" | "resolved" | "dismissed";
};

// ---------------------------------------------------------------------------
// Bioprospecting Review UI (admin-only surface)
//
// These types back the four new admin-only routes on
// `src/routes/research-brain.ts`:
//   - GET    /api/research-brain/contradictions
//   - GET    /api/research-brain/contradictions/stats
//   - GET    /api/research-brain/dedup/events
//   - POST   /api/research-brain/dedup/:factId/unmerge
//
// See openspec/changes/bioprospecting-review-ui/specs/.../spec.md for
// the full contract.
// ---------------------------------------------------------------------------

/**
 * One row of the activity snapshot returned by
 * `GET /api/research-brain/contradictions/stats`. Each window
 * (`today`, `last7d`) carries six non-negative integer metrics:
 *
 *   - `found`     COUNT(contradictions WHERE detected_at >= window)
 *   - `resolved`  COUNT(contradictions WHERE status='resolved'
 *                 AND resolved_at >= window)
 *   - `dismissed` COUNT(contradictions WHERE status='dismissed'
 *                 AND resolved_at >= window)
 *   - `pending`   max(0, found - resolved - dismissed) — clamped
 *                 server-side to defend against clock-skew drift
 *   - `merges`    COUNT(fact_edges WHERE merged_at >= window
 *                 AND is_active = true)
 *   - `unmerges`  COUNT(fact_edges WHERE unmerged_at >= window)
 */
export type StatsWindow = {
  found: number;
  resolved: number;
  dismissed: number;
  pending: number;
  merges: number;
  unmerges: number;
};

/**
 * Stats response shape. Two windows, six metrics each (12 numbers).
 * `pending` is non-negative by contract; the route clamps to 0.
 */
export type StatsResponse = {
  today: StatsWindow;
  last7d: StatsWindow;
};

/**
 * One row of the dedup events feed
 * (`GET /api/research-brain/dedup/events`).
 *
 * Each event is a row from `research_bioprospecting_fact_edges`
 * left-joined to the most recent `research_bioprospecting_dedup_audit`
 * row for that `fact_id` (NULL when no unmerge audit exists).
 *
 * - `eventId`     — composite (canonical_fact_id|merged_fact_id)
 * - `isActive`    — mirrors the soft-delete flag on the edge row
 * - `reasonCode`  — the admin-supplied category from the unmerge dialog
 *                   (NULL on edges that have never been unmerged)
 * - `reasonDetail`— the free-text detail from the unmerge dialog
 *                   (NULL on edges that have never been unmerged)
 */
export type RecentDedupEvent = {
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
};

/**
 * The four reason categories the unmerge dialog dropdown accepts.
 * The CHECK constraint on `research_bioprospecting_dedup_audit.reason_category`
 * enforces this set at the database layer; the route and the
 * `unmergeFact` service helper re-validate before issuing the INSERT.
 */
export type ReasonCategory =
  | "false_positive"
  | "different_compound"
  | "measurement_error"
  | "other";

/**
 * The four windows the dedup events feed accepts. `'all'` omits the
 * time filter entirely; the other three map to `NOW() - INTERVAL '...'`.
 */
export type DedupEventWindow = "24h" | "7d" | "30d" | "all";

/**
 * Request body shape for
 * `POST /api/research-brain/dedup/:factId/unmerge`.
 *
 * `reasonCode` is required and validated against the
 * `ReasonCategory` enum; `reasonDetail` is optional free text.
 */
export type UnmergeRequest = {
  reasonCode: ReasonCategory;
  reasonDetail?: string | null;
};

/**
 * Response body shape for
 * `POST /api/research-brain/dedup/:factId/unmerge`.
 *
 * Both `edge` and `audit` reflect the state AFTER the soft-delete and
 * the audit insert (same transaction).
 */
export type UnmergeResponse = {
  edge: {
    canonicalFactId: string;
    mergedFactId: string;
    matchRule: "identity_key" | "embedding";
    mergedAt: string;
    isActive: boolean;
    unmergedAt: string;
    unmergedBy: string;
  };
  audit: {
    id: string;
    factId: string;
    eventType: "unmerge";
    oldCanonicalId: string | null;
    newCanonicalId: string | null;
    userId: string | null;
    reason: string | null;
    reasonCategory: ReasonCategory;
    createdAt: string;
  };
};
