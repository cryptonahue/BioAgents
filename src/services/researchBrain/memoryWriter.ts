import logger from "../../utils/logger";
import { upsertResearchSource, replaceClaimsForSource, createClaimEdges } from "./db";
import type { ExtractedClaim } from "./types";

function splitCandidateClaims(text: string): ExtractedClaim[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 80 && sentence.length <= 420)
    .slice(0, 8)
    .map((claim) => ({
      claim,
      claimType: "reflection",
      status: "hypothesis" as const,
      confidence: "low",
      entities: [],
    }));
}

export async function writeResearchMemory(params: {
  title: string;
  text: string;
  conversationId?: string;
  messageId?: string;
  trustTier?: "internal" | "external";
}): Promise<{ sourceId: string; claimCount: number }> {
  const source = await upsertResearchSource({
    sourceKind: "artifact",
    trustTier: params.trustTier || "internal",
    title: params.title,
    sourceScope: "global",
    metadata: {
      conversationId: params.conversationId,
      messageId: params.messageId,
      writer: "memoryWriterAgent",
    },
    extractionStatus: "extracted",
  });

  const claims = splitCandidateClaims(params.text);
  const saved = await replaceClaimsForSource(source, claims, []);
  await createClaimEdges(saved);

  logger.info(
    { sourceId: source.id, claimCount: saved.length },
    "research_memory_written",
  );

  return { sourceId: source.id, claimCount: saved.length };
}

