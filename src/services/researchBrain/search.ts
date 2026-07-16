import logger from "../../utils/logger";
import { getServiceClient } from "../../db/client";
import type {
  BioprospectingFactSearchParams,
  BioprospectingReviewStatus,
} from "./db";
import { searchBioprospectingFacts, searchClaims } from "./db";
import { searchBioprospectingContradictions } from "./contradictionDb";
import { renderPassageBlock } from "./citation/citationPolicy";
import { detectPaperScope } from "./paperScope";
import type {
  BioprospectingFact,
  EvidencePack,
  EvidencePackBioprospectingFact,
  EvidencePackClaim,
  EvidencePackContradiction,
  EvidencePackQueryPlan,
  EvidencePackSource,
  ResearchBioprospectingContradiction,
  ResearchClaim,
  ResearchTrustTier,
} from "./types";

type BioprospectingQueryProfile = {
  normalizedQuery: string;
  speciesCandidates: string[];
  genusCandidates: string[];
};

function claimToEvidencePackClaim(claim: ResearchClaim): EvidencePackClaim {
  const doi = claim.doi || claim.source?.doi || null;
  const paperUrl = claim.source?.title
    ? `/library/${encodeDocId(claim.source.title)}`
    : null;
  const evidenceUrl =
    paperUrl && claim.chunk?.chunk_index != null
      ? `${paperUrl}?fragment=${claim.chunk.chunk_index}`
      : paperUrl;
  return {
    id: claim.id,
    claim: claim.claim,
    claimType: claim.claim_type,
    status: claim.status,
    confidence: claim.confidence,
    trustTier: claim.trust_tier,
    sourceId: claim.source_id,
    sourceTitle: claim.source?.title || null,
    doi,
    url: claim.source?.url || null,
    doiUrl: doi ? `https://doi.org/${doi}` : null,
    paperUrl,
    evidenceUrl,
    chunkId: claim.chunk_id,
    chunkIndex: claim.chunk?.chunk_index,
    section: claim.chunk?.section || null,
    page: claim.chunk?.page || null,
    snippet: claim.chunk?.content
      ? compactSnippet(claim.chunk.content, 700)
      : undefined,
  };
}

function factToEvidencePackFact(
  fact: BioprospectingFact,
  queryProfile: BioprospectingQueryProfile,
): EvidencePackBioprospectingFact {
  const doi = fact.doi || fact.source?.doi || null;
  const paperUrl = fact.source?.title
    ? `/library/${encodeDocId(fact.source.title)}`
    : null;
  const chunkIndex =
    fact.chunk?.chunk_index ?? readNumberMetadata(fact, "chunkIndex");
  const evidenceUrl =
    paperUrl && chunkIndex != null
      ? `${paperUrl}?fragment=${chunkIndex}`
      : paperUrl;
  const classification = classifyBioprospectingFact(fact, queryProfile);

  return {
    id: fact.id,
    status: fact.status,
    confidence: fact.confidence,
    trustTier: fact.source?.trust_tier || "internal",
    reviewStatus: fact.review_status || "unreviewed",
    reviewNote: fact.review_note,
    reviewedBy: fact.reviewed_by,
    reviewedAt: fact.reviewed_at,
    lastEntityCorrection: readEntityCorrectionMetadata(
      fact,
      "lastEntityCorrection",
    ),
    entityCorrectionHistory: readEntityCorrectionHistory(fact),
    ...classification,
    speciesTaxonId: fact.species_taxon_id,
    genusTaxonId: fact.genus_taxon_id,
    familyTaxonId: fact.family_taxon_id,
    sourceId: fact.source_id,
    sourceTitle: fact.source?.title || stringMetadata(fact, "sourceTitle"),
    doi,
    url: fact.source?.url || null,
    doiUrl: doi ? `https://doi.org/${doi}` : null,
    paperUrl,
    evidenceUrl,
    chunkId: fact.chunk_id,
    chunkIndex,
    page: fact.page ?? fact.chunk?.page ?? null,
    species: fact.species,
    genus: fact.genus,
    family: fact.family,
    higherTaxon: fact.higher_taxon,
    organismGroup: fact.organism_group,
    geography: fact.geography,
    ecosystem: fact.ecosystem,
    organismPart: fact.organism_part,
    compound: fact.compound,
    compoundClass: fact.compound_class,
    moleculeType: fact.molecule_type,
    bioactivity: fact.bioactivity,
    applicationArea: fact.application_area,
    assayModel: fact.assay_model,
    resultSummary: fact.result_summary,
    measurementValue: nullableNumber(fact.measurement_value),
    measurementUnit: fact.measurement_unit,
    measurementDirection: fact.measurement_direction,
    measurementMin: nullableNumber(fact.measurement_min),
    measurementMax: nullableNumber(fact.measurement_max),
    timepoint: fact.timepoint,
    condition: fact.condition,
    pValue: nullableNumber(fact.p_value),
    sampleSize: fact.sample_size,
    statisticalTest: fact.statistical_test,
    evidenceType: fact.evidence_type,
    relationType: fact.relation_type,
    quote: fact.quote,
    snippet: fact.quote
      ? compactSnippet(fact.quote, 700)
      : fact.chunk?.content
        ? compactSnippet(fact.chunk.content, 700)
        : undefined,
  };
}

function buildSources(
  claims: ResearchClaim[],
  facts: BioprospectingFact[],
): EvidencePackSource[] {
  const seen = new Map<string, EvidencePackSource>();
  for (const claim of claims) {
    if (!claim.source) continue;
    seen.set(claim.source.id, {
      id: claim.source.id,
      title: claim.source.title,
      trustTier: claim.source.trust_tier,
      kind: claim.source.source_kind,
      doi: claim.source.doi,
      url: claim.source.url,
      doiUrl: claim.source.doi ? `https://doi.org/${claim.source.doi}` : null,
      paperUrl: `/library/${encodeDocId(claim.source.title)}`,
    });
  }
  for (const fact of facts) {
    if (!fact.source) continue;
    seen.set(fact.source.id, {
      id: fact.source.id,
      title: fact.source.title,
      trustTier: fact.source.trust_tier,
      kind: fact.source.source_kind,
      doi: fact.source.doi,
      url: fact.source.url,
      doiUrl: fact.source.doi ? `https://doi.org/${fact.source.doi}` : null,
      paperUrl: `/library/${encodeDocId(fact.source.title)}`,
    });
  }
  return Array.from(seen.values());
}

