-- Optional: use with qwen/qwen3-embedding-4b on OpenRouter (2560 dimensions).
-- WARNING: drops existing indexed documents. Re-index docs/ after applying.
--
-- In .env set:
--   EMBEDDING_PROVIDER=openrouter
--   TEXT_EMBEDDING_MODEL=qwen/qwen3-embedding-4b
--   EMBEDDING_DIMENSIONS=2560

DROP TABLE IF EXISTS documents CASCADE;
DROP FUNCTION IF EXISTS match_documents CASCADE;

CREATE TABLE documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  embedding vector(2560),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX ON documents USING hnsw (embedding vector_cosine_ops);

CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(2560),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  title text,
  content text,
  metadata jsonb,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.title,
    d.content,
    d.metadata,
    1 - (d.embedding <=> query_embedding) as similarity
  FROM documents d
  WHERE 1 - (d.embedding <=> query_embedding) > match_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
