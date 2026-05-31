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

    // Stage 1: Vector search
    const vectorResults = await this.vectorSearch(
      query,
      vectorLimit,
      filterTitle,
      matchThreshold,
    );

    if (vectorResults.length === 0) {
      logger.info("❌ No vector search results found");
      return [];
    }

    let finalResults: Document[];

    if (
      useReranking &&
      CONFIG.COHERE_API_KEY &&
      vectorResults.length > 1
    ) {
      // Stage 2: Rerank with Cohere
      finalResults = await this.rerank(query, vectorResults, finalLimit);
    } else {
      finalResults = vectorResults.slice(0, finalLimit);
      logger.info(
        `⚡ Skipping reranking, returning top ${finalResults.length} vector results`,
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
