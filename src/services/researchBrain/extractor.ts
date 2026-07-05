import logger from "../../utils/logger";
import {
  createClaimEdges,
  extractDoi,
  getSource,
  replaceClaimsForSource,
  replaceEvidenceChunks,
  setSourceExtractionStatus,
  upsertResearchSource,
} from "./db";
import { resolveResearchBrainLLM } from "./llm";
import type {
  ExtractedClaim,
  ResearchEvidenceChunk,
  ResearchSource,
} from "./types";

type DocumentChunkForRegistration = {
  id?: string;
  title: string;
  content: string;
  metadata?: any;
};

function guessSection(content: string): string | null {
  const firstLine = content.split("\n").find((line) => line.trim().length > 0);
  if (!firstLine) return null;
  const normalized = firstLine.trim().toLowerCase();
  if (/\babstract\b/.test(normalized)) return "Abstract";
  if (/\bintroduction\b/.test(normalized)) return "Introduction";
  if (/\bmethods?\b/.test(normalized)) return "Methods";
  if (/\bresults?\b/.test(normalized)) return "Results";
  if (/\bdiscussion\b/.test(normalized)) return "Discussion";
  if (/\bconclusions?\b/.test(normalized)) return "Conclusion";
  return null;
}

function guessYear(text: string): number | null {
  const match = text.slice(0, 12000).match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function extractJsonArray(text: string): any[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] || text) as string;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function heuristicClaimsFromChunks(
  chunks: ResearchEvidenceChunk[],
): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  for (const chunk of chunks.slice(0, 12)) {
    const sentences = chunk.content
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 80 && s.length <= 320);

    const evidenceSentence =
      sentences.find((s) =>
        /\b(found|showed|observed|reported|suggest|demonstrat|associated|increased|decreased|reduced|induced|inhibited)\b/i.test(
          s,
        ),
      ) || sentences[0];

    if (!evidenceSentence) continue;

    claims.push({
      claim: evidenceSentence,
      claimType: "finding",
      status: "supported",
      confidence: "low",
      chunkIndex: chunk.chunk_index ?? undefined,
      entities: [],
    });

    if (claims.length >= 8) break;
  }
  return claims;
}

async function llmClaimsFromChunks(
  source: ResearchSource,
  chunks: ResearchEvidenceChunk[],
): Promise<ExtractedClaim[]> {
  const { llm, model } = resolveResearchBrainLLM();
  if (!llm || !model) return [];

  const context = chunks
    .slice(0, 18)
    .map(
      (chunk) =>
        `[chunk_index=${chunk.chunk_index ?? 0}]\n${chunk.content.slice(0, 1800)}`,
    )
    .join("\n\n---\n\n");

  const prompt = `Extract atomic scientific claims from the paper below.

Strict rules:
- Return ONLY valid JSON array.
- Each item must have: claim, claimType, status, confidence, chunkIndex, entities.
- Use status "supported" whenever the claim is stated or clearly demonstrated in the chunk, EVEN IF PARTIAL (e.g., mentions an activity but not specific MIC values — that is still supported, not an open question).
- Only use "open_question" when the paper EXPLICITLY says the question is unanswered, e.g. "further studies are needed" or "this remains to be determined". Do NOT mark a claim as open_question just because the chunk is partial.
- Use "hypothesis" for the authors' own speculative interpretations (rare).
- Do not invent facts outside the chunks.
- Prefer 5-12 high-signal claims.

Paper title: ${source.title}
DOI: ${source.doi || "unknown"}

Chunks:
${context}`;

  const response = await llm.createChatCompletion({
    model,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 2500,
    temperature: 0,
  });

  return extractJsonArray(response.content)
    .map((item) => ({
      claim: typeof item.claim === "string" ? item.claim : "",
      claimType:
        typeof item.claimType === "string" ? item.claimType : "finding",
      status:
        item.status === "partial" ||
        item.status === "contradicted" ||
        item.status === "hypothesis" ||
        item.status === "open_question"
          ? item.status
          : "supported",
      confidence:
        typeof item.confidence === "string" ? item.confidence : "medium",
      chunkIndex:
        typeof item.chunkIndex === "number" ? item.chunkIndex : undefined,
      entities: Array.isArray(item.entities)
        ? item.entities.filter((e: unknown) => typeof e === "string")
        : [],
    }))
    .filter((claim) => claim.claim.length > 0);
}

