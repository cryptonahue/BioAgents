import { Elysia } from "elysia";
import path from "path";
import { authResolver } from "../middleware/authResolver";
import { getServiceClient } from "../db/client";
import logger from "../utils/logger";

/**
 * Library Route - Paper library + per-paper grounded Q&A.
 *
 * Endpoints:
 * - GET  /api/library                 -> list ingested papers (aggregated by title)
 * - GET  /api/library/:docId          -> metadata for a single paper (DOI, size, tokens)
 * - GET  /api/library/:docId/file     -> serve the original file from disk (inline, for the viewer)
 * - POST /api/library/:docId/ask      -> grounded Q&A about one paper (RAG by default, optional full context)
 *
 * Documents are sourced from the local KNOWLEDGE_DOCS_PATH folder. The `docId`
 * is a base64url encoding of the document title (which equals the original
 * filename, e.g. "Coral Reef Microbiome.pdf").
 *
 * NOTE: the file route is intentionally readable without a bearer token so the
 * browser PDF viewer (an <iframe>) can load it (iframes cannot send the
 * Authorization header). Papers in the library are shared, non-sensitive
 * research material.
 */

const DOI_REGEX = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;

const MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function encodeDocId(title: string): string {
  return Buffer.from(title, "utf-8").toString("base64url");
}

function decodeDocId(docId: string): string | null {
  try {
    const title = Buffer.from(docId, "base64url").toString("utf-8");
    return title.length > 0 ? title : null;
  } catch {
    return null;
  }
}

function getDocsPath(): string {
  return process.env.KNOWLEDGE_DOCS_PATH || "docs";
}

/** Resolve a safe absolute path for a document title, guarding against traversal. */
function resolveDocFilePath(title: string): string | null {
  const docsPath = getDocsPath();
  const docsRoot = path.resolve(docsPath);
  // title is a basename; strip any path separators defensively.
  const safeName = path.basename(title);
  const fullPath = path.resolve(docsRoot, safeName);
  if (fullPath !== docsRoot && !fullPath.startsWith(docsRoot + path.sep)) {
    return null;
  }
  return fullPath;
}

async function getVectorSearch() {
  let vs = (globalThis as any).__knowledgeVectorSearch;
  if (!vs) {
    const { VectorSearchWithDocuments } = await import(
      "../embeddings/vectorSearchWithDocs"
    );
    vs = new VectorSearchWithDocuments();
    (globalThis as any).__knowledgeVectorSearch = vs;
  }
  return vs;
}

// ---------------------------------------------------------------------------
// Per-paper chat persistence (reuses conversations/messages via service role,
// tagged with conversations.library_doc_id so they stay out of the general
// chat sidebar). All writes use the service role, bypassing RLS.
// ---------------------------------------------------------------------------

/** Ensure the user row exists and return the (stable) conversation id for this paper. */
async function ensureLibraryConversation(
  userId: string,
  docId: string,
): Promise<string | null> {
  const sb = getServiceClient();

  // Ensure a user row exists (FK target for conversations/messages).
  try {
    await sb.from("users").upsert(
      {
        id: userId,
        username: `user_${userId.slice(0, 8)}`,
        email: `${userId}@temp.local`,
      },
      { onConflict: "id", ignoreDuplicates: true },
    );
  } catch (err) {
    logger.warn({ err, userId }, "library_ensure_user_failed");
  }

  const { data: existing, error: findErr } = await sb
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .eq("library_doc_id", docId)
    .order("created_at", { ascending: true })
    .limit(1);

  if (findErr) {
    logger.warn({ err: findErr, userId, docId }, "library_find_conversation_failed");
    return null;
  }
  if (existing && existing.length > 0) return existing[0].id as string;

  const { data: created, error: insErr } = await sb
    .from("conversations")
    .insert({ user_id: userId, library_doc_id: docId })
    .select("id")
    .single();

  if (insErr) {
    logger.warn({ err: insErr, userId, docId }, "library_create_conversation_failed");
    return null;
  }
  return created.id as string;
}

