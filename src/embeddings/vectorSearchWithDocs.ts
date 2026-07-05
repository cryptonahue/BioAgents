// lib/vectorSearchWithDocs.ts
import { getServiceClient } from "../db/client";
import logger from "../utils/logger";
import { DocumentProcessor, type DocumentIdentity } from "./documentProcessor";
import { TextChunker } from "./textChunker";
import { VectorSearchWithReranker } from "./vectorSearch";

// Use service client to bypass RLS for document operations
const supabase = getServiceClient();

function defaultIgnorePatterns(): string[] {
  return (process.env.KNOWLEDGE_INGEST_IGNORE || "research-brain.md")
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

export class VectorSearchWithDocuments extends VectorSearchWithReranker {
  private documentProcessor = new DocumentProcessor();
  private textChunker = new TextChunker();

  private async loadExistingDocumentIdentity(): Promise<{
    titles: Set<string>;
    filePaths: Set<string>;
    contentHashes: Set<string>;
  }> {
    const titles = new Set<string>();
    const filePaths = new Set<string>();
    const contentHashes = new Set<string>();

    const { data: sources, error: sourcesError } = await supabase
      .from("research_sources")
      .select("title, file_path, content_hash")
      .limit(50000);
    if (sourcesError) {
      logger.warn(
        { err: sourcesError },
        "research_sources_identity_load_failed",
      );
    }

    for (const source of sources || []) {
      if ((source as any).title) titles.add((source as any).title);
      if ((source as any).file_path) filePaths.add((source as any).file_path);
      if ((source as any).content_hash) {
        contentHashes.add((source as any).content_hash);
      }
    }

    const { data: docs, error: docsError } = await supabase
      .from("documents")
      .select("title, metadata")
      .limit(50000);
    if (docsError) {
      logger.warn({ err: docsError }, "documents_identity_load_failed");
    }

    for (const doc of docs || []) {
      const title = (doc as any).title;
      const meta = ((doc as any).metadata || {}) as any;
      if (title) titles.add(title);
      if (meta.filePath) filePaths.add(meta.filePath);
      if (meta.contentHash) contentHashes.add(meta.contentHash);
    }

    return { titles, filePaths, contentHashes };
  }

  private isKnownDocument(
    doc: Pick<DocumentIdentity, "title" | "filePath" | "contentHash">,
    existing: {
      titles: Set<string>;
      filePaths: Set<string>;
      contentHashes: Set<string>;
    },
  ): boolean {
    return (
      existing.titles.has(doc.title) ||
      existing.filePaths.has(doc.filePath) ||
      existing.contentHashes.has(doc.contentHash)
    );
  }

  async dryRunIngestDirectory(
    dirPath: string,
    options: {
      force?: boolean;
      ignorePatterns?: string[];
      checkExisting?: boolean;
    } = {},
  ): Promise<{
    totalFiles: number;
    wouldProcess: number;
    wouldSkipExisting: number;
    files: Array<{
      path: string;
      title: string;
      size: number;
      type: string;
      status: "would_process" | "would_skip_existing";
      reason?: string;
    }>;
  }> {
    const ignorePatterns = options.ignorePatterns ?? defaultIgnorePatterns();
    const files = await this.documentProcessor.listSupportedFiles(dirPath, {
      ignorePatterns,
    });
    const existing =
      options.checkExisting === false
        ? {
            titles: new Set<string>(),
            filePaths: new Set<string>(),
            contentHashes: new Set<string>(),
          }
        : await this.loadExistingDocumentIdentity();

    const report: Array<{
      path: string;
      title: string;
      size: number;
      type: string;
      status: "would_process" | "would_skip_existing";
      reason?: string;
    }> = [];

    for (const filePath of files) {
      const identity = await this.documentProcessor.getFileIdentity(filePath);
      if (!identity) continue;
      const known = !options.force && this.isKnownDocument(identity, existing);
      report.push({
        path: filePath,
        title: identity.title,
        size: identity.size,
        type: identity.type,
        status: known ? "would_skip_existing" : "would_process",
        reason: known
          ? "matched existing title, path, or content hash"
          : undefined,
      });
    }

    return {
      totalFiles: report.length,
      wouldProcess: report.filter((file) => file.status === "would_process")
        .length,
      wouldSkipExisting: report.filter(
        (file) => file.status === "would_skip_existing",
      ).length,
      files: report,
    };
  }

  private async addChunkBatchForDocument(
    chunks: Array<{ title: string; content: string; metadata?: any }>,
  ) {
    const insertedChunks: Array<{
      id: string;
      title: string;
      content: string;
      metadata?: any;
    }> = [];

    const batchSize =
      parseInt(process.env.KNOWLEDGE_INGEST_BATCH_SIZE || "", 10) || 50;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      logger.info(
        `   - Adding chunk batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(chunks.length / batchSize)} (${batch.length} chunks)`,
      );
      const inserted = await this.addDocuments(batch);
      insertedChunks.push(...inserted);
    }

    return insertedChunks;
  }

  private async createIngestionRun(
    docsPath: string,
    metadata: Record<string, unknown>,
  ): Promise<string | null> {
    try {
      const { data, error } = await supabase
        .from("research_ingestion_runs")
        .insert({
          docs_path: docsPath,
          status: "running",
          metadata,
        })
        .select("id")
        .single();
      if (error) throw error;
      return (data as any).id as string;
    } catch (error) {
      logger.warn({ err: error, docsPath }, "ingestion_run_create_failed");
      return null;
    }
  }

  private async updateIngestionRun(
    runId: string | null,
    patch: Record<string, unknown>,
  ): Promise<void> {
    if (!runId) return;
    try {
      const { error } = await supabase
        .from("research_ingestion_runs")
        .update(patch)
        .eq("id", runId);
      if (error) throw error;
    } catch (error) {
      logger.warn({ err: error, runId }, "ingestion_run_update_failed");
    }
  }

  private async finishIngestionRun(
    runId: string | null,
    params: {
      status: string;
      totalFiles: number;
      processedFiles: number;
      skippedFiles: number;
      failedFiles: number;
      error?: string;
    },
  ): Promise<void> {
    await this.updateIngestionRun(runId, {
      status: params.status,
      finished_at: new Date().toISOString(),
      total_files: params.totalFiles,
      processed_files: params.processedFiles,
      skipped_files: params.skippedFiles,
      failed_files: params.failedFiles,
      error: params.error || null,
    });
  }

  /**
   * Scans a directory on startup, compares its contents with documents
   * already in the database (by title), and loads only the new ones.
   * @param dirPath The path to the directory containing documents.
   */
  async loadDocsOnStartup(dirPath: string) {
    await this.ingestDirectory(dirPath, {
      registerExisting:
        process.env.RESEARCH_BRAIN_BACKFILL_EXISTING !== "false",
      extractBioprospecting: process.env.BIOPROSPECTING_AUTO_EXTRACT === "true",
    });
  }

  async ingestDirectory(
    dirPath: string,
    options: {
      force?: boolean;
      registerExisting?: boolean;
      extractBioprospecting?: boolean;
      ignorePatterns?: string[];
    } = {},
  ): Promise<{
    runId: string | null;
    totalFiles: number;
    processedFiles: number;
    skippedFiles: number;
    failedFiles: number;
  }> {
    logger.info(`🚀 Starting document load for directory: ${dirPath}`);
    const startTime = Date.now();
    const runId = await this.createIngestionRun(dirPath, {
      force: !!options.force,
      extractBioprospecting: !!options.extractBioprospecting,
    });

    const existing = await this.loadExistingDocumentIdentity();
    logger.info(
      {
        titles: existing.titles.size,
        filePaths: existing.filePaths.size,
        contentHashes: existing.contentHashes.size,
      },
      "knowledge_existing_document_identity_loaded",
    );

    const ignorePatterns = options.ignorePatterns ?? defaultIgnorePatterns();
    const files = await this.documentProcessor.listSupportedFiles(dirPath, {
      ignorePatterns,
    });
    if (files.length === 0) {
      logger.info("📂 No local documents found in the specified directory.");
      await this.finishIngestionRun(runId, {
        status: "completed",
        totalFiles: 0,
        processedFiles: 0,
        skippedFiles: 0,
        failedFiles: 0,
      });
      return {
        runId,
        totalFiles: 0,
        processedFiles: 0,
        skippedFiles: 0,
        failedFiles: 0,
      };
    }

    logger.info(`📂 Found ${files.length} local files to check.`);

    let processedFiles = 0;
    let skippedFiles = 0;
    let failedFiles = 0;

    await this.updateIngestionRun(runId, {
      total_files: files.length,
    });

    for (const filePath of files) {
      try {
        const identity = await this.documentProcessor.getFileIdentity(filePath);
        if (!identity) {
          skippedFiles++;
          await this.updateIngestionRun(runId, {
            skipped_files: skippedFiles,
          });
          continue;
        }

        if (!options.force && this.isKnownDocument(identity, existing)) {
          skippedFiles++;
          logger.info(`⏭️  Skipping existing document: ${identity.title}`);
          await this.updateIngestionRun(runId, {
            skipped_files: skippedFiles,
          });
          continue;
        }

        const doc = await this.documentProcessor.processFile(filePath);
        if (!doc) {
          skippedFiles++;
          await this.updateIngestionRun(runId, {
            skipped_files: skippedFiles,
          });
          continue;
        }

        const chunks = this.textChunker.chunkDocument(doc);
        if (chunks.length === 0) {
          logger.warn(`⚠️  Document "${doc.title}" produced 0 chunks!`);
          failedFiles++;
          await this.updateIngestionRun(runId, {
            failed_files: failedFiles,
          });
          continue;
        } else {
          logger.info(`   - Chunked "${doc.title}": ${chunks.length} chunk(s)`);
        }

        const insertedChunks = await this.addChunkBatchForDocument(
          chunks.map((chunk) => ({
            title: chunk.title,
            content: chunk.content,
            metadata: chunk.metadata,
          })),
        );

        const source =
          await this.registerInsertedChunksWithResearchBrain(insertedChunks);
        if (options.extractBioprospecting && source?.id) {
          const { extractBioprospectingFactsForSource } =
            await import("../services/researchBrain");
          await extractBioprospectingFactsForSource(source.id);
        }

        processedFiles++;
        existing.titles.add(doc.title);
        existing.filePaths.add(doc.metadata.filePath);
        existing.contentHashes.add(doc.metadata.contentHash);
        await this.updateIngestionRun(runId, {
          processed_files: processedFiles,
        });
      } catch (e: any) {
        failedFiles++;
        logger.error(
          { err: e, filePath },
          "knowledge_document_ingestion_failed",
        );
        await this.updateIngestionRun(runId, {
          failed_files: failedFiles,
        });
      }
    }

    const duration = Date.now() - startTime;
    logger.info(`✅ Document loading complete in ${duration}ms.`);
    logger.info(
      `   Summary: Processed ${processedFiles}. Skipped ${skippedFiles}. Failed ${failedFiles}.`,
    );

    if (options.registerExisting) {
      await this.registerExistingDocumentsWithResearchBrain();
    }

    await this.finishIngestionRun(runId, {
      status: failedFiles > 0 ? "completed_with_errors" : "completed",
      totalFiles: files.length,
      processedFiles,
      skippedFiles,
      failedFiles,
    });

    return {
      runId,
      totalFiles: files.length,
      processedFiles,
      skippedFiles,
      failedFiles,
    };
  }

  /**
   * Lists every distinct document (paper) in the store, aggregated by title.
   * Returns lightweight metadata suitable for a library listing.
   */
  async listDocuments(): Promise<
    Array<{
      title: string;
      chunkCount: number;
      type?: string;
      size?: number;
      filePath?: string;
      lastModified?: string;
    }>
  > {
    const { data, error } = await supabase
      .from("documents")
      .select("title, metadata")
      .limit(50000);

    if (error) throw error;

    const byTitle = new Map<
      string,
      {
        title: string;
        chunkCount: number;
        type?: string;
        size?: number;
        filePath?: string;
        lastModified?: string;
      }
    >();

    for (const row of data || []) {
      const title = (row as any).title as string;
      const meta = ((row as any).metadata || {}) as any;
      const existing = byTitle.get(title);
      if (existing) {
        existing.chunkCount += 1;
      } else {
        byTitle.set(title, {
          title,
          chunkCount: 1,
          type: meta.type,
          size: meta.size,
          filePath: meta.filePath,
          lastModified: meta.lastModified,
        });
      }
    }

    return Array.from(byTitle.values()).sort((a, b) =>
      a.title.localeCompare(b.title),
    );
  }

  /**
   * Fetches all chunks for a single document (by title), ordered by chunkIndex.
   */
  async getDocumentChunks(
    title: string,
  ): Promise<Array<{ content: string; metadata: any }>> {
    const { data, error } = await supabase
      .from("documents")
      .select("content, metadata")
      .eq("title", title)
      .limit(50000);

    if (error) throw error;
    if (!data || data.length === 0) return [];

    return (data as any[])
      .map((row) => ({
        content: row.content as string,
        metadata: (row.metadata || {}) as any,
      }))
      .sort((a, b) => {
        const ai = Number(a.metadata?.chunkIndex ?? 0);
        const bi = Number(b.metadata?.chunkIndex ?? 0);
        return ai - bi;
      });
  }

  /**
   * Reconstructs the full document text (ordered by chunkIndex) for a title.
   * Returns null when the document does not exist.
   */
  async getFullDocument(title: string): Promise<{
    title: string;
    content: string;
    metadata: any;
    chunkCount: number;
  } | null> {
    const chunks = await this.getDocumentChunks(title);
    if (chunks.length === 0) return null;

    const content = chunks.map((c) => c.content).join("\n\n");
    return {
      title,
      content,
      metadata: chunks[0]?.metadata || {},
      chunkCount: chunks.length,
    };
  }

  /**
   * Processes and adds a single file to the vector store.
   * Useful for API endpoints that allow file uploads.
   * @param filePath The path to the file.
   */
  async addFile(filePath: string) {
    logger.info(`📄 Processing single file: ${filePath}`);

    const doc = await this.documentProcessor.processFile(filePath);
    if (!doc) {
      throw new Error(`Failed to process file: ${filePath}`);
    }

    const chunks = this.textChunker.chunkDocument(doc);
    logger.info(`   Split into ${chunks.length} chunks.`);

    // Use batch insert for better performance
    const chunksToAdd = chunks.map((chunk) => ({
      title: chunk.title,
      content: chunk.content,
      metadata: chunk.metadata,
    }));

    const insertedChunks = await this.addDocuments(chunksToAdd);
    const source =
      await this.registerInsertedChunksWithResearchBrain(insertedChunks);

    return {
      title: doc.title,
      chunkCount: chunks.length,
      sourceId: source?.id,
    };
  }

  private async registerInsertedChunksWithResearchBrain(
    insertedChunks: Array<{
      id: string;
      title: string;
      content: string;
      metadata?: any;
    }>,
  ) {
    if (insertedChunks.length === 0) return null;

    const grouped = new Map<string, typeof insertedChunks>();
    for (const chunk of insertedChunks) {
      const existing = grouped.get(chunk.title) || [];
      existing.push(chunk);
      grouped.set(chunk.title, existing);
    }

    let lastSource: any = null;
    for (const [title, chunks] of grouped) {
      try {
        const { registerDocumentAsResearchSource } =
          await import("../services/researchBrain");
        const source = await registerDocumentAsResearchSource({
          title,
          chunks: chunks.sort((a, b) => {
            const ai = Number(a.metadata?.chunkIndex ?? 0);
            const bi = Number(b.metadata?.chunkIndex ?? 0);
            return ai - bi;
          }),
          runExtraction: process.env.RESEARCH_BRAIN_AUTO_EXTRACT !== "false",
        });
        lastSource = source;
      } catch (error) {
        logger.error(
          { err: error, title },
          "research_brain_document_registration_failed",
        );
      }
    }

    return lastSource;
  }

  private async registerExistingDocumentsWithResearchBrain() {
    if (process.env.RESEARCH_BRAIN_BACKFILL_EXISTING === "false") return;

    try {
      const { data, error } = await supabase
        .from("documents")
        .select("id, title, content, metadata")
        .limit(50000);
      if (error) throw error;

      const grouped = new Map<
        string,
        Array<{ id: string; title: string; content: string; metadata?: any }>
      >();
      for (const row of data || []) {
        const title = (row as any).title;
        const existing = grouped.get(title) || [];
        existing.push({
          id: (row as any).id,
          title,
          content: (row as any).content,
          metadata: (row as any).metadata || {},
        });
        grouped.set(title, existing);
      }

      for (const [title, chunks] of grouped) {
        const { registerDocumentAsResearchSource } =
          await import("../services/researchBrain");
        await registerDocumentAsResearchSource({
          title,
          chunks: chunks.sort((a, b) => {
            const ai = Number(a.metadata?.chunkIndex ?? 0);
            const bi = Number(b.metadata?.chunkIndex ?? 0);
            return ai - bi;
          }),
          runExtraction: process.env.RESEARCH_BRAIN_AUTO_EXTRACT !== "false",
        });
      }

      logger.info(
        { documentCount: grouped.size },
        "research_brain_existing_documents_registered",
      );
    } catch (error) {
      logger.warn(
        { err: error },
        "research_brain_existing_documents_registration_failed",
      );
    }
  }
}
