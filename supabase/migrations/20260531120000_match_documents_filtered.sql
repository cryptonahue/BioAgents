-- Vector search with an optional title filter.
-- Mirrors public.match_documents but lets callers scope results to a single
-- document (by title) for per-paper Q&A in the library feature.

CREATE OR REPLACE FUNCTION "public"."match_documents_filtered"(
  "query_embedding" "public"."vector",
  "match_threshold" double precision DEFAULT 0.3,
  "match_count" integer DEFAULT 10,
  "filter_title" "text" DEFAULT NULL
) RETURNS TABLE(
  "id" "uuid",
  "title" "text",
  "content" "text",
  "metadata" "jsonb",
  "similarity" double precision
)
    LANGUAGE "plpgsql"
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
  WHERE (filter_title IS NULL OR d.title = filter_title)
    AND 1 - (d.embedding <=> query_embedding) > match_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

ALTER FUNCTION "public"."match_documents_filtered"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter_title" "text") OWNER TO "postgres";

GRANT ALL ON FUNCTION "public"."match_documents_filtered"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter_title" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."match_documents_filtered"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter_title" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_documents_filtered"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "filter_title" "text") TO "service_role";