export async function registerDocumentAsResearchSource(params: {
  title: string;
  chunks: DocumentChunkForRegistration[];
  trustTier?: "internal" | "external";
  sourceKind?: "paper" | "external_result";
  runExtraction?: boolean;
}): Promise<ResearchSource> {
  const firstContent = params.chunks
    .map((c) => c.content)
    .join("\n\n")
    .slice(0, 30000);
  const firstMeta = params.chunks[0]?.metadata || {};
  const doi = firstMeta.doi || extractDoi(firstContent);
  const filePath = firstMeta.filePath;
  const contentHash = firstMeta.contentHash;

  const source = await upsertResearchSource({
    sourceKind: params.sourceKind || "paper",
    trustTier: params.trustTier || "internal",
    title: params.title,
    doi,
    filePath,
    contentHash,
    fileSize: firstMeta.size,
    lastModifiedAt: firstMeta.lastModified,
    sourceScope: "global",
    metadata: {
      type: firstMeta.type,
      size: firstMeta.size,
      contentHash,
      lastModified: firstMeta.lastModified,
      year: firstMeta.year || guessYear(firstContent),
    },
    extractionStatus: "pending_extraction",
  });

  const evidenceChunks = await replaceEvidenceChunks(
    source.id,
    params.chunks.map((chunk, index) => ({
      documentId: chunk.id || null,
      content: chunk.content,
      section: chunk.metadata?.section || guessSection(chunk.content),
      page: chunk.metadata?.page,
      chunkIndex: Number(chunk.metadata?.chunkIndex ?? index),
      metadata: {
        ...chunk.metadata,
        title: chunk.title,
      },
    })),
  );

  if (
    params.runExtraction !== false &&
    source.extraction_status !== "extracted"
  ) {
    await extractClaimsForSource(source.id, evidenceChunks);
  }

  if (process.env.BIOPROSPECTING_AUTO_EXTRACT === "true") {
    const { extractBioprospectingFactsForSource } =
      await import("./bioprospectingExtractor");
    await extractBioprospectingFactsForSource(source.id, evidenceChunks);
  }

  return source;
}

export async function extractClaimsForSource(
  sourceId: string,
  existingChunks?: ResearchEvidenceChunk[],
): Promise<{ sourceId: string; claimCount: number; status: string }> {
  const source = await getSource(sourceId);
  if (!source) throw new Error(`Research source not found: ${sourceId}`);

  try {
    await setSourceExtractionStatus(sourceId, "pending_extraction");

    let evidenceChunks = existingChunks;
    if (!evidenceChunks) {
      const { getServiceClient } = await import("../../db/client");
      const sb = getServiceClient();
      const { data, error } = await sb
        .from("research_evidence_chunks")
        .select("*")
        .eq("source_id", sourceId)
        .order("chunk_index", { ascending: true });
      if (error) throw error;
      evidenceChunks = (data || []) as ResearchEvidenceChunk[];
    }

    if (!evidenceChunks || evidenceChunks.length === 0) {
      await setSourceExtractionStatus(
        sourceId,
        "failed_extraction",
        "No evidence chunks available",
      );
      return { sourceId, claimCount: 0, status: "failed_extraction" };
    }

    let claims = await llmClaimsFromChunks(source, evidenceChunks);
    if (claims.length === 0) {
      claims = heuristicClaimsFromChunks(evidenceChunks);
    }

    const savedClaims = await replaceClaimsForSource(
      source,
      claims,
      evidenceChunks,
    );
    await createClaimEdges(savedClaims);
    await setSourceExtractionStatus(sourceId, "extracted");

    logger.info(
      { sourceId, claimCount: savedClaims.length },
      "research_brain_extraction_completed",
    );

    return {
      sourceId,
      claimCount: savedClaims.length,
      status: "extracted",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setSourceExtractionStatus(sourceId, "failed_extraction", message);
    logger.error({ err: error, sourceId }, "research_brain_extraction_failed");
    return { sourceId, claimCount: 0, status: "failed_extraction" };
  }
}