export async function researchBrainSearch(params: {
  query: string;
  trustTier?: ResearchTrustTier | "all";
  includeExternal?: boolean;
  limit?: number;
  measurementMin?: number;
  measurementMax?: number;
  measurementUnit?: string;
  measurementDirection?: "increase" | "decrease" | "no_change" | "mixed";
  condition?: string;
  reviewStatus?: BioprospectingReviewStatus | "all";
  evidenceStrength?: "direct" | "indirect" | "hypothesis" | "unknown" | "all";
  sourceId?: string;
  sourceTrustTier?: ResearchTrustTier | "all";
  /**
   * The STABLE query to detect paper scope from — the user's original question,
   * not the objective that reflection rewrites each iteration. Scope must be
   * sticky: the user named the paper once, in their question, and every
   * iteration should stay on it. Detecting from the evolving objective loses the
   * species name by iteration two and silently drops the scope, which reopens
   * cross-paper contamination and DOI citations. Falls back to `query`.
   */
  scopeQuery?: string;
  /**
   * The query to RETRIEVE passages with — the user's original question blended
   * with the current objective, not the objective alone.
   *
   * `query` follows the objective reflection rewrites each iteration, and by
   * iteration two that objective is often a list of bare mechanism names
   * ("PI3K/AKT/mTOR, IP3/Ca2+, phosphoinositide signaling"). Embedded on its
   * own, that text has lost the DOMAIN — no "coral", no "symbiosome" — so the
   * vector search happily returns a type-2-diabetes paper that discusses
   * PI3K/Akt/mTOR in mouse islets, and the reranker AGREES, because against
   * that literal query the diabetes passage IS relevant. The reranker was not
   * wrong; the question we asked it had drifted.
   *
   * Keeping the original question in the retrieval text holds the domain anchor
   * while still following the iteration's new focus. Falls back to `query`.
   */
  retrievalQuery?: string;
}): Promise<EvidencePack> {
  const trustTier = params.includeExternal
    ? params.trustTier || "all"
    : params.trustTier === "external"
      ? "external"
      : "internal";

  const limit = params.limit || 16;
  const inferredMeasurementFilters = inferMeasurementFiltersFromQuery(
    params.query,
  );
  const measurementFilters = {
    ...inferredMeasurementFilters,
    measurementMin:
      params.measurementMin ?? inferredMeasurementFilters.measurementMin,
    measurementMax:
      params.measurementMax ?? inferredMeasurementFilters.measurementMax,
    measurementUnit:
      params.measurementUnit ?? inferredMeasurementFilters.measurementUnit,
    measurementDirection:
      params.measurementDirection ??
      inferredMeasurementFilters.measurementDirection,
    condition: params.condition ?? inferredMeasurementFilters.condition,
  };
  const queryPlan = planBioprospectingQuery(params.query, measurementFilters);

  // When the query clearly names one paper, scope every part of the pack to it
  // so the answer cites THAT paper and not whatever ranks high semantically. An
  // explicit sourceId from the caller wins; otherwise we try to detect one, and
  // a null detection means "search broadly" — unchanged behaviour.
  const scope = params.sourceId
    ? null
    : await detectPaperScope(params.scopeQuery || params.query);
  const scopedSourceId = params.sourceId || scope?.sourceId;
  if (scope) {
    logger.info(
      { sourceId: scope.sourceId, reason: scope.reason, entity: scope.entity },
      "research_brain_search_scoped_to_paper",
    );
  }

  const [claims, facts] = await Promise.all([
    searchClaims({
      query: params.query,
      trustTier,
      limit,
      sourceId: scopedSourceId,
    }),
    searchBioprospectingFacts({
      query: params.query,
      limit,
      ...measurementFilters,
      reviewStatus: params.reviewStatus,
      sourceId: scopedSourceId,
      sourceTrustTier: params.sourceTrustTier,
    }),
  ]);

  const mapped = claims.map(claimToEvidencePackClaim);
  const queryProfile = buildBioprospectingQueryProfile(params.query);
  const mappedFacts = facts
    .map((fact) => factToEvidencePackFact(fact, queryProfile))
    .filter(
      (fact) =>
        !params.evidenceStrength ||
        params.evidenceStrength === "all" ||
        fact.evidenceStrength === params.evidenceStrength,
    );

  // Fetch contradictions for returned facts
  const factIds = facts.map((f) => f.id);
  const contradictions = await searchBioprospectingContradictions({ factIds });
  const contradictionWarnings = contradictions.map(
    (c: ResearchBioprospectingContradiction): EvidencePackContradiction => ({
      id: c.id,
      contradictionType: c.conflict_type,
      sourceA: {
        factId: c.fact_a_id,
        claim:
          (c as any).fact_a?.result_summary ||
          (c as any).fact_a?.quote ||
          "",
        sourceTitle: (c as any).fact_a?.source?.title || null,
        doi: (c as any).fact_a?.source?.doi || null,
        value: (c.metadata as any)?.source_a?.value || "",
        provenance: (c.metadata as any)?.source_a?.provenance || "",
      },
      sourceB: {
        factId: c.fact_b_id,
        claim:
          (c as any).fact_b?.result_summary ||
          (c as any).fact_b?.quote ||
          "",
        sourceTitle: (c as any).fact_b?.source?.title || null,
        doi: (c as any).fact_b?.source?.doi || null,
        value: (c.metadata as any)?.source_b?.value || "",
        provenance: (c.metadata as any)?.source_b?.provenance || "",
      },
      conflictSummary: c.explanation || (c.metadata as any)?.conflict_summary || "",
      severity: c.severity,
      explanation: c.explanation,
      status: c.status as "open" | "resolved" | "dismissed",
    }),
  );

  /*
    THE PAPER'S OWN WORDS, FOUND SEMANTICALLY.

    Everything above this point is found by LEXICAL search — `claim ILIKE
    '%word%'` — which cannot cross a language. A Spanish question never matches
    an English paper. The system's own Deep Research memories, written in the
    user's language, DO match, so the pack filled with the system's prior output
    while the real literature sat unreachable in the same database.

    The cost was not a bad answer. Deep Research READ the sea urchin paper,
    pulled 20 of its chunks, and answered all six of the user's questions
    correctly — including the trap about siderophores, quoting the paper's own
    limitations section. Then the VERIFIER checked that answer against this pack,
    which structurally could not contain the paper, found only six memories that
    all said "I cannot find enough evidence", and deleted every correct answer.

    The system found the truth, verified it against the PDF, and censored itself.

    So the pack now carries the passages the researcher actually read, retrieved
    the same way the researcher retrieved them: by MEANING, not by matching
    letters. A failure here is non-fatal — the pack degrades to what it had
    before, which is what it has always had.
  */
  let passages: EvidencePack["passages"] = [];
  try {
    const { VectorSearchWithDocuments } = await import(
      "../../embeddings/vectorSearchWithDocs"
    );
    let vectorSearch = (globalThis as any).__knowledgeVectorSearch;
    if (!vectorSearch) {
      vectorSearch = new VectorSearchWithDocuments();
      (globalThis as any).__knowledgeVectorSearch = vectorSearch;
    }
    // When scoped to a paper, filter the passage search to that document by
    // title (documents.title === research_sources.title). This is what stops
    // the pack pulling near-identical sentences out of OTHER papers.
    //
    // AND retrieve MORE of it. Eight chunks is the right budget for a broad,
    // cross-paper search — you do not want one paper flooding the pack. But once
    // we have committed to a single paper for a six-part question, eight chunks
    // under-covers it: the most query-similar eight landed on the title, results,
    // limitations and conclusions, and left the Methods section out — so the
    // verifier could not confirm the tool the paper names (PICRUSt2) and hedged
    // every answer that depended on it, which both dulled the answer and made it
    // long enough to truncate. Scoped, there is no contamination cost to reading
    // more of the one paper we mean, so we do.
    const scoped = Boolean(scope?.title);
    // Retrieve (and rerank) with the DOMAIN-ANCHORED text — see retrievalQuery.
    // Searching with the drifted objective alone is what pulled a diabetes paper
    // into a coral question.
    const docs = await vectorSearch.search(params.retrievalQuery || params.query, {
      vectorLimit: scoped ? 48 : 24,
      finalLimit: scoped ? 16 : 8,
      ...(scoped ? { filterTitle: scope!.title } : {}),
    });
    passages = (docs ?? []).map((d: any) => ({
      sourceId: d.metadata?.sourceId ?? null,
      sourceTitle: d.title ?? null,
      content: String(d.content ?? "").slice(0, 1200),
      similarity: d.relevanceScore ?? d.similarity ?? null,
      page: d.metadata?.page ?? null,
      citation: null,
    }));

    /*
      ANCHOR EACH PASSAGE, AND HAND THE MODEL A LINK IT CAN STAND BEHIND.

      A citation to doi.org is a promise: "trust me, it's in there." A citation
      that opens OUR copy of the PDF, on the right page, with the sentence boxed,
      is the thing itself — and it is the only kind this system can stand behind,
      because it is the only kind it can CHECK.

      So we locate each passage in the PDF exactly as we locate a claim: find its
      text in the layer, read off the box. The result is a deep link the viewer
      already knows how to restore (#bbox=…&page=…&type=chunk), which lands the
      reader on the sentence with the verdict beside it.

      If a passage does not anchor, its `citation` stays null and the model is
      told to cite the DOI instead. We do not invent a location we could not
      verify — the whole apparatus exists to stop exactly that.

      The PDF is parsed ONCE per source, not once per passage: PDF.js detaches
      the buffer it is handed, so a per-passage call would anchor the first and
      throw on the rest. Best-effort throughout — a paper we cannot open still
      contributes its text, just without a box.
    */
    // KEY BY TITLE, NOT sourceId.
    //
    // The vector store's `documents` metadata never carries a sourceId — the
    // research_sources row is created AFTER the chunks are inserted, and it is
    // keyed by title. So `d.metadata?.sourceId` was always undefined, this loop
    // skipped EVERY passage, no passage ever anchored, and every citation fell
    // back to the DOI. The whole "cite the link we can open" feature was dead on
    // arrival for exactly this reason. The passage already carries `sourceTitle`
    // (= the document title), which is the real join key to research_sources.
    const byTitle = new Map<string, typeof passages>();
    for (const p of passages) {
      if (!p.sourceTitle) continue;
      const list = byTitle.get(p.sourceTitle) ?? [];
      list.push(p);
      byTitle.set(p.sourceTitle, list);
    }

    let anchored = 0;
    for (const [title, group] of byTitle) {
      try {
        const { data: src } = await getServiceClient()
          .from("research_sources")
          .select("id,title,file_path")
          .eq("title", title)
          .maybeSingle();
        if (!src?.file_path) continue;

        const { loadSourcePdf } = await import("../pdf/loadSourcePdf");
        const pdf = await loadSourcePdf(src as any);
        if (!pdf) continue;

        const { indexPdfText, anchorInIndex } = await import(
          "../pdf/textAnchor"
        );
        const index = await indexPdfText(pdf);
        const docId = Buffer.from(String(src.title ?? "")).toString("base64");

        for (const p of group) {
          const hit = anchorInIndex(index, p.content);
          if (!hit) continue;
          const { x, y, w, h } = hit.bbox;
          p.page = hit.page;
          p.citation = `/library/${docId}/viewer#bbox=${x},${y},${w},${h}&page=${hit.page}&type=chunk`;
          anchored++;
        }
      } catch (error) {
        logger.warn(
          { err: error, title },
          "evidence_pack_passage_anchor_failed",
        );
      }
    }
    // Say it out loud. A citation that silently degrades to a DOI reads exactly
    // like one that anchored — this line is how we tell the two apart in the
    // logs instead of guessing.
    logger.info(
      { total: passages.length, anchored },
      "evidence_pack_passages_anchored",
    );
  } catch (error) {
    logger.warn({ err: error }, "evidence_pack_passage_search_failed");
  }

  // Relevance guard for the claim buckets. In a BROAD (unscoped) query the claim
  // search is lexical and can surface a well-verified but topically-unrelated
  // paper — a ciguatoxin study leaking into a coral-bleaching question. The
  // SEMANTIC passage search is the relevance signal we trust: only keep claims
  // whose source paper actually contributed a passage to this pack. Join by
  // title (the vector store carries no sourceId — see the passage-anchor note
  // above). Skip the guard when the query is already scoped to one paper, or
  // when there are no passages to judge relevance against (nothing to filter on,
  // so filtering would blank the panel).
  const passageTitles = new Set(
    passages.map((p) => p.sourceTitle).filter((t): t is string => !!t),
  );
  const claimIsRelevant = (claim: EvidencePackClaim): boolean =>
    scopedSourceId != null ||
    passageTitles.size === 0 ||
    (claim.sourceTitle != null && passageTitles.has(claim.sourceTitle));
  const relevantClaims = mapped.filter(claimIsRelevant);
  if (relevantClaims.length !== mapped.length) {
    logger.info(
      { before: mapped.length, after: relevantClaims.length },
      "evidence_pack_claims_relevance_filtered",
    );
  }

  // Relevance guard for bioprospecting facts, using each fact's OWN query
  // classification rather than the passage join (a bioprospecting paper
  // legitimately has facts but no vector-store passage). A fact classified as
  // "keyword_match" with an empty queryMatches list matched NOTHING structural
  // in the query — no species, genus, family, compound, bioactivity, geography,
  // or ecosystem — so it is off-topic noise (the urchin/chitosan/gelatin facts
  // that leak into a coral question). Drop those; keep every fact that matched
  // something the query actually asked about.
  const relevantFacts = mappedFacts.filter(
    (f) =>
      !(f.matchType === "keyword_match" && (f.queryMatches?.length ?? 0) === 0),
  );
  if (relevantFacts.length !== mappedFacts.length) {
    logger.info(
      { before: mappedFacts.length, after: relevantFacts.length },
      "evidence_pack_facts_relevance_filtered",
    );
  }

  const pack: EvidencePack = {
    question: params.query,
    queryPlan,
    passages,
    bioprospectingFacts: relevantFacts,
    supportedClaims: relevantClaims.filter((claim) => claim.status === "supported"),
    partialClaims: relevantClaims.filter(
      (claim) => claim.status === "partial" || claim.status === "hypothesis",
    ),
    contradictions: relevantClaims.filter((claim) => claim.status === "contradicted"),
    openQuestions: relevantClaims.filter((claim) => claim.status === "open_question"),
    sources: buildSources(claims, facts),
    contradictionWarnings,
    scope: scope
      ? {
          sourceId: scope.sourceId,
          title: scope.title,
          docId: Buffer.from(String(scope.title)).toString("base64"),
        }
      : null,
  };

  if (
    pack.bioprospectingFacts.length === 0 &&
    pack.supportedClaims.length === 0 &&
    pack.partialClaims.length === 0 &&
    pack.contradictions.length === 0
  ) {
    pack.openQuestions.push({
      id: "generated-open-question",
      claim:
        "I cannot find enough evidence in the loaded papers to answer this question as a scientific fact.",
      claimType: "open_question",
      status: "open_question",
      confidence: "high",
      trustTier: "internal",
    });
  }

  logger.info(
    {
      query: params.query,
      supported: pack.supportedClaims.length,
      partial: pack.partialClaims.length,
      contradictions: pack.contradictions.length,
      bioprospectingFacts: pack.bioprospectingFacts.length,
      directBioprospectingFacts: pack.bioprospectingFacts.filter(
        (fact) => fact.evidenceStrength === "direct",
      ).length,
      indirectBioprospectingFacts: pack.bioprospectingFacts.filter(
        (fact) => fact.evidenceStrength === "indirect",
      ).length,
      measurementFilters,
      reviewStatus: params.reviewStatus || "default",
      evidenceStrength: params.evidenceStrength || "all",
      sourceId: params.sourceId || "all",
      sourceTrustTier: params.sourceTrustTier || "all",
      questionType: pack.queryPlan.questionType,
      sources: pack.sources.length,
    },
    "research_brain_search_completed",
  );

  return pack;
}

