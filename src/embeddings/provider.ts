import OpenAI from "openai";
import { CONFIG } from "./config";

export interface EmbeddingProvider {
  generateEmbedding(text: string): Promise<number[]>;
  getDimensions(): number;
}

abstract class BaseOpenAIEmbeddingProvider implements EmbeddingProvider {
  protected abstract createClient(): OpenAI;

  private client: OpenAI | null = null;

  protected getClient(): OpenAI {
    if (!this.client) {
      this.client = this.createClient();
    }
    return this.client;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const response = await this.getClient().embeddings.create({
      model: CONFIG.TEXT_EMBEDDING_MODEL,
      input: text,
      encoding_format: "float",
      ...(CONFIG.EMBEDDING_DIMENSIONS
        ? { dimensions: CONFIG.EMBEDDING_DIMENSIONS }
        : {}),
    });

    return this.validateEmbedding(response.data[0]?.embedding ?? []);
  }

  getDimensions(): number {
    return CONFIG.EMBEDDING_DIMENSIONS;
  }

  private validateEmbedding(embedding: number[]): number[] {
    if (embedding.length === 0) {
      throw new Error("Embedding provider returned an empty vector");
    }
    if (embedding.length !== CONFIG.EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding dimension mismatch: expected ${CONFIG.EMBEDDING_DIMENSIONS}, got ${embedding.length}. ` +
          "Update EMBEDDING_DIMENSIONS and the Supabase documents.embedding column to match your model.",
      );
    }
    return embedding;
  }
}

export class OpenAIEmbeddingProvider extends BaseOpenAIEmbeddingProvider {
  protected createClient(): OpenAI {
    if (!CONFIG.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    return new OpenAI({
      apiKey: CONFIG.OPENAI_API_KEY,
    });
  }
}

/**
 * OpenRouter exposes an OpenAI-compatible /embeddings API.
 * @see https://openrouter.ai/docs/api/reference/embeddings
 */
export class OpenRouterEmbeddingProvider extends BaseOpenAIEmbeddingProvider {
  protected createClient(): OpenAI {
    if (!CONFIG.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY is not configured");
    }

    return new OpenAI({
      apiKey: CONFIG.OPENROUTER_API_KEY,
      baseURL: CONFIG.OPENROUTER_BASE_URL,
    });
  }
}

export function createEmbeddingProvider(): EmbeddingProvider {
  switch (CONFIG.EMBEDDING_PROVIDER) {
    case "openrouter":
      return new OpenRouterEmbeddingProvider();
    case "openai":
    default:
      return new OpenAIEmbeddingProvider();
  }
}
