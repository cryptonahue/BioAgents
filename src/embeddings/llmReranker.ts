import logger from "../utils/logger";
import { resolveResearchBrainLLM } from "../services/researchBrain/llm";
import type { Document } from "./vectorSearch";

/**
 * LLM reranker — stage 2 of retrieval for deploys without a Cohere key.
 *
 * Stage-1 vector search ranks by raw cosine similarity, which rewards term-
 * overlap density: a reference-list / bibliography page packed with on-topic
 * keywords embeds very close to a topical query and out-ranks the actual body
 * prose, even though it contains no findings. A reranker fixes this by judging
 * each candidate against the query JOINTLY — "does this passage actually bear on
 * the question?" — rather than by embedding proximity.
 *
 * This one reuses the project's existing LLM keys (resolveResearchBrainLLM), so
 * it adds no new vendor. It reranks the small top-K from stage 1 in a single
 * call and, crucially, is allowed to DROP candidates it judges irrelevant (a
 * bibliography chunk, an off-topic page), returning fewer than asked.
 *
 * Returns null on any failure — no LLM available, the call throws, the output
 * will not parse, or the model judged nothing relevant — so the caller falls
 * back to plain cosine order. It never blanks retrieval on the reranker's word
 * alone; it only ever REPLACES the order with a more relevant one.
 */
export async function llmRerank(
  query: string,
  documents: Document[],
  topN: number,
): Promise<Document[] | null> {
  if (documents.length === 0) return [];

  const { llm, model } = resolveResearchBrainLLM();
  if (!llm || !model) return null;

  // Cap per-candidate text so the whole top-K fits comfortably in one prompt.
  const MAX_CHARS = 600;
  const list = documents
    .map((d, i) => {
      const body = String(d.content ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_CHARS);
      return `[${i}] ${d.title ? `${d.title} — ` : ""}${body}`;
    })
    .join("\n\n");

  const prompt = `You are a search reranker. Given a QUERY and numbered candidate passages, return the passages that ACTUALLY help answer the query, best first.

Rules:
- Judge whether a passage CONTAINS information bearing on the query — not whether it merely shares keywords.
- EXCLUDE reference lists, bibliographies, tables of contents, acknowledgements, and author/affiliation blocks: they are keyword-dense but hold no findings.
- EXCLUDE passages that are off-topic despite sharing words.
- Return AT MOST ${topN} passage numbers. Fewer is fine. Return an empty array only if NONE are relevant.
- Output ONLY a JSON array of integers (the passage numbers), best first. No prose, no markdown.

QUERY:
${query}

PASSAGES:
${list}

JSON array only:`;

  let content: string;
  try {
    const res = await llm.createChatCompletion({
      model,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 200,
      temperature: 0,
    });
    content = (res.content ?? "").trim();
  } catch (err) {
    logger.warn({ err }, "llm_rerank_call_failed");
    return null;
  }

  const raw = content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ preview: raw.slice(0, 160) }, "llm_rerank_unparseable");
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const seen = new Set<number>();
  const picked: Document[] = [];
  for (const value of parsed) {
    const i = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(i) || i < 0 || i >= documents.length) continue;
    if (seen.has(i)) continue;
    seen.add(i);
    // Synthetic descending score so any downstream ordering by relevanceScore
    // preserves the reranked order.
    picked.push({
      ...documents[i],
      relevanceScore: 1 - picked.length / Math.max(documents.length, 1),
    });
    if (picked.length >= topN) break;
  }

  // Empty pick = the model judged nothing relevant. Do NOT blank retrieval on
  // that alone — let the caller fall back to cosine order.
  if (picked.length === 0) return null;

  logger.info(
    { candidates: documents.length, kept: picked.length },
    "llm_rerank_complete",
  );
  return picked;
}
