/**
 * WHEN THE USER NAMES A PAPER, CITE THAT PAPER — NOT WHATEVER RANKS HIGH.
 *
 * The evidence pack's passages come from a semantic search across the WHOLE
 * library. Ask about one study and the top hits include every other paper that
 * says something similar. While citations were DOIs that all read as the target,
 * this was invisible; the moment we started linking each passage to where it
 * actually lives, the answer began citing marinedrugs-24-00231-v2 for a claim
 * about marinedrugs-24-00243. The link was honest; the paper was wrong.
 *
 * So when the query clearly names ONE paper, we scope retrieval to that paper.
 * When it does not — a general research question — we change nothing and keep
 * the broad cross-paper search, because that is exactly what a general question
 * wants. The detector is deliberately conservative: no single confident match
 * means no scoping, never a wrong one.
 *
 * TWO SIGNALS, IN ORDER OF TRUST:
 *   1. An explicit DOI in the query — exact, zero false positives.
 *   2. A distinctive entity (a species binomial, a strain id) that appears in
 *      exactly ONE source in the library. Distinctiveness is measured against
 *      the actual library, so "Marine ecosystems" (in many papers) never scopes
 *      while "Hemicentrotus pulcherrimus" (in one) does.
 */
import logger from "../../utils/logger";

// db and the service client are imported dynamically inside the async
// functions, so importing this module for the pure `extractEntityCandidates`
// helper (e.g. in a unit test) does not pull in the Supabase client and its
// env requirements.

export interface PaperScope {
  sourceId: string;
  title: string;
  reason: "doi" | "entity";
  entity?: string;
}

/**
 * Common capitalized words that open a two-word phrase but are NOT a genus.
 * Without this, "Marine ecosystems" or "Mar Drugs" would be treated as entity
 * candidates. They still would not scope (they appear in many sources), but
 * skipping them up front saves a query and sharpens intent.
 */
const NOT_A_GENUS = new Set([
  "the",
  "this",
  "these",
  "those",
  "marine",
  "mar",
  "drugs",
  "table",
  "figure",
  "data",
  "results",
  "methods",
  "study",
  "paper",
  "microbial",
  "chemical",
  "surface",
  "rearing",
]);

/**
 * Pull candidate distinctive entities from the query — latin binomials like
 * "Hemicentrotus pulcherrimus": a Capitalized genus (>=5 letters, not a common
 * word) followed by a lowercase species (>=4 letters). Pure and exported so the
 * heuristic can be unit-tested without a database.
 */
export function extractEntityCandidates(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\b([A-Z][a-z]{4,})\s+([a-z]{4,})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const genus = m[1]!;
    const species = m[2]!;
    if (NOT_A_GENUS.has(genus.toLowerCase())) continue;
    const phrase = `${genus} ${species}`;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
  }
  return out;
}

/** Distinct non-artifact source ids whose evidence chunks contain `entity`. */
async function sourcesContaining(entity: string): Promise<string[]> {
  const { getServiceClient } = await import("../../db/client");
  const escaped = entity.replace(/[%_]/g, (c) => `\\${c}`);
  const { data, error } = await getServiceClient()
    .from("research_evidence_chunks")
    .select("source_id, source:research_sources!inner(source_kind)")
    .neq("source.source_kind", "artifact")
    .ilike("content", `%${escaped}%`)
    .limit(200);
  if (error) {
    logger.warn({ err: error, entity }, "paper_scope_entity_lookup_failed");
    return [];
  }
  const ids = new Set<string>();
  for (const row of data || []) {
    const id = (row as any).source_id;
    if (id) ids.add(id);
  }
  return [...ids];
}

async function sourceById(
  sourceId: string,
): Promise<{ id: string; title: string } | null> {
  const { getServiceClient } = await import("../../db/client");
  const { data } = await getServiceClient()
    .from("research_sources")
    .select("id,title")
    .eq("id", sourceId)
    .maybeSingle();
  return data ? { id: (data as any).id, title: (data as any).title } : null;
}

/**
 * Identify the single paper the query is about, or null if none is clearly
 * named. Null means "search broadly" — the default and the safe fallback.
 */
export async function detectPaperScope(
  query: string,
): Promise<PaperScope | null> {
  if (!query?.trim()) return null;

  // 1) DOI — exact.
  const { extractDoi } = await import("./db");
  const { getServiceClient } = await import("../../db/client");
  const doi = extractDoi(query);
  if (doi) {
    const { data } = await getServiceClient()
      .from("research_sources")
      .select("id,title,source_kind")
      .neq("source_kind", "artifact")
      .ilike("doi", doi)
      .limit(2);
    const papers = (data || []).filter(Boolean);
    if (papers.length === 1) {
      const p = papers[0] as any;
      logger.info({ doi, sourceId: p.id }, "paper_scope_by_doi");
      return { sourceId: p.id, title: p.title, reason: "doi" };
    }
  }

  // 2) A distinctive entity that lands on exactly one source.
  for (const entity of extractEntityCandidates(query)) {
    const ids = await sourcesContaining(entity);
    if (ids.length === 1) {
      const src = await sourceById(ids[0]!);
      if (src) {
        logger.info(
          { entity, sourceId: src.id },
          "paper_scope_by_entity",
        );
        return {
          sourceId: src.id,
          title: src.title,
          reason: "entity",
          entity,
        };
      }
    }
  }

  return null;
}
