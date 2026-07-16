/**
 * Configuration for embeddings and vector search
 *
 * Note: Supabase client is now centralized in src/db/client.ts
 * Do not create Supabase clients directly - use getServiceClient() instead.
 */
export const CONFIG = {
  EMBEDDING_PROVIDER: (process.env.EMBEDDING_PROVIDER || "openai").toLowerCase(),
  TEXT_EMBEDDING_MODEL:
    process.env.TEXT_EMBEDDING_MODEL || "text-embedding-3-small",
  EMBEDDING_DIMENSIONS: parseInt(process.env.EMBEDDING_DIMENSIONS || "1536", 10),
  // Whether to send the `dimensions` request param. It is an OpenAI feature
  // (Matryoshka truncation of text-embedding-3-*); OpenRouter does not list it
  // and native-size models like Qwen return their full dimension regardless, so
  // sending it there is at best redundant and at worst a 400. Default: on for
  // every provider except openrouter. Override with EMBEDDING_SEND_DIMENSIONS.
  EMBEDDING_SEND_DIMENSIONS:
    process.env.EMBEDDING_SEND_DIMENSIONS !== undefined
      ? process.env.EMBEDDING_SEND_DIMENSIONS === "true"
      : (process.env.EMBEDDING_PROVIDER || "openai").toLowerCase() !==
        "openrouter",
  OPENROUTER_BASE_URL:
    process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
  CHUNK_SIZE: parseInt(process.env.CHUNK_SIZE || "2000", 10),
  CHUNK_OVERLAP: parseInt(process.env.CHUNK_OVERLAP || "200", 10),
  VECTOR_SEARCH_LIMIT: parseInt(process.env.VECTOR_SEARCH_LIMIT || "20", 10),
  RERANK_FINAL_LIMIT: parseInt(process.env.RERANK_FINAL_LIMIT || "5", 10),
  USE_RERANKING: process.env.USE_RERANKING !== "false", // default true
  SIMILARITY_THRESHOLD: parseFloat(
    process.env.SIMILARITY_THRESHOLD || "0.3",
  ),
  RERANKER_SCORE_THRESHOLD: parseFloat(
    process.env.RERANKER_SCORE_THRESHOLD || "0.0",
  ),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
  COHERE_API_KEY: process.env.COHERE_API_KEY || "",
  // Opt-in LLM reranker (stage 2) for deploys without a Cohere key. When true and
  // no COHERE_API_KEY is set, the search pipeline reranks the top vector hits with
  // an LLM (reusing the existing provider keys) instead of falling through to raw
  // cosine order — which lets it demote keyword-dense-but-useless chunks such as
  // reference lists. Default false so no deploy silently gains an LLM call.
  LLM_RERANK_ENABLED: process.env.LLM_RERANK_ENABLED === "true",
} as const;