export function formatEvidencePackForPrompt(pack: EvidencePack): string {
  const lines: string[] = [];
  lines.push("Research Brain evidence pack:");
  lines.push(`Question: ${pack.question}`);
  lines.push(
    `Query plan: ${pack.queryPlan.intentLabel}. Type: ${pack.queryPlan.questionType}. Strategy: ${pack.queryPlan.strategy}`,
  );
  lines.push(
    `Suggested answer sections: ${pack.queryPlan.answerSections.join("; ")}.`,
  );
  if (pack.queryPlan.cautions.length > 0) {
    lines.push(`Query cautions: ${pack.queryPlan.cautions.join(" ")}`);
  }
  lines.push(
    `External literature fallback: ${
      pack.queryPlan.shouldUseExternalLiterature
        ? "allowed if internal evidence is insufficient"
        : "not needed unless explicitly requested"
    }.`,
  );
  lines.push(
    "Answering rule: when using this evidence, include compact provenance in the answer: DOI link, source title, internal fragment link, fragment index/page if available, and a short quoted evidence snippet. Use citation format [text]{/library/...?...} for internal fragment links, and [DOI]{https://doi.org/...} for the public DOI. Prefer the internal fragment link for claim-level citations.",
  );

  /*
    THE PAPER'S OWN WORDS COME FIRST.

    Everything else in this pack is something we EXTRACTED about a paper — a
    claim, a fact, a contradiction. These passages are the paper itself,
    retrieved by meaning rather than by matching letters, and they are the only
    part of the pack that can cross a language: a Spanish question does not
    match an English paper by substring, but it does by embedding.

    They are printed first because a verifier that reads claims before text
    treats our summaries as the ground truth and the source as commentary,
    which is exactly backwards.

    The block and its citation rule come from citation/citationPolicy.ts — the
    one place that owns how we cite — so this prompt and the reply/verifier
    prompts can never drift into disagreeing about DOI vs internal links again.
  */
  lines.push(...renderPassageBlock(pack.passages));

  const formatClaim = (claim: EvidencePackClaim) => {
    const source = claim.sourceTitle ? ` Source: ${claim.sourceTitle}.` : "";
    const doi = claim.doi
      ? ` DOI: ${claim.doi}${claim.doiUrl ? ` (${claim.doiUrl})` : ""}.`
      : "";
    const paper = claim.paperUrl ? ` Paper page: ${claim.paperUrl}.` : "";
    const evidence = claim.evidenceUrl
      ? ` Internal fragment link: ${claim.evidenceUrl}.`
      : "";
    const chunk =
      claim.chunkIndex != null ? ` Fragment: ${claim.chunkIndex}.` : "";
    const page = claim.page != null ? ` Page: ${claim.page}.` : "";
    const section = claim.section ? ` Section: ${claim.section}.` : "";
    const snippet = claim.snippet
      ? ` Evidence snippet: "${claim.snippet}"`
      : "";
    return `- (${claim.status}, ${claim.trustTier}, ${claim.confidence}) ${claim.claim}${source}${doi}${paper}${evidence}${chunk}${page}${section}${snippet}`;
  };

  const formatFact = (fact: EvidencePackBioprospectingFact) => {
    const subject = [
      fact.species ? `Species: ${fact.species}` : null,
      !fact.species && fact.genus ? `Genus: ${fact.genus}` : null,
      fact.family ? `Family: ${fact.family}` : null,
      fact.organismGroup ? `Group: ${fact.organismGroup}` : null,
      fact.geography ? `Geography: ${fact.geography}` : null,
      fact.ecosystem ? `Ecosystem: ${fact.ecosystem}` : null,
    ]
      .filter(Boolean)
      .join(". ");
    const molecule = [
      fact.compound ? `Compound: ${fact.compound}` : null,
      fact.compoundClass ? `Class: ${fact.compoundClass}` : null,
      fact.moleculeType ? `Molecule type: ${fact.moleculeType}` : null,
      fact.bioactivity ? `Bioactivity: ${fact.bioactivity}` : null,
      fact.applicationArea ? `Application: ${fact.applicationArea}` : null,
      fact.assayModel ? `Assay/model: ${fact.assayModel}` : null,
    ]
      .filter(Boolean)
      .join(". ");
    const result = fact.resultSummary ? ` Result: ${fact.resultSummary}.` : "";
    const measurement = formatMeasurement(fact);
    const relation = fact.relationType
      ? ` Relation: ${fact.relationType}.`
      : "";
    const evidenceType = fact.evidenceType
      ? ` Evidence type: ${fact.evidenceType}.`
      : "";
    const source = fact.sourceTitle ? ` Source: ${fact.sourceTitle}.` : "";
    const doi = fact.doi
      ? ` DOI: ${fact.doi}${fact.doiUrl ? ` (${fact.doiUrl})` : ""}.`
      : "";
    const paper = fact.paperUrl ? ` Paper page: ${fact.paperUrl}.` : "";
    const evidence = fact.evidenceUrl
      ? ` Internal fragment link: ${fact.evidenceUrl}.`
      : "";
    const chunk =
      fact.chunkIndex != null ? ` Fragment: ${fact.chunkIndex}.` : "";
    const page = fact.page != null ? ` Page: ${fact.page}.` : "";
    const snippet = fact.snippet ? ` Evidence snippet: "${fact.snippet}"` : "";
    const core = [subject, molecule].filter(Boolean).join(". ");
    const match = ` Match: ${fact.matchType}. Evidence strength: ${fact.evidenceStrength}. Evidence label: ${fact.evidenceLabel}.`;
    const review = ` Human review: ${fact.reviewStatus}${
      fact.reviewNote ? `; note=${fact.reviewNote}` : ""
    }${fact.reviewedBy ? `; reviewer=${fact.reviewedBy}` : ""}.`;
    const entityCorrection = fact.lastEntityCorrection
      ? ` Entity correction: ${formatEntityCorrection(fact.lastEntityCorrection)}.`
      : "";
    const queryMatches = fact.queryMatches.length
      ? ` Query matches: ${fact.queryMatches.join(", ")}.`
      : "";
    const taxonIds = [
      fact.speciesTaxonId ? `species=${fact.speciesTaxonId}` : null,
      fact.genusTaxonId ? `genus=${fact.genusTaxonId}` : null,
      fact.familyTaxonId ? `family=${fact.familyTaxonId}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const taxon = taxonIds ? ` Normalized taxon ids: ${taxonIds}.` : "";
    return `- (${fact.status}, ${fact.trustTier}, ${fact.confidence}) ${core || "Bioprospecting fact"}.${
      result
    }${measurement}${relation}${evidenceType}${match}${review}${entityCorrection}${queryMatches}${taxon}${source}${doi}${paper}${evidence}${chunk}${page}${snippet}`;
  };

  const directFacts = pack.bioprospectingFacts.filter(
    (fact) => fact.evidenceStrength === "direct",
  );
  const indirectFacts = pack.bioprospectingFacts.filter(
    (fact) => fact.evidenceStrength === "indirect",
  );
  const hypothesisFacts = pack.bioprospectingFacts.filter(
    (fact) => fact.evidenceStrength === "hypothesis",
  );
  const otherFacts = pack.bioprospectingFacts.filter(
    (fact) => fact.evidenceStrength === "unknown",
  );

  lines.push("\nDirect bioprospecting facts:");
  lines.push(
    directFacts.length ? directFacts.map(formatFact).join("\n") : "- none",
  );

  lines.push("\nIndirect bioprospecting facts:");
  lines.push(
    indirectFacts.length ? indirectFacts.map(formatFact).join("\n") : "- none",
  );

  lines.push("\nHypothesis/open bioprospecting facts:");
  lines.push(
    hypothesisFacts.length
      ? hypothesisFacts.map(formatFact).join("\n")
      : "- none",
  );

  lines.push("\nOther bioprospecting keyword matches:");
  lines.push(
    otherFacts.length ? otherFacts.map(formatFact).join("\n") : "- none",
  );

  lines.push("\nSupported claims:");
  lines.push(
    pack.supportedClaims.length
      ? pack.supportedClaims.map(formatClaim).join("\n")
      : "- none",
  );

  lines.push("\nPartial/hypothesis claims:");
  lines.push(
    pack.partialClaims.length
      ? pack.partialClaims.map(formatClaim).join("\n")
      : "- none",
  );

  lines.push("\nContradictions:");
  lines.push(
    pack.contradictions.length
      ? pack.contradictions.map(formatClaim).join("\n")
      : "- none",
  );

  lines.push("\nOpen questions:");
  lines.push(
    pack.openQuestions.length
      ? pack.openQuestions.map(formatClaim).join("\n")
      : "- none",
  );

  return lines.join("\n");
}

function encodeDocId(title: string): string {
  return Buffer.from(title, "utf-8").toString("base64url");
}

function compactSnippet(content: string, maxLength: number): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trim()}...`;
}

function containsAny(value: string, terms: string[]): boolean {
  return terms.some((term) => value.includes(normalizeForMatch(term)));
}

export function planBioprospectingQuery(
  query: string,
  measurementFilters: Pick<
    BioprospectingFactSearchParams,
    | "measurementMin"
    | "measurementMax"
    | "measurementUnit"
    | "measurementDirection"
    | "condition"
  > = {},
): EvidencePackQueryPlan {
  const normalized = normalizeForMatch(query);
  const hasMeasurementFilter = Object.values(measurementFilters).some(
    (value) => value !== undefined && value !== null && value !== "",
  );
  const hasSpeciesSignal =
    /\b[A-Z][a-zA-Z-]{3,}\s+[a-z][a-z-]{2,}\b/.test(query) ||
    containsAny(normalized, [
      "species",
      "especie",
      "genus",
      "genero",
      "region",
      "local",
    ]);

  let questionType: EvidencePackQueryPlan["questionType"] = "unknown";

  if (
    containsAny(normalized, [
      "solo evidencia",
      "only direct",
      "direct evidence",
      "evidence audit",
      "audit",
      "fuentes",
      "citations",
      "citas",
    ])
  ) {
    questionType = "evidence_audit";
  } else if (
    hasMeasurementFilter ||
    /(?:>|<|>=|<=|\bpercent\b|%|\bfold\b|\bp-value\b|\bp value\b|\baumento\b|\bincrease\b|\bdecrease\b)/.test(
      normalized,
    )
  ) {
    questionType = "quantitative_search";
  } else if (
    containsAny(normalized, [
      "compare",
      "comparar",
      "comparison",
      "similar",
      "sister",
      "hermana",
      "china",
      "otra parte",
      "related one",
      "relacionada",
    ])
  ) {
    questionType = "comparison";
  } else if (
    containsAny(normalized, [
      "anticancer",
      "anticancerigen",
      "anti cancer",
      "anti-inflammatory",
      "antiinflam",
      "antimicrobial",
      "antioxidant",
      "cytotoxic",
      "citotox",
      "bioactivity",
      "bioactividad",
    ])
  ) {
    questionType = "activity_search";
  } else if (
    containsAny(normalized, [
      "cosmetic",
      "cosmetica",
      "cosmetico",
      "biomaterial",
      "limpieza facial",
      "application",
      "aplicacion",
      "aplicaciones",
      "material blando",
    ])
  ) {
    questionType = "application_search";
  } else if (
    containsAny(normalized, [
      "compound",
      "compuesto",
      "molecule",
      "molecula",
      "metabolite",
      "metabolito",
      "peptide",
      "peptido",
      "lipid",
      "lipido",
      "glucose",
      "macromolecula",
    ])
  ) {
    questionType = "molecule_exploration";
  } else if (
    containsAny(normalized, [
      "bleaching",
      "blanqueamiento",
      "arrecife",
      "reef",
      "coral",
      "restoration",
      "restauracion",
      "symbiodiniaceae",
      "symbiont",
      "simbionte",
      "disease",
      "enfermedad",
    ])
  ) {
    questionType = "reef_context";
  } else if (hasSpeciesSignal) {
    questionType = "species_exploration";
  }

  switch (questionType) {
    case "species_exploration":
      return {
        questionType,
        intentLabel: "species exploration",
        strategy:
          "Start with direct species evidence, then same-genus/family facts, then ecosystem analogies; finish with gaps and testable next steps.",
        answerSections: [
          "direct evidence",
          "nearby taxonomy evidence",
          "possible applications",
          "missing evidence",
          "sources",
        ],
        shouldUseExternalLiterature: true,
        cautions: [
          "Do not state that an application is established for the user's species unless direct species evidence exists.",
        ],
      };
    case "molecule_exploration":
      return {
        questionType,
        intentLabel: "molecule exploration",
        strategy:
          "Group evidence by compound or molecule class and keep organism, assay, result, and provenance attached to each item.",
        answerSections: [
          "reported molecules",
          "bioactivity evidence",
          "quantitative results",
          "limitations",
          "sources",
        ],
        shouldUseExternalLiterature: true,
        cautions: [
          "Do not merge different compounds or infer activity for a molecule unless the fact explicitly reports it.",
        ],
      };
    case "activity_search":
      return {
        questionType,
        intentLabel: "bioactivity search",
        strategy:
          "Retrieve facts by bioactivity/application terms and rank direct evidence before taxonomic or ecological analogies.",
        answerSections: [
          "direct activity evidence",
          "indirect candidates",
          "assay details",
          "unverified hypotheses",
          "sources",
        ],
        shouldUseExternalLiterature: true,
        cautions: [
          "Activity in an assay is not the same as a validated drug, therapy, or commercial product.",
        ],
      };
    case "comparison":
      return {
        questionType,
        intentLabel: "taxonomic or ecological comparison",
        strategy:
          "Compare entities only on evidence-backed fields and mark whether each point is direct, same-genus, same-family, or ecological analogy.",
        answerSections: [
          "entity A evidence",
          "entity B evidence",
          "shared signals",
          "differences",
          "evidence gaps",
          "sources",
        ],
        shouldUseExternalLiterature: true,
        cautions: [
          "Do not treat related organisms from another region as proof for the user's organism.",
        ],
      };
    case "application_search":
      return {
        questionType,
        intentLabel: "application search",
        strategy:
          "Separate reported applications from plausible but untested applications; connect each application to molecule, assay, and organism evidence.",
        answerSections: [
          "reported applications",
          "supporting molecules or assays",
          "plausible hypotheses",
          "validation needed",
          "sources",
        ],
        shouldUseExternalLiterature: true,
        cautions: [
          "Avoid product or medical claims unless the loaded evidence explicitly supports them.",
        ],
      };
    case "evidence_audit":
      return {
        questionType,
        intentLabel: "direct evidence audit",
        strategy:
          "Show only evidence-backed statements and provenance; exclude speculative synthesis unless clearly requested.",
        answerSections: [
          "direct evidence only",
          "partial evidence",
          "contradictions",
          "not supported",
          "sources",
        ],
        shouldUseExternalLiterature: false,
        cautions: [
          "Keep unsupported ideas out of the answer even if they are biologically plausible.",
        ],
      };
    case "quantitative_search":
      return {
        questionType,
        intentLabel: "quantitative evidence search",
        strategy:
          "Prioritize facts with structured measurements and report value, unit, direction, condition, timepoint, and statistics only when present.",
        answerSections: [
          "matching measurements",
          "experimental context",
          "non-quantified related evidence",
          "limitations",
          "sources",
        ],
        shouldUseExternalLiterature: false,
        cautions: [
          "Do not calculate or normalize values beyond what the extracted facts support.",
        ],
      };
    case "reef_context":
      return {
        questionType,
        intentLabel: "reef context",
        strategy:
          "Use reef, bleaching, symbiont, disease, and ecosystem evidence as context while preserving organism-level provenance.",
        answerSections: [
          "reef evidence",
          "organism or symbiont evidence",
          "environmental context",
          "open questions",
          "sources",
        ],
        shouldUseExternalLiterature: true,
        cautions: [
          "Do not infer site-level environmental risk unless environmental data is actually present.",
        ],
      };
    default:
      return {
        questionType,
        intentLabel: "general evidence search",
        strategy:
          "Retrieve the closest internal evidence, separate supported from partial/open evidence, and state what is missing.",
        answerSections: [
          "available evidence",
          "interpretation",
          "missing evidence",
          "sources",
        ],
        shouldUseExternalLiterature: true,
        cautions: [
          "If local evidence is sparse, say so before giving hypotheses or external next steps.",
        ],
      };
  }
}

function inferMeasurementFiltersFromQuery(
  query: string,
): Pick<
  BioprospectingFactSearchParams,
  | "measurementMin"
  | "measurementMax"
  | "measurementUnit"
  | "measurementDirection"
  | "condition"
> {
  const filters: Pick<
    BioprospectingFactSearchParams,
    | "measurementMin"
    | "measurementMax"
    | "measurementUnit"
    | "measurementDirection"
    | "condition"
  > = {};
  const normalized = query.toLowerCase();
  const percentMatch = normalized.match(/(\d+(?:\.\d+)?)\s*%/);

  if (percentMatch) {
    const value = Number(percentMatch[1]);
    if (Number.isFinite(value)) {
      filters.measurementUnit = "%";
      if (
        /(?:<|less than|below|under|at most|maximum|max)\s*\d/i.test(normalized)
      ) {
        filters.measurementMax = value;
      } else {
        filters.measurementMin = value;
      }
    }
  }

  if (
    /\b(increase|increased|increases|increasing|up|higher|greater|above|over)\b/.test(
      normalized,
    )
  ) {
    filters.measurementDirection = "increase";
  } else if (
    /\b(decrease|decreased|decreases|down|lower|reduction|reduced)\b/.test(
      normalized,
    )
  ) {
    filters.measurementDirection = "decrease";
  } else if (
    /\b(no change|unchanged|no significant change)\b/.test(normalized)
  ) {
    filters.measurementDirection = "no_change";
  }

  if (
    /\b(thermal stress|heat stress|high temperature|high temperatures)\b/.test(
      normalized,
    )
  ) {
    filters.condition = "thermal stress";
  } else if (/\bbleaching\b/.test(normalized)) {
    filters.condition = "bleaching";
  } else if (/\boxidative stress\b/.test(normalized)) {
    filters.condition = "oxidative stress";
  }

  return filters;
}

function nullableNumber(
  value: number | string | null | undefined,
): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMeasurement(fact: EvidencePackBioprospectingFact): string {
  const parts = [
    fact.measurementValue != null
      ? `value=${fact.measurementValue}${fact.measurementUnit ? ` ${fact.measurementUnit}` : ""}`
      : null,
    fact.measurementDirection ? `direction=${fact.measurementDirection}` : null,
    fact.measurementMin != null ? `min=${fact.measurementMin}` : null,
    fact.measurementMax != null ? `max=${fact.measurementMax}` : null,
    fact.timepoint ? `timepoint=${fact.timepoint}` : null,
    fact.condition ? `condition=${fact.condition}` : null,
    fact.pValue != null ? `p=${fact.pValue}` : null,
    fact.sampleSize != null ? `n=${fact.sampleSize}` : null,
    fact.statisticalTest ? `test=${fact.statisticalTest}` : null,
  ].filter(Boolean);

  return parts.length ? ` Measurement: ${parts.join("; ")}.` : "";
}

function formatEntityCorrection(
  correction: NonNullable<
    EvidencePackBioprospectingFact["lastEntityCorrection"]
  >,
): string {
  const fields = Object.entries(correction.fields || {})
    .map(([field, change]) => {
      const before = change.before ?? "";
      const after = change.after ?? "";
      return `${field}: "${before}" -> "${after}"`;
    })
    .slice(0, 6);
  const reviewer = correction.correctedBy
    ? ` by ${correction.correctedBy}`
    : "";
  const at = correction.correctedAt ? ` at ${correction.correctedAt}` : "";
  return `${fields.join("; ")}${reviewer}${at}`;
}

function stringMetadata(fact: BioprospectingFact, key: string): string | null {
  const value = fact.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumberMetadata(
  fact: BioprospectingFact,
  key: string,
): number | null {
  const value = fact.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readEntityCorrectionMetadata(fact: BioprospectingFact, key: string) {
  return parseEntityCorrection(fact.metadata?.[key]);
}

function parseEntityCorrection(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = (value as any).fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return null;
  }
  return {
    correctedAt:
      typeof (value as any).correctedAt === "string"
        ? (value as any).correctedAt
        : null,
    correctedBy:
      typeof (value as any).correctedBy === "string"
        ? (value as any).correctedBy
        : null,
    fields,
  };
}

function readEntityCorrectionHistory(fact: BioprospectingFact) {
  const value = fact.metadata?.entityCorrectionHistory;
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => parseEntityCorrection(entry))
    .filter(Boolean)
    .slice(-5);
}

function buildBioprospectingQueryProfile(
  query: string,
): BioprospectingQueryProfile {
  const normalizedQuery = normalizeForMatch(query);
  const rawTokens = query
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter((token) => token.length > 1);
  const speciesCandidates = new Set<string>();
  const genusCandidates = new Set<string>();

  for (let index = 0; index < rawTokens.length - 1; index += 1) {
    const first = rawTokens[index];
    const second = rawTokens[index + 1];
    if (first.length < 4 || second.length < 3) continue;
    speciesCandidates.add(normalizeForMatch(`${first} ${second}`));
    genusCandidates.add(normalizeForMatch(first));
  }

  for (const token of rawTokens) {
    if (/^[A-Z][a-zA-Z-]{3,}$/.test(token)) {
      genusCandidates.add(normalizeForMatch(token));
    }
  }

  return {
    normalizedQuery,
    speciesCandidates: Array.from(speciesCandidates),
    genusCandidates: Array.from(genusCandidates),
  };
}

function classifyBioprospectingFact(
  fact: BioprospectingFact,
  profile: BioprospectingQueryProfile,
): Pick<
  EvidencePackBioprospectingFact,
  "matchType" | "evidenceStrength" | "evidenceLabel" | "queryMatches"
> {
  const queryMatches: string[] = [];
  const species = normalizeOptionalMatch(fact.species);
  const factGenus = fact.genus || deriveGenusFromSpecies(fact.species);
  const genus = normalizeOptionalMatch(factGenus);
  const family = normalizeOptionalMatch(fact.family);
  const compound = normalizeOptionalMatch(fact.compound);
  const compoundClass = normalizeOptionalMatch(fact.compound_class);
  const bioactivity = normalizeOptionalMatch(fact.bioactivity);
  const applicationArea = normalizeOptionalMatch(fact.application_area);
  const geography = normalizeOptionalMatch(fact.geography);
  const ecosystem = normalizeOptionalMatch(fact.ecosystem);

  const statusSuggestsHypothesis =
    fact.status === "hypothesis" || fact.status === "open_question";

  if (species && profile.normalizedQuery.includes(species)) {
    queryMatches.push(fact.species || "species");
    return {
      matchType: "direct_species",
      evidenceStrength: statusSuggestsHypothesis ? "hypothesis" : "direct",
      evidenceLabel: statusSuggestsHypothesis
        ? "species-level hypothesis/open question"
        : "direct species-level evidence",
      queryMatches,
    };
  }

  const requestedSpeciesForGenus = genus
    ? profile.speciesCandidates.find((candidate) =>
        candidate.startsWith(`${genus} `),
      )
    : null;
  if (genus && requestedSpeciesForGenus) {
    queryMatches.push(factGenus || "genus");
    return {
      matchType:
        species && species !== requestedSpeciesForGenus
          ? "same_genus"
          : "genus_level",
      evidenceStrength: statusSuggestsHypothesis ? "hypothesis" : "indirect",
      evidenceLabel:
        species && species !== requestedSpeciesForGenus
          ? "same-genus indirect evidence"
          : "genus-level evidence",
      queryMatches,
    };
  }

  if (genus && profile.normalizedQuery.includes(genus)) {
    queryMatches.push(factGenus || "genus");
    return {
      matchType: "genus_level",
      evidenceStrength: statusSuggestsHypothesis ? "hypothesis" : "direct",
      evidenceLabel: statusSuggestsHypothesis
        ? "genus-level hypothesis/open question"
        : "direct genus-level evidence",
      queryMatches,
    };
  }

  if (family && profile.normalizedQuery.includes(family)) {
    queryMatches.push(fact.family || "family");
    return {
      matchType: "same_family",
      evidenceStrength: statusSuggestsHypothesis ? "hypothesis" : "indirect",
      evidenceLabel: "same-family indirect evidence",
      queryMatches,
    };
  }

  for (const [label, value] of [
    ["compound", compound],
    ["compound class", compoundClass],
    ["bioactivity", bioactivity],
    ["application", applicationArea],
  ] as const) {
    if (value && profile.normalizedQuery.includes(value)) {
      queryMatches.push(label);
    }
  }
  if (queryMatches.length > 0) {
    return {
      matchType: "compound_or_activity",
      evidenceStrength: statusSuggestsHypothesis ? "hypothesis" : "indirect",
      evidenceLabel:
        "compound/activity match; not organism-specific unless separately stated",
      queryMatches,
    };
  }

  for (const [label, value] of [
    ["geography", geography],
    ["ecosystem", ecosystem],
  ] as const) {
    if (value && profile.normalizedQuery.includes(value)) {
      queryMatches.push(label);
    }
  }
  if (queryMatches.length > 0) {
    return {
      matchType: "ecological_analogy",
      evidenceStrength: statusSuggestsHypothesis ? "hypothesis" : "indirect",
      evidenceLabel: "ecosystem/geography analogy; not direct species evidence",
      queryMatches,
    };
  }

  return {
    matchType: "keyword_match",
    evidenceStrength: statusSuggestsHypothesis ? "hypothesis" : "unknown",
    evidenceLabel: statusSuggestsHypothesis
      ? "hypothesis/open question from keyword match"
      : "keyword match; verify before using as a strong claim",
    queryMatches: [],
  };
}

function normalizeOptionalMatch(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const normalized = normalizeForMatch(value);
  return normalized.length > 0 ? normalized : null;
}

function deriveGenusFromSpecies(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const first = value.trim().split(/\s+/)[0];
  return first && first.length > 3 ? first : null;
}

export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
