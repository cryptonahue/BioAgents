// lib/vectorSearch.ts
import { CohereClient } from "cohere-ai";
import { getServiceClient } from "../db/client";
import logger from "../utils/logger";
import { SimpleCache } from "../utils/cache";
import { CONFIG } from "./config";
import { createEmbeddingProvider, type EmbeddingProvider } from "./provider";

// Use service client to bypass RLS for document operations
const supabase = getServiceClient();

const cohere = new CohereClient({
  token: CONFIG.COHERE_API_KEY,
});

export interface Document {
  id: string;
  title: string;
  content: string;
  metadata?: any;
  similarity?: number;
  relevanceScore?: number;
}

// Words too generic to discriminate a paper — dropped from the lexical query so
// it keys on the terms that matter ("antifungal", "ciguatoxin", a species name).
const KEYWORD_STOPWORDS = new Set([
  "the","and","for","from","with","what","which","that","this","these","those",
  "are","was","were","how","does","did","your","have","has","had","can","not",
  "all","any","its","into","near","over","onto","upon","about","across","among",
  "between","during","under","within","their","them","they","there","other",
  "compounds","compound","organisms","organism","evidence","level","levels",
  "study","studies","data","paper","papers","library","specific","reported",
  "report","using","described","describe","activity","potency","source","sources",
  "against","show","shows","showed","some","most","more","also","such","each",
]);

/** Escape ilike wildcards so a term is matched literally (mirrors db.ts). */
function escapeIlike(value: string): string {
  return value.replace(/[%_\\]/g, (m) => `\\${m}`);
}