async function saveLibraryTurn(
  conversationId: string,
  userId: string,
  question: string,
  answer: string,
): Promise<void> {
  const sb = getServiceClient();
  const { error } = await sb.from("messages").insert({
    conversation_id: conversationId,
    user_id: userId,
    question,
    content: answer,
    source: "library",
  });
  if (error) logger.warn({ err: error, conversationId }, "library_save_turn_failed");
}

async function getLibraryHistory(
  userId: string,
  docId: string,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const sb = getServiceClient();
  const { data: convs } = await sb
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .eq("library_doc_id", docId)
    .order("created_at", { ascending: true })
    .limit(1);

  if (!convs || convs.length === 0) return [];

  const { data: msgs } = await sb
    .from("messages")
    .select("question, content, created_at")
    .eq("conversation_id", convs[0].id)
    .order("created_at", { ascending: true })
    .limit(200);

  const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of msgs || []) {
    if ((m as any).question) {
      turns.push({ role: "user", content: (m as any).question });
    }
    turns.push({ role: "assistant", content: (m as any).content });
  }
  return turns;
}

/** Pick an LLM provider/model for grounded answers based on available keys. */
function resolveLibraryLLM(): { providerName: string; apiKey: string; model: string } {
  const requested = (
    process.env.LIBRARY_LLM_PROVIDER ||
    process.env.CHAT_AGENT_LLM_PROVIDER ||
    ""
  ).toLowerCase();

  const keys: Record<string, string> = {
    anthropic: process.env.ANTHROPIC_API_KEY || "",
    openrouter: process.env.OPENROUTER_API_KEY || "",
    openai: process.env.OPENAI_API_KEY || "",
    google: process.env.GOOGLE_API_KEY || "",
  };

  let providerName =
    requested && keys[requested] ? requested : "";
  if (!providerName) {
    providerName =
      Object.keys(keys).find((k) => keys[k]) || "anthropic";
  }

  const defaultModels: Record<string, string> = {
    anthropic: "claude-sonnet-4-6",
    openrouter: "qwen/qwen3.6-plus",
    openai: "gpt-4o",
    google: "gemini-1.5-pro",
  };

  const model =
    process.env.LIBRARY_LLM_MODEL ||
    process.env.CHAT_AGENT_MODEL ||
    defaultModels[providerName] ||
    "claude-sonnet-4-6";

  return { providerName, apiKey: keys[providerName] || "", model };
}

export const libraryRoute = new Elysia()
  // -------------------------------------------------------------------------
  // List papers
  // -------------------------------------------------------------------------
  .get(
    "/api/library",
    async ({ set }) => {
      try {
        const vs = await getVectorSearch();
        const docs = await vs.listDocuments();
        return {
          papers: docs.map((d: any) => ({
            docId: encodeDocId(d.title),
            title: d.title,
            type: d.type,
            size: d.size,
            chunkCount: d.chunkCount,
            lastModified: d.lastModified,
          })),
        };
      } catch (error: any) {
        logger.error({ err: error }, "library_list_failed");
        set.status = 500;
        return { error: "Failed to list library", message: error?.message };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )

  // -------------------------------------------------------------------------
  // Single paper metadata
  // -------------------------------------------------------------------------
  .get(
    "/api/library/:docId",
    async ({ params, set }) => {
      const title = decodeDocId(params.docId);
      if (!title) {
        set.status = 400;
        return { error: "Invalid docId" };
      }

      try {
        const vs = await getVectorSearch();
        const chunks = await vs.getDocumentChunks(title);
        if (chunks.length === 0) {
          set.status = 404;
          return { error: "Paper not found", title };
        }

        const meta = chunks[0].metadata || {};
        const fullText = chunks.map((c: any) => c.content).join("\n\n");
        const estTokens = Math.ceil(fullText.length / 4);

        // Extract a DOI from the first portion of the text, if present.
        const doiMatch = fullText.slice(0, 20000).match(DOI_REGEX);
        const doi = doiMatch ? doiMatch[0] : null;

        const abstract = fullText.slice(0, 600).trim();

        return {
          docId: params.docId,
          title,
          type: meta.type,
          size: meta.size,
          chunkCount: chunks.length,
          charCount: fullText.length,
          estTokens,
          doi,
          doiUrl: doi ? `https://doi.org/${doi}` : null,
          abstract,
          fileUrl: `/api/library/${params.docId}/file`,
        };
      } catch (error: any) {
        logger.error({ err: error, title }, "library_metadata_failed");
        set.status = 500;
        return { error: "Failed to load paper metadata", message: error?.message };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )

  // -------------------------------------------------------------------------
  // Serve the original file (inline, for the embedded viewer)
  // -------------------------------------------------------------------------
  .get(
    "/api/library/:docId/file",
    async ({ params, set }) => {
      const title = decodeDocId(params.docId);
      if (!title) {
        set.status = 400;
        return { error: "Invalid docId" };
      }

      const filePath = resolveDocFilePath(title);
      if (!filePath) {
        set.status = 400;
        return { error: "Invalid path" };
      }

      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        logger.warn({ title, filePath }, "library_file_not_found");
        set.status = 404;
        return {
          error: "File not found on disk",
          message:
            "The paper is indexed but its source file is not available on the server.",
        };
      }

      const ext = path.extname(filePath).slice(1).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      // Allow same-origin framing so the SPA viewer can embed this response
      // (the global security middleware sets X-Frame-Options: DENY).
      return new Response(file, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `inline; filename="${encodeURIComponent(
            path.basename(filePath),
          )}"`,
          "X-Frame-Options": "SAMEORIGIN",
          "Cache-Control": "private, max-age=3600",
        },
      });
    },
    { beforeHandle: authResolver({ required: false }) },
  )

  // -------------------------------------------------------------------------
  // Grounded Q&A about a single paper
  // -------------------------------------------------------------------------
  .post(
    "/api/library/:docId/ask",
    async ({ params, body, set, request }) => {
      const title = decodeDocId(params.docId);
      if (!title) {
        set.status = 400;
        return { error: "Invalid docId" };
      }

      const {
        question,
        fullContext = false,
        history = [],
      } = (body || {}) as {
        question?: string;
        fullContext?: boolean;
        history?: Array<{ role: "user" | "assistant"; content: string }>;
      };

      if (!question || typeof question !== "string" || !question.trim()) {
        set.status = 400;
        return { error: "Missing 'question'" };
      }

      try {
        const vs = await getVectorSearch();

        const maxFullTokens = parseInt(
          process.env.LIBRARY_FULL_CONTEXT_MAX_TOKENS || "120000",
          10,
        );

        let mode: "full" | "rag" = fullContext ? "full" : "rag";
        let tooLarge = false;
        let contextText = "";
        let sources: Array<{
          index: number;
          chunkIndex: number;
          snippet: string;
        }> = [];

        if (fullContext) {
          const fullDoc = await vs.getFullDocument(title);
          if (!fullDoc) {
            set.status = 404;
            return { error: "Paper not found", title };
          }
          const estTokens = Math.ceil(fullDoc.content.length / 4);
          if (estTokens > maxFullTokens) {
            // Paper too large for the full-context window: fall back to RAG.
            tooLarge = true;
            mode = "rag";
          } else {
            contextText = fullDoc.content;
          }
        }

        if (mode === "rag") {
          // Scoped to a single paper: take the best top-k chunks regardless of
          // absolute similarity (the global threshold drops cross-lingual
          // queries, e.g. a Spanish question against an English paper).
          const ragMinSimilarity = parseFloat(
            process.env.LIBRARY_RAG_MIN_SIMILARITY || "0",
          );
          const results = await vs.search(question, {
            filterTitle: title,
            matchThreshold: ragMinSimilarity,
            finalLimit: parseInt(
              process.env.LIBRARY_RAG_CHUNKS || "8",
              10,
            ),
          });

          if (results.length === 0) {
            return {
              docId: params.docId,
              title,
              mode,
              tooLarge,
              answer:
                "No encontré secciones relevantes en este paper para responder esa pregunta.",
              sources: [],
            };
          }

          sources = results.map((r: any, i: number) => ({
            index: i + 1,
            chunkIndex: Number(r.metadata?.chunkIndex ?? i),
            snippet: r.content.slice(0, 240).trim(),
          }));

          contextText = results
            .map(
              (r: any, i: number) =>
                `[${i + 1}] (fragmento ${Number(r.metadata?.chunkIndex ?? i)})\n${r.content}`,
            )
            .join("\n\n---\n\n");
        }

        // Build grounded prompt.
        const citationGuidance =
          mode === "rag"
            ? "Cada fragmento está numerado como [n]. Cuando uses información de un fragmento, cítalo inline con su número, por ejemplo [1]."
            : "Cuando hagas una afirmación basada en el paper, indícalo claramente (por ejemplo, citando la sección).";

        const systemInstruction = `Eres un asistente de investigación que responde preguntas EXCLUSIVAMENTE sobre un único paper científico titulado "${title}".

Reglas estrictas:
- Usa SOLO el contenido del paper provisto como fuente de verdad.
- Si la respuesta no está contenida en el contenido provisto, dilo explícitamente ("No encuentro esa información en este paper.") y no inventes.
- No uses conocimiento externo ni inventes citas, DOIs ni referencias.
- Responde en el mismo idioma que la pregunta del usuario.
- Sé conciso y preciso.
- ${citationGuidance}`;

        const userContent = `TÍTULO DEL PAPER: ${title}

CONTENIDO DEL PAPER (${mode === "full" ? "texto completo" : "fragmentos recuperados"}):
${contextText}

PREGUNTA: ${question.trim()}`;

        const { LLM } = await import("../llm/provider");
        const { providerName, apiKey, model } = resolveLibraryLLM();

        if (!apiKey) {
          set.status = 503;
          return {
            error: "LLM not configured",
            message:
              "No hay API key configurada para el proveedor de LLM (ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY).",
          };
        }

        const llm = new LLM({ name: providerName as any, apiKey });

        const priorHistory = Array.isArray(history)
          ? history
              .filter(
                (m) =>
                  m &&
                  (m.role === "user" || m.role === "assistant") &&
                  typeof m.content === "string",
              )
              .slice(-6)
              .map((m) => ({
                role: m.role,
                content: m.content.slice(0, 4000),
              }))
          : [];

        const response = await llm.createChatCompletion({
          model,
          systemInstruction,
          messages: [
            ...priorHistory,
            { role: "user", content: userContent },
          ],
          maxTokens: parseInt(process.env.LIBRARY_MAX_TOKENS || "2048", 10),
          temperature: 0.2,
        });

        // Persist the exchange (best-effort) so it survives reloads.
        const userId = (request as any).auth?.userId as string | undefined;
        if (userId) {
          try {
            const conversationId = await ensureLibraryConversation(
              userId,
              params.docId,
            );
            if (conversationId) {
              await saveLibraryTurn(
                conversationId,
                userId,
                question.trim(),
                response.content,
              );
            }
          } catch (err) {
            logger.warn({ err, title }, "library_persist_failed");
          }
        }

        logger.info(
          {
            title,
            mode,
            tooLarge,
            provider: providerName,
            model,
            sources: sources.length,
          },
          "library_ask_completed",
        );

        return {
          docId: params.docId,
          title,
          mode,
          tooLarge,
          answer: response.content,
          sources,
        };
      } catch (error: any) {
        logger.error({ err: error, title }, "library_ask_failed");
        set.status = 500;
        return { error: "Failed to answer", message: error?.message };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )

  // -------------------------------------------------------------------------
  // Persisted chat history for a paper (per user)
  // -------------------------------------------------------------------------
  .get(
    "/api/library/:docId/history",
    async ({ params, request, set }) => {
      const title = decodeDocId(params.docId);
      if (!title) {
        set.status = 400;
        return { error: "Invalid docId" };
      }

      const userId = (request as any).auth?.userId as string | undefined;
      if (!userId) return { turns: [] };

      try {
        const turns = await getLibraryHistory(userId, params.docId);
        return { turns };
      } catch (err) {
        logger.warn({ err, title }, "library_history_failed");
        return { turns: [] };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  );

export default libraryRoute;