/** The query's distinctive lexical terms — alphanumeric, ≥4 chars, non-stopword. */
function extractKeywordTerms(query: string): string[] {
  return [
    ...new Set(
      (query || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .map((w) => w.trim())
        .filter((w) => w.length >= 4 && !KEYWORD_STOPWORDS.has(w)),
    ),
  ].slice(0, 12);
}

/**
 * Reciprocal Rank Fusion — the standard way to blend two ranked lists (semantic
 * + lexical) without a shared score. A doc's fused score is Σ 1/(k + rank) over
 * every list it appears in, so a doc ranked well by EITHER retriever rises, and
 * one ranked by BOTH rises most. Deduplicated by id (falling back to title).
 */
function reciprocalRankFusion(lists: Document[][], k = 60): Document[] {
  const scores = new Map<string, { doc: Document; score: number }>();
  for (const list of lists) {
    list.forEach((doc, i) => {
      const key = doc.id || `${doc.title}:${(doc.content || "").slice(0, 60)}`;
      const add = 1 / (k + i + 1);
      const prev = scores.get(key);
      if (prev) prev.score += add;
      else scores.set(key, { doc, score: add });
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((x) => x.doc);
}

export class VectorSearchWithReranker {
  private embeddingProvider: EmbeddingProvider;
  private cache: SimpleCache<Document[]>;

  constructor() {
    this.embeddingProvider = createEmbeddingProvider();
    this.cache = new SimpleCache<Document[]>();
    logger.info(
      `🚀 Initialized with ${CONFIG.EMBEDDING_PROVIDER} provider using ${CONFIG.TEXT_EMBEDDING_MODEL}`,
    );
  }

  // Add document to vector store
  async addDocument(
    title: string,
    content: string,
    metadata = {},
  ): Promise<Document> {
    logger.info(`📝 Adding document: ${title}`);

    const embedding = await this.embeddingProvider.generateEmbedding(
      `${title}\n${content}`,
    );

    const { data, error } = await supabase
      .from("documents")
      .insert({
        title,
        content,
        metadata,
        embedding,
      })
      .select()
      .single();

    if (error) throw error;

    logger.info(`✅ Document added with ID: ${data.id}`);
    return data;
  }

  // Vector search (first stage)
  // When filterTitle is provided, results are scoped to a single document.
  // matchThreshold overrides the global similarity threshold (useful for
  // per-document RAG, where we want the best top-k chunks regardless of the
  // absolute score — e.g. cross-lingual queries against an English paper).
  async vectorSearch(
    query: string,
    limit = 20,
    filterTitle?: string,
    matchThreshold?: number,
  ): Promise<Document[]> {
    const threshold =
      matchThreshold != null ? matchThreshold : CONFIG.SIMILARITY_THRESHOLD;

    logger.info(
      `🔍 Vector search for: "${query}" (limit: ${limit}, threshold: ${threshold}${filterTitle ? `, title: "${filterTitle}"` : ""})`,
    );

    const queryEmbedding =
      await this.embeddingProvider.generateEmbedding(query);

    let data: any[] | null = null;

    if (filterTitle) {
      // Preferred path: filtered RPC (added in 20260531120000 migration).
      const filtered = await supabase.rpc("match_documents_filtered", {
        query_embedding: queryEmbedding,
        match_threshold: threshold,
        match_count: limit,
        filter_title: filterTitle,
      });

      if (filtered.error) {
        // Fallback for databases where the migration has not run yet:
        // query unfiltered, then filter by title in-process.
        logger.warn(
          `match_documents_filtered unavailable (${filtered.error.message}); falling back to match_documents + in-memory title filter`,
        );
        const fallback = await supabase.rpc("match_documents", {
          query_embedding: queryEmbedding,
          match_threshold: threshold,
          match_count: Math.max(limit * 20, 200),
        });
        if (fallback.error) throw fallback.error;
        data = (fallback.data || [])
          .filter((doc: any) => doc.title === filterTitle)
          .slice(0, limit);
      } else {
        data = filtered.data;
      }
    } else {
      const { data: unfiltered, error } = await supabase.rpc(
        "match_documents",
        {
          query_embedding: queryEmbedding,
          match_threshold: threshold,
          match_count: limit,
        },
      );
      if (error) throw error;
      data = unfiltered;
    }

    const results = (data || []).map((doc: any) => ({
      id: doc.id,
      title: doc.title,
      content: doc.content,
      metadata: doc.metadata,
      similarity: doc.similarity,
    }));

    logger.info(`📊 Vector search returned ${results.length} results`);
    return results;
  }

  /**
   * LEXICAL half of hybrid retrieval. Semantic search compares meaning, which
   * rewards a chunk whose whole topic is the query — and misses a paper whose
   * relevant finding is one buried sentence ("Anthoteibinene I and J were the
   * only compounds with antifungal activity") inside pages of structure
   * elucidation. A keyword search finds that sentence by the word, and catches
   * exact names (compounds, species, genes) an embedding blurs.
   *
   * Deliberately simple: ILIKE over title + content on the query's distinctive
   * terms, ranked by how many terms a chunk hits. No index (fine for a small
   * library; add an FTS index for scale). Its job is only to put missed
   * candidates into the pool — the reranker then judges them.
   */
  async keywordSearch(
    query: string,
    limit = 20,
    filterTitle?: string,
  ): Promise<Document[]> {
    const terms = extractKeywordTerms(query);
    if (terms.length === 0) return [];

    // Search PER TERM, not in one big .or([antifungal,marine,extracts,…]). A
    // single .or() with .limit(N) and no ORDER lets a COMMON term (marine —
    // thousands of chunks) flood the N rows fetched, so a RARE discriminative
    // term (antifungal — dozens of chunks) never enters the pool and the one
    // paper we wanted is dropped before ranking ever runs. Per-term fetch
    // guarantees the rare term's chunks are pulled; an IDF weight (from each
    // term's exact match count) then makes those rare hits outrank chunks that
    // only match noise words. `%` IS the ilike wildcard inside a PostgREST
    // .or() here — escapeIlike guards any %, _ or \ in a term.
    const PER_TERM = Math.max(limit * 4, 80);
    const byId = new Map<string, { doc: Document; terms: Set<string> }>();
    const weight = new Map<string, number>();

    await Promise.all(
      terms.map(async (t) => {
        const pat = escapeIlike(t);
        let q = supabase
          .from("documents")
          .select("id,title,content,metadata", { count: "exact" })
          .or(`content.ilike.%${pat}%,title.ilike.%${pat}%`)
          .limit(PER_TERM);
        if (filterTitle) q = q.eq("title", filterTitle);

        const { data, count, error } = await q;
        if (error) {
          logger.warn(`keyword term "${t}" failed (${error.message}); skipping it`);
          return;
        }
        const rows = data || [];
        // IDF: a term matching few chunks is discriminative → weight it high; a
        // term matching many is noise → weight it low. `count` is the TOTAL
        // match count (unaffected by .limit), so the weight reflects true
        // rarity. 1/sqrt(df) strongly favors rare terms without letting a single
        // ultra-rare match dwarf everything.
        weight.set(t, 1 / Math.sqrt(Math.max(count ?? rows.length, 1)));
        for (const doc of rows) {
          const entry = byId.get(doc.id) ?? {
            doc: {
              id: doc.id,
              title: doc.title,
              content: doc.content,
              metadata: doc.metadata,
            },
            terms: new Set<string>(),
          };
          entry.terms.add(t);
          byId.set(doc.id, entry);
        }
      }),
    );

    const scoreOf = (hit: { terms: Set<string> }) =>
      [...hit.terms].reduce((s, t) => s + (weight.get(t) ?? 0), 0);

    // Round-robin across PAPERS, not a flat top-`limit`. A flat cut lets one
    // paper with many keyword hits (a review dense in common words) take every
    // slot, starving a paper whose single relevant chunk matched the rare term.
    // Group chunks by paper, order papers by their best chunk, then take one
    // chunk from each paper before any paper's second — so the pool spans as
    // many papers as possible. The corpus and the reranker both reason over
    // papers, so breadth here is what lets a buried finding survive.
    const byPaper = new Map<string, { doc: Document; score: number }[]>();
    for (const hit of byId.values()) {
      const key = hit.doc.title ?? hit.doc.id;
      const arr = byPaper.get(key) ?? [];
      arr.push({ doc: hit.doc, score: scoreOf(hit) });
      byPaper.set(key, arr);
    }
    const papers = [...byPaper.values()].map((arr) =>
      arr.sort((a, b) => b.score - a.score),
    );
    papers.sort((a, b) => b[0].score - a[0].score);

    const scored: Document[] = [];
    for (let rank = 0; scored.length < limit; rank++) {
      let advanced = false;
      for (const arr of papers) {
        if (rank < arr.length) {
          scored.push(arr[rank].doc);
          advanced = true;
          if (scored.length >= limit) break;
        }
      }
      if (!advanced) break;
    }

    logger.info(
      `🔤 Keyword search matched ${byId.size} chunks across ${papers.length} papers on [${terms.join(", ")}] → top ${scored.length}`,
    );
    return scored;
  }

  // Rerank results using Cohere (second stage)
  async rerank(
    query: string,
    documents: Document[],
    topN = 5,
  ): Promise<Document[]> {
    if (documents.length === 0) return [];

    logger.info(
      `🎯 Reranking ${documents.length} documents, returning top ${topN}`,
    );

    const response = await cohere.rerank({
      model: "rerank-english-v3.0",
      query: query,
      documents: documents.map((doc) => ({
        text: `${doc.title}\n${doc.content}`,
      })),
      topN: Math.min(topN, documents.length),
      returnDocuments: true,
    });

    const rerankedResults = response.results
      .map((result) => ({
        ...documents[result.index],
        relevanceScore: result.relevanceScore,
      }))
      .filter((doc) => doc.relevanceScore >= CONFIG.RERANKER_SCORE_THRESHOLD);

    logger.info(
      `✨ Reranking complete, top score: ${rerankedResults[0]?.relevanceScore?.toFixed(3)}, filtered to ${rerankedResults.length} results (threshold: ${CONFIG.RERANKER_SCORE_THRESHOLD})`,
    );

    return rerankedResults as Document[];
  }

  // Complete search pipeline
  async search(
    query: string,
    options: {
      vectorLimit?: number;
      finalLimit?: number;
      useReranking?: boolean;
      filterTitle?: string;
      matchThreshold?: number;
    } = {},
  ): Promise<Document[]> {
    const {
      vectorLimit = CONFIG.VECTOR_SEARCH_LIMIT,
      finalLimit = CONFIG.RERANK_FINAL_LIMIT,
      useReranking = CONFIG.USE_RERANKING,
      filterTitle,
      matchThreshold,
    } = options;

    const cacheKey = `search_${query}_${vectorLimit}_${finalLimit}_${useReranking}_${filterTitle || ""}_${matchThreshold ?? ""}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    logger.info(`🚀 Starting search pipeline for: "${query}"`);
    const startTime = Date.now();

    // Stage 1: hybrid retrieval — semantic (vector) AND lexical (keyword) in
    // parallel, fused by Reciprocal Rank Fusion. The lexical half catches papers
    // whose relevant finding is a buried sentence the embedding blurs past.
    const [vectorResults, keywordResults] = await Promise.all([
      this.vectorSearch(query, vectorLimit, filterTitle, matchThreshold),
      CONFIG.USE_KEYWORD_SEARCH
        ? this.keywordSearch(query, vectorLimit, filterTitle)
        : Promise.resolve([] as Document[]),
    ]);

    if (vectorResults.length === 0 && keywordResults.length === 0) {
      logger.info("❌ No search results found (vector or keyword)");
      return [];
    }

    const candidates = reciprocalRankFusion([vectorResults, keywordResults]).slice(
      0,
      Math.max(vectorLimit, finalLimit),
    );
    logger.info(
      `🔀 Hybrid pool: ${vectorResults.length} vector + ${keywordResults.length} keyword → ${candidates.length} fused`,
    );

    let finalResults: Document[];

    const canRerank = useReranking && candidates.length > 1;
    if (canRerank && CONFIG.COHERE_API_KEY) {
      // Stage 2: Rerank with Cohere (preferred when a key is configured)
      finalResults = await this.rerank(query, candidates, finalLimit);
    } else if (canRerank && CONFIG.LLM_RERANK_ENABLED) {
      // Stage 2 fallback: rerank with an LLM reusing existing provider keys. If
      // it is unavailable or judges nothing relevant it returns null, and we use
      // the fused order rather than blank the results.
      const { llmRerank } = await import("./llmReranker");
      const llmRanked = await llmRerank(query, candidates, finalLimit);
      if (llmRanked && llmRanked.length > 0) {
        finalResults = llmRanked;
        logger.info(
          `🧠 LLM rerank kept ${finalResults.length} of ${candidates.length}`,
        );
      } else {
        finalResults = candidates.slice(0, finalLimit);
        logger.info(
          `⚡ LLM rerank unavailable/empty, fused top ${finalResults.length}`,
        );
      }
    } else {
      finalResults = candidates.slice(0, finalLimit);
      logger.info(
        `⚡ Skipping reranking, returning fused top ${finalResults.length}`,
      );
    }

    const totalTime = Date.now() - startTime;
    logger.info(
      `🏁 Search completed in ${totalTime}ms, returned ${finalResults.length} results`,
    );

    this.cache.set(cacheKey, finalResults, 300000); // 5min cache
    return finalResults;
  }

  // Batch add documents
  async addDocuments(
    documents: Array<{
      title: string;
      content: string;
      metadata?: any;
    }>,
  ): Promise<Document[]> {
    logger.info(`📚 Adding ${documents.length} documents in batch`);

    const documentsWithEmbeddings = await Promise.all(
      documents.map(async (doc, index) => {
        logger.info(
          `🔄 Processing document ${index + 1}/${documents.length}: ${doc.title}`,
        );
        try {
          const embedding = await this.embeddingProvider.generateEmbedding(
            `${doc.title}\n${doc.content}`,
          );
          return {
            ...doc,
            embedding,
          };
        } catch (embeddingError: any) {
          logger.error(
            `Failed to generate embedding for ${doc.title}: ${embeddingError.message}`,
          );
          throw new Error(
            `Embedding generation failed for ${doc.title}: ${embeddingError.message}`,
          );
        }
      }),
    );

    const { data, error } = await supabase
      .from("documents")
      .insert(documentsWithEmbeddings)
      .select();

    if (error) throw error;

    logger.info(`✅ Successfully added ${data.length} documents`);
    return data;
  }

  // Get document stats
  async getStats() {
    const { count, error } = await supabase
      .from("documents")
      .select("*", { count: "exact", head: true });

    if (error) throw error;

    return {
      totalDocuments: count,
      embeddingProvider: CONFIG.EMBEDDING_PROVIDER,
      embeddingModel: CONFIG.TEXT_EMBEDDING_MODEL,
      embeddingDimensions: CONFIG.EMBEDDING_DIMENSIONS,
    };
  }
}
