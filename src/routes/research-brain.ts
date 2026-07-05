import { Elysia } from "elysia";
import { mkdir } from "fs/promises";
import path from "path";
import { authResolver } from "../middleware/authResolver";
import {
  addAlias,
  backfillBioprospectingMeasurements,
  extractBioprospectingFactsForSource,
  extractClaimsForSource,
  getBioprospectingFact,
  getBioprospectingFactsForSource,
  getCanonicalById,
  getClaim,
  getContradictionStats,
  getSource,
  getSourceClaims,
  getSourceEvidenceChunk,
  listResearchTaxa,
  listSources,
  listContradictionsGlobal,
  listRecentMergeEvents,
  normalizeBioprospectingTaxonomy,
  promoteFactToPending,
  researchBrainSearch,
  resolveBioprospectingContradiction,
  searchBioprospectingContradictions,
  searchBioprospectingFacts,
  searchCompoundsByName,
  unmergeFact,
  updateBioprospectingFactEntities,
  updateBioprospectingFactReview,
  updateBioprospectingFactsReviewBulk,
  AmbiguousEdgeError,
  FactNotFoundError,
  InvalidReasonCategoryError,
  NoActiveEdgeError,
  REASON_CATEGORIES,
} from "../services/researchBrain";
import type { DedupEventWindow } from "../services/researchBrain";
import { getServiceClient } from "../db/client";
import { getDocumentIngestionQueue } from "../services/queue/queues";
import { isJobQueueEnabled } from "../services/queue/connection";
import { DocumentProcessor } from "../embeddings/documentProcessor";
import {
  loadFiguresForSource,
  loadTablesForSource,
} from "../services/files/pdfTableExtractor";
import { getStorageProvider } from "../storage";
import {
  downloadFigure,
  FigureNotFoundError,
} from "../storage/figureStorage";
import logger from "../utils/logger";

function getDocsPath(): string {
  return process.env.KNOWLEDGE_DOCS_PATH || "docs";
}

function safeUploadPath(filename: string): string {
  const docsRoot = path.resolve(getDocsPath());
  const safeName = path.basename(filename).replace(/[^\w.\- ()]/g, "_");
  return path.resolve(docsRoot, safeName);
}

export const researchBrainRoute = new Elysia({ prefix: "/api/research-brain" })
  .get(
    "/sources",
    async ({ set }) => {
      try {
        return { sources: await listSources() };
      } catch (error: any) {
        logger.error({ err: error }, "research_brain_sources_failed");
        set.status = 500;
        return {
          error: "Failed to list Research Brain sources",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .get(
    "/sources/:sourceId/claims",
    async ({ params, set }) => {
      try {
        return { claims: await getSourceClaims(params.sourceId) };
      } catch (error: any) {
        logger.error(
          { err: error, sourceId: params.sourceId },
          "research_brain_source_claims_failed",
        );
        set.status = 500;
        return {
          error: "Failed to list source claims",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .get(
    "/sources/:sourceId/chunks/:chunkIndex",
    async ({ params, set }) => {
      const chunkIndex = Number(params.chunkIndex);
      if (!Number.isFinite(chunkIndex)) {
        set.status = 400;
        return { error: "Invalid chunk index" };
      }

      try {
        const chunk = await getSourceEvidenceChunk(params.sourceId, chunkIndex);
        if (!chunk) {
          set.status = 404;
          return { error: "Evidence fragment not found" };
        }
        return { chunk };
      } catch (error: any) {
        logger.error(
          { err: error, sourceId: params.sourceId, chunkIndex },
          "research_brain_source_chunk_failed",
        );
        set.status = 500;
        return {
          error: "Failed to load evidence fragment",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .post(
    "/search",
    async ({ body, set }) => {
      const parsed = (body || {}) as {
        query?: string;
        trustTier?: "internal" | "external" | "all";
        includeExternal?: boolean;
        limit?: number;
        measurementMin?: number;
        measurementMax?: number;
        measurementUnit?: string;
        measurementDirection?: "increase" | "decrease" | "no_change" | "mixed";
        condition?: string;
        reviewStatus?:
          | "unreviewed"
          | "verified"
          | "needs_review"
          | "incorrect"
          | "quarantined"
          | "all";
        evidenceStrength?:
          | "direct"
          | "indirect"
          | "hypothesis"
          | "unknown"
          | "all";
        sourceId?: string;
        sourceTrustTier?: "internal" | "external" | "all";
      };

      if (!parsed.query || !parsed.query.trim()) {
        set.status = 400;
        return { error: "Missing query" };
      }

      try {
        const evidencePack = await researchBrainSearch({
          query: parsed.query,
          trustTier: parsed.trustTier,
          includeExternal: parsed.includeExternal,
          limit: parsed.limit,
          measurementMin: parsed.measurementMin,
          measurementMax: parsed.measurementMax,
          measurementUnit: parsed.measurementUnit,
          measurementDirection: parsed.measurementDirection,
          condition: parsed.condition,
          reviewStatus: parsed.reviewStatus,
          evidenceStrength: parsed.evidenceStrength,
          sourceId: parsed.sourceId,
          sourceTrustTier: parsed.sourceTrustTier,
        });
        return { evidencePack };
      } catch (error: any) {
        logger.error(
          { err: error, query: parsed.query },
          "research_brain_search_failed",
        );
        set.status = 500;
        return {
          error: "Failed to search Research Brain",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .post(
    "/bioprospecting/search",
    async ({ body, set }) => {
      const parsed = (body || {}) as {
        query?: string;
        limit?: number;
        measurementMin?: number;
        measurementMax?: number;
        measurementUnit?: string;
        measurementDirection?: "increase" | "decrease" | "no_change" | "mixed";
        condition?: string;
        reviewStatus?:
          | "unreviewed"
          | "verified"
          | "needs_review"
          | "incorrect"
          | "quarantined"
          | "all";
        sourceId?: string;
        sourceTrustTier?: "internal" | "external" | "all";
      };

      if (!parsed.query || !parsed.query.trim()) {
        set.status = 400;
        return { error: "Missing query" };
      }

      try {
        return {
          facts: await searchBioprospectingFacts({
            query: parsed.query,
            limit: parsed.limit,
            measurementMin: parsed.measurementMin,
            measurementMax: parsed.measurementMax,
            measurementUnit: parsed.measurementUnit,
            measurementDirection: parsed.measurementDirection,
            condition: parsed.condition,
            reviewStatus: parsed.reviewStatus,
            sourceId: parsed.sourceId,
            sourceTrustTier: parsed.sourceTrustTier,
          }),
        };
      } catch (error: any) {
        logger.error(
          { err: error, query: parsed.query },
          "bioprospecting_search_failed",
        );
        set.status = 500;
        return {
          error: "Failed to search bioprospecting facts",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .post(
    "/bioprospecting/measurements/backfill",
    async ({ body, set }) => {
      const parsed = (body || {}) as {
        limit?: number;
        dryRun?: boolean;
      };

      try {
        return await backfillBioprospectingMeasurements({
          limit: parsed.limit,
          dryRun: parsed.dryRun,
        });
      } catch (error: any) {
        logger.error(
          { err: error },
          "bioprospecting_measurement_backfill_failed",
        );
        set.status = 500;
        return {
          error: "Failed to backfill bioprospecting measurements",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .patch(
    "/bioprospecting/facts/:id/review",
    async ({ params, body, request, set }) => {
      const parsed = (body || {}) as {
        reviewStatus?: string;
        reviewNote?: string | null;
      };
      const allowedStatuses = new Set([
        "unreviewed",
        "verified",
        "needs_review",
        "incorrect",
        "quarantined",
      ]);

      if (!parsed.reviewStatus || !allowedStatuses.has(parsed.reviewStatus)) {
        set.status = 400;
        return { error: "Invalid review status" };
      }

      try {
        return {
          fact: await updateBioprospectingFactReview({
            factId: params.id,
            reviewStatus: parsed.reviewStatus as any,
            reviewNote: parsed.reviewNote,
            reviewedBy: (request as any).auth?.userId,
          }),
        };
      } catch (error: any) {
        logger.error(
          { err: error, factId: params.id },
          "bioprospecting_review_update_failed",
        );
        set.status = 500;
        return {
          error: "Failed to update bioprospecting fact review",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .patch(
    "/bioprospecting/facts/review-bulk",
    async ({ body, request, set }) => {
      const parsed = (body || {}) as {
        factIds?: string[];
        reviewStatus?: string;
        reviewNote?: string | null;
      };
      const allowedStatuses = new Set([
        "unreviewed",
        "verified",
        "needs_review",
        "incorrect",
        "quarantined",
      ]);
      const factIds = Array.isArray(parsed.factIds)
        ? parsed.factIds.filter(Boolean)
        : [];

      if (factIds.length === 0) {
        set.status = 400;
        return { error: "Missing fact ids" };
      }
      if (factIds.length > 250) {
        set.status = 400;
        return { error: "Bulk review is limited to 250 facts per request" };
      }
      if (!parsed.reviewStatus || !allowedStatuses.has(parsed.reviewStatus)) {
        set.status = 400;
        return { error: "Invalid review status" };
      }

      try {
        const facts = await updateBioprospectingFactsReviewBulk({
          factIds,
          reviewStatus: parsed.reviewStatus as any,
          reviewNote: parsed.reviewNote,
          reviewedBy: (request as any).auth?.userId,
        });
        return { facts, updated: facts.length };
      } catch (error: any) {
        logger.error({ err: error }, "bioprospecting_bulk_review_failed");
        set.status = 500;
        return {
          error: "Failed to bulk update bioprospecting fact reviews",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .patch(
    "/bioprospecting/facts/:id/entities",
    async ({ params, body, request, set }) => {
      const parsed = (body || {}) as {
        species?: string | null;
        genus?: string | null;
        family?: string | null;
        organismGroup?: string | null;
        geography?: string | null;
        ecosystem?: string | null;
        organismPart?: string | null;
        compound?: string | null;
        compoundClass?: string | null;
        moleculeType?: string | null;
        bioactivity?: string | null;
        applicationArea?: string | null;
        assayModel?: string | null;
        condition?: string | null;
      };

      try {
        return {
          fact: await updateBioprospectingFactEntities({
            factId: params.id,
            correctedBy: (request as any).auth?.userId,
            patch: {
              species: parsed.species,
              genus: parsed.genus,
              family: parsed.family,
              organism_group: parsed.organismGroup,
              geography: parsed.geography,
              ecosystem: parsed.ecosystem,
              organism_part: parsed.organismPart,
              compound: parsed.compound,
              compound_class: parsed.compoundClass,
              molecule_type: parsed.moleculeType,
              bioactivity: parsed.bioactivity,
              application_area: parsed.applicationArea,
              assay_model: parsed.assayModel,
              condition: parsed.condition,
            },
          }),
        };
      } catch (error: any) {
        logger.error(
          { err: error, factId: params.id },
          "bioprospecting_entity_update_failed",
        );
        set.status = 500;
        return {
          error: "Failed to update bioprospecting fact entities",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .get(
    "/taxonomy",
    async ({ query, set }) => {
      const parsed = query as {
        rank?: "species" | "genus" | "family" | "higher_taxon";
        q?: string;
        limit?: string;
      };

      try {
        return {
          taxa: await listResearchTaxa({
            rank: parsed.rank,
            query: parsed.q,
            limit: parsed.limit ? Number(parsed.limit) : undefined,
          }),
        };
      } catch (error: any) {
        logger.error({ err: error }, "research_taxonomy_list_failed");
        set.status = 500;
        return {
          error: "Failed to list normalized taxonomy",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .post(
    "/taxonomy/normalize",
    async ({ body, set }) => {
      const parsed = (body || {}) as {
        limit?: number;
        dryRun?: boolean;
        onlyMissing?: boolean;
        useWoRMS?: boolean;
      };

      try {
        return await normalizeBioprospectingTaxonomy({
          limit: parsed.limit,
          dryRun: parsed.dryRun,
          onlyMissing: parsed.onlyMissing,
          useWoRMS: parsed.useWoRMS,
        });
      } catch (error: any) {
        logger.error({ err: error }, "research_taxonomy_normalize_failed");
        set.status = 500;
        return {
          error: "Failed to normalize taxonomy",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .post(
    "/sources/:sourceId/extract",
    async ({ params, set }) => {
      try {
        return await extractClaimsForSource(params.sourceId);
      } catch (error: any) {
        logger.error(
          { err: error, sourceId: params.sourceId },
          "research_brain_extract_failed",
        );
        set.status = 500;
        return {
          error: "Failed to extract source claims",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .post(
    "/sources/:sourceId/extract-bioprospecting",
    async ({ params, set }) => {
      try {
        return await extractBioprospectingFactsForSource(params.sourceId);
      } catch (error: any) {
        logger.error(
          { err: error, sourceId: params.sourceId },
          "bioprospecting_extract_failed",
        );
        set.status = 500;
        return {
          error: "Failed to extract bioprospecting facts",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .get(
    "/claims/:id",
    async ({ params, set }) => {
      try {
        const claim = await getClaim(params.id);
        if (!claim) {
          set.status = 404;
          return { error: "Claim not found" };
        }
        return { claim };
      } catch (error: any) {
        logger.error(
          { err: error, claimId: params.id },
          "research_brain_claim_failed",
        );
        set.status = 500;
        return { error: "Failed to load claim", message: error?.message };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .post(
    "/sources/upload",
    async ({ body, set }) => {
      const parsed = body as any;
      const file = parsed?.file instanceof File ? parsed.file : null;
      if (!file) {
        set.status = 400;
        return { error: "Missing file" };
      }

      const destination = safeUploadPath(file.name);
      const docsRoot = path.resolve(getDocsPath());
      if (
        destination !== docsRoot &&
        !destination.startsWith(docsRoot + path.sep)
      ) {
        set.status = 400;
        return { error: "Invalid filename" };
      }

      try {
        await mkdir(docsRoot, { recursive: true });
        await Bun.write(destination, file);

        const { VectorSearchWithDocuments } =
          await import("../embeddings/vectorSearchWithDocs");
        let vectorSearch = (globalThis as any).__knowledgeVectorSearch;
        if (!vectorSearch) {
          vectorSearch = new VectorSearchWithDocuments();
          (globalThis as any).__knowledgeVectorSearch = vectorSearch;
        }

        const added = await vectorSearch.addFile(destination);

        logger.info(
          { filename: file.name, destination, sourceId: added.sourceId },
          "research_brain_source_uploaded",
        );

        return {
          ok: true,
          title: added.title,
          chunkCount: added.chunkCount,
          sourceId: added.sourceId,
        };
      } catch (error: any) {
        logger.error(
          { err: error, filename: file.name },
          "research_brain_upload_failed",
        );
        set.status = 500;
        return { error: "Failed to upload source", message: error?.message };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .post(
    "/ingestion/start",
    async ({ body, set }) => {
      const parsed = (body || {}) as {
        docsPath?: string;
        options?: {
          force?: boolean;
          extractBioprospecting?: boolean;
        };
      };

      if (!parsed.docsPath) {
        set.status = 400;
        return { error: "Missing docsPath" };
      }

      const docsPath = path.resolve(parsed.docsPath);
      const force = parsed.options?.force ?? false;
      const extractBioprospecting = parsed.options?.extractBioprospecting ?? false;

      // Check if directory exists and is accessible
      try {
        await mkdir(docsPath, { recursive: true });
      } catch {
        set.status = 400;
        return { error: "Directory not accessible" };
      }

      const supabase = getServiceClient();

      // List all files in the directory
      const documentProcessor = new DocumentProcessor();
      const ignorePatterns = (process.env.KNOWLEDGE_INGEST_IGNORE || "research-brain.md")
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      let files: string[] = [];
      try {
        files = await documentProcessor.listSupportedFiles(docsPath, { ignorePatterns });
      } catch {
        set.status = 400;
        return { error: "Directory not accessible" };
      }

      if (files.length === 0) {
        set.status = 400;
        return { error: "No supported files found in directory" };
      }

      // Create ingestion run record
      let runId: string | null = null;
      try {
        const { data, error } = await supabase
          .from("research_ingestion_runs")
          .insert({
            docs_path: docsPath,
            status: "running",
            total_files: files.length,
            metadata: {
              force,
              extractBioprospecting,
            },
          })
          .select("id")
          .single();

        if (error) throw error;
        runId = (data as any).id;
      } catch (error: any) {
        logger.error({ err: error }, "ingestion_start_run_create_failed");
        set.status = 500;
        return { error: "Failed to create ingestion run", message: error?.message };
      }

      // If job queue is disabled, return error (sequential mode not supported for API)
      if (!isJobQueueEnabled()) {
        set.status = 400;
        return { error: "Job queue is not enabled. Set USE_JOB_QUEUE=true to use ingestion API." };
      }

      // Enqueue jobs for each file
      try {
        const queue = getDocumentIngestionQueue();
        for (const filePath of files) {
          await queue.add("document-ingestion", {
            runId,
            filePath,
            options: {
              force,
              extractBioprospecting,
            },
          });
        }

        logger.info({ runId, fileCount: files.length }, "ingestion_jobs_enqueued");
      } catch (error: any) {
        logger.error({ err: error, runId }, "ingestion_jobs_enqueue_failed");
        set.status = 500;
        return { error: "Failed to enqueue ingestion jobs", message: error?.message };
      }

      return {
        runId,
        status: "running",
        totalFiles: files.length,
      };
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .get(
    "/ingestion/runs",
    async ({ query, set }) => {
      const supabase = getServiceClient();
      const parsed = query as { status?: string; limit?: string; offset?: string };

      const limit = Math.min(Math.max(parseInt(parsed.limit || "20", 10) || 20, 1), 100);
      const offset = parseInt(parsed.offset || "0", 10) || 0;
      const status = parsed.status;

      try {
        let dbQuery = supabase
          .from("research_ingestion_runs")
          .select("id, docs_path, status, total_files, processed_files, skipped_files, failed_files, llm_cost, started_at, finished_at, cancelled_at", { count: "exact" })
          .order("started_at", { ascending: false })
          .range(offset, offset + limit - 1);

        if (status) {
          dbQuery = dbQuery.eq("status", status);
        }

        const { data: runs, error, count } = await dbQuery;

        if (error) throw error;

        return {
          runs: (runs || []).map((run: any) => ({
            runId: run.id,
            docsPath: run.docs_path,
            status: run.status,
            totalFiles: run.total_files,
            processedFiles: run.processed_files,
            skippedFiles: run.skipped_files,
            failedFiles: run.failed_files,
            llmCost: parseFloat(run.llm_cost || "0"),
            startedAt: run.started_at,
            finishedAt: run.finished_at,
            cancelledAt: run.cancelled_at,
          })),
          total: count || 0,
          limit,
          offset,
        };
      } catch (error: any) {
        logger.error({ err: error }, "ingestion_runs_list_failed");
        set.status = 500;
        return { error: "Failed to list runs", message: error?.message };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  )
  .post(
    "/ingestion/runs/:id/cancel",
    async ({ params, set }) => {
      const supabase = getServiceClient();

      try {
        const { data: run, error: runError } = await supabase
          .from("research_ingestion_runs")
          .select("id, status")
          .eq("id", params.id)
          .single();

        if (runError || !run) {
          set.status = 404;
          return { error: "Run not found" };
        }

        if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
          set.status = 409;
          return { error: "Cannot cancel completed run" };
        }

        const cancelledAt = new Date().toISOString();
        await supabase
          .from("research_ingestion_runs")
          .update({ status: "cancelled", cancelled_at: cancelledAt })
          .eq("id", params.id);

        return {
          runId: params.id,
          status: "cancelled",
          cancelledAt,
        };
      } catch (error: any) {
        logger.error({ err: error, runId: params.id }, "ingestion_run_cancel_failed");
        set.status = 500;
        return { error: "Failed to cancel run", message: error?.message };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  )
  .get(
    "/ingestion/runs/:id",
    async ({ params, set }) => {
      const supabase = getServiceClient();

      try {
        const { data: run, error } = await supabase
          .from("research_ingestion_runs")
          .select("*")
          .eq("id", params.id)
          .single();

        if (error || !run) {
          set.status = 404;
          return { error: "Run not found" };
        }

        return {
          runId: (run as any).id,
          docsPath: (run as any).docs_path,
          status: (run as any).status,
          totalFiles: (run as any).total_files,
          processedFiles: (run as any).processed_files,
          skippedFiles: (run as any).skipped_files,
          failedFiles: (run as any).failed_files,
          llmCost: parseFloat((run as any).llm_cost || "0"),
          llmCallsCount: ((run as any).llm_calls || []).length,
          // External-API spend (Mistral OCR + PubChem) — additive
          // fields per the api-cost-guard-rails spec. `ext_api_cost`
          // is a NUMERIC column on the row; `ext_api_calls` is a
          // JSONB map keyed by provider. The count sums the `calls`
          // field across all providers.
          extApiCost: parseFloat((run as any).ext_api_cost || "0"),
          extApiCallsCount: Object.values(
            (run as any).ext_api_calls || {},
          ).reduce(
            (sum: number, entry: any) =>
              sum + (Number(entry?.calls ?? 0) || 0),
            0,
          ),
          startedAt: (run as any).started_at,
          finishedAt: (run as any).finished_at,
          cancelledAt: (run as any).cancelled_at,
        };
      } catch (error: any) {
        logger.error({ err: error, runId: params.id }, "ingestion_run_status_failed");
        set.status = 500;
        return { error: "Failed to get run status", message: error?.message };
      }
    },
       { beforeHandle: authResolver({ required: true, role: "admin" }) },
  )
  .get(
    "/ingestion/runs/:id/files",
    async ({ params, set }) => {
      const supabase = getServiceClient();

      try {
        const { data: run, error } = await supabase
          .from("research_ingestion_runs")
          .select("file_statuses")
          .eq("id", params.id)
          .single();

        if (error || !run) {
          set.status = 404;
          return { error: "Run not found" };
        }

        const fileStatuses: any[] = (run as any).file_statuses || [];

        return {
          runId: params.id,
          files: fileStatuses.map((f) => ({
            filePath: f.filePath,
            status: f.status,
            chunksInserted: f.chunksInserted,
            sourceId: f.sourceId,
            error: f.error,
            reason: f.reason,
          })),
        };
      } catch (error: any) {
        logger.error({ err: error, runId: params.id }, "ingestion_run_files_failed");
        set.status = 500;
        return { error: "Failed to get file statuses", message: error?.message };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .post(
    "/ingestion/runs/:id/retry-failed",
    async ({ params, set }) => {
      const supabase = getServiceClient();

      // Get the run and filter for failed files
      const { data: run, error: runError } = await supabase
        .from("research_ingestion_runs")
        .select("file_statuses, metadata")
        .eq("id", params.id)
        .single();

      if (runError || !run) {
        set.status = 404;
        return { error: "Run not found" };
      }

      const fileStatuses: any[] = (run as any).file_statuses || [];
      const failedFiles = fileStatuses.filter((f) => f.status === "failed");

      if (failedFiles.length === 0) {
        return {
          runId: params.id,
          retriedFiles: 0,
          status: (run as any).status,
        };
      }

      // Update run status to running
      await supabase
        .from("research_ingestion_runs")
        .update({ status: "running" })
        .eq("id", params.id);

      // Re-enqueue failed jobs
      if (isJobQueueEnabled()) {
        const queue = getDocumentIngestionQueue();
        const metadata = (run as any).metadata || {};

        for (const file of failedFiles) {
          await queue.add("document-ingestion", {
            runId: params.id,
            filePath: file.filePath,
            options: {
              force: metadata.force ?? false,
              extractBioprospecting: metadata.extractBioprospecting ?? false,
            },
          });
        }

        logger.info({ runId: params.id, retriedFiles: failedFiles.length }, "ingestion_retry_failed_enqueued");
      }

      return {
        runId: params.id,
        retriedFiles: failedFiles.length,
        status: "running",
      };
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .get(
    "/sources/:sourceId/contradictions",
    async ({ params, query, set }) => {
      const status = (query as any).status ?? "all";
      const validStatuses = new Set(["unresolved", "resolved", "dismissed", "all"]);
      if (!validStatuses.has(status)) {
        set.status = 400;
        return { error: "Invalid status. Use: unresolved|resolved|dismissed|all" };
      }
      try {
        const includeResolved =
          status === "all" || status === "resolved" || status === "dismissed";
        const facts = await getBioprospectingFactsForSource(params.sourceId);
        const factIds = facts.map((f: any) => f.id);
        const contradictions = await searchBioprospectingContradictions({
          factIds,
          includeResolved,
        });
        return { contradictions };
      } catch (error: any) {
        logger.error({ err: error, sourceId: params.sourceId }, "source_contradictions_failed");
        set.status = 500;
        return { error: "Failed to get contradictions", message: error?.message };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .post(
    "/contradictions/:id/resolve",
    async ({ params, body, request, set }) => {
      const parsed = (body || {}) as {
        resolutionStatus?: string;
        resolvedBy?: string;
      };
      const allowedStatuses = new Set(["resolved", "dismissed"]);
      if (!parsed.resolutionStatus || !allowedStatuses.has(parsed.resolutionStatus)) {
        set.status = 400;
        return { error: "Invalid resolutionStatus. Use: resolved|dismissed" };
      }
      try {
        const contradiction = await resolveBioprospectingContradiction({
          contradictionId: params.id,
          resolutionStatus: parsed.resolutionStatus as "resolved" | "dismissed",
          resolvedBy: parsed.resolvedBy || (request as any).auth?.userId,
        });
        return { contradiction };
      } catch (error: any) {
        logger.error({ err: error, contradictionId: params.id }, "contradiction_resolve_failed");
        set.status = 500;
        return { error: "Failed to resolve contradiction", message: error?.message };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .post(
    "/sources/:sourceId/contradictions/detect",
    async ({ params, set }) => {
      if (!isJobQueueEnabled()) {
        set.status = 400;
        return { error: "Job queue is not enabled. Set USE_JOB_QUEUE=true." };
      }
      try {
        const { getBioprospectingQueue } = await import("../services/queue/queues");
        const queue = getBioprospectingQueue();
        const job = await queue.add("bioprospecting", {
          runId: crypto.randomUUID(),
          sourceId: params.sourceId,
        });
        return { jobId: job.id, status: "enqueued" };
      } catch (error: any) {
        logger.error({ err: error, sourceId: params.sourceId }, "contradiction_detect_enqueue_failed");
        set.status = 500;
        return { error: "Failed to enqueue contradiction detection", message: error?.message };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  // -------------------------------------------------------------------------
  // PDF provenance viewer (PR #2 of bioprospecting-pdf-provenance-viewer).
  //
  // Three read-only endpoints that power the /viewer/:sourceId route
  // and the EvidenceLightbox:
  //   1. GET /api/research-brain/sources/:sourceId/evidence
  //        → tables + figures + chunks for the source
  //   2. GET /api/research-brain/sources/:sourceId/pdf
  //        → streams the source PDF inline (proxied through S3)
  //   3. GET /api/research-brain/facts/:factId/provenance
  //        → resolves a fact to its table|figure|chunk|text-only chain
  //
  // Endpoints 1 and 3 are `required: false` (research metadata, not
  // user PII). Endpoint 2 is `required: true` because the file may
  // live in a private bucket and the proxy must not leak S3 creds.
  // -------------------------------------------------------------------------
  .get(
    "/sources/:sourceId/evidence",
    async ({ params, set }) => {
      const { sourceId } = params;
      if (!sourceId) {
        set.status = 400;
        return { error: "Missing sourceId" };
      }

      try {
        // 1. Verify the source exists — the spec's "Unknown source
        //    returns 404" scenario. 404 is the only path that needs
        //    a separate existence check; the other two endpoints
        //    short-circuit on empty results without 404-ing.
        const source = await getSource(sourceId);
        if (!source) {
          set.status = 404;
          return { error: "Source not found" };
        }

        // 2. Load tables and figures in parallel from the
        //    research_evidence_* tables (the source of truth, written
        //    by PR #1's extraction pipeline). The loaders already
        //    order by (page, table_index|figure_index) asc.
        const [tables, figures, chunksResult] = await Promise.all([
          loadTablesForSource(sourceId),
          loadFiguresForSource(sourceId),
          getServiceClient()
            .from("research_evidence_chunks")
            .select("id, page, chunk_index, content")
            .eq("source_id", sourceId)
            .order("chunk_index", { ascending: true }),
        ]);

        if (chunksResult.error) {
          logger.error(
            { err: chunksResult.error, sourceId },
            "research_brain_evidence_chunks_failed",
          );
        }

        const chunks = (chunksResult.data || []).map((c: any) => ({
          id: c.id,
          page: c.page,
          chunkIndex: c.chunk_index,
          content: c.content,
          // Per the design: chunks have no bbox until a follow-up
          // change adds per-chunk bboxes (out of scope here). The
          // viewer treats `bbox: null` as the text-chunk fallback
          // signal (text-only highlight via the badge).
          bbox: null,
        }));

        return {
          sourceId,
          tables: tables.map((t) => ({
            id: t.id,
            page: t.page,
            tableIndex: t.table_index,
            headers: t.headers,
            rows: t.rows,
            markdown: t.markdown,
            bbox: t.bbox,
            extractionProvider: t.extraction_provider,
            extractionConfidence: Number(t.extraction_confidence),
            // PR #2 of bioprospecting-multipage-table-merge:
            // surface `continues_from_id` so the viewer can walk
            // the chain and render the "Part X of N" pager.
            continuesFromId: t.continues_from_id ?? null,
          })),
          figures: figures.map((f) => {
            // PR #1 of figure-image-extraction: surface the
            // image fields when the figure has an extracted
            // image (`storage_path IS NOT NULL`). When the
            // figure is bbox-only, the four new fields are
            // omitted (the spec's contract — the viewer treats
            // the absence of `imageUrl` as the bbox-only case).
            const base = {
              id: f.id,
              page: f.page,
              figureIndex: f.figure_index,
              bbox: f.bbox,
              caption: f.caption,
            };
            if (f.storage_path) {
              return {
                ...base,
                imageUrl: `/api/research-brain/figures/${f.id}/image`,
                width: f.width ?? null,
                height: f.height ?? null,
                mimeType: f.mime_type ?? null,
              };
            }
            return base;
          }),
          chunks,
        };
      } catch (error: any) {
        logger.error(
          { err: error, sourceId },
          "research_brain_evidence_failed",
        );
        set.status = 500;
        return {
          error: "Failed to load source evidence",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .get(
    "/sources/:sourceId/pdf",
    async ({ params, set, request }) => {
      const { sourceId } = params;
      if (!sourceId) {
        set.status = 400;
        return { error: "Missing sourceId" };
      }

      // 50 MB cap — research PDFs are well under. Anything larger
      // is rejected before the S3 download to avoid blowing the
      // server's memory budget.
      const MAX_PDF_BYTES = 50 * 1024 * 1024;

      try {
        // 1. Existence + file_path check (the source may exist but
        //    not have a PDF on disk; the spec's 404 covers both).
        const source = await getSource(sourceId);
        if (!source) {
          set.status = 404;
          return { error: "Source not found" };
        }
        const filePath = source.file_path;
        if (!filePath) {
          set.status = 404;
          return { error: "Source has no PDF file" };
        }

        // 2. Storage provider check. No provider means the
        //    infrastructure is not configured for the proxy — the
        //    design defers a "PDF not available" fallback to the
        //    lightbox (no fallback to the local docs path).
        const storage = getStorageProvider();
        if (!storage) {
          logger.warn(
            { sourceId, filePath },
            "research_brain_pdf_storage_unconfigured",
          );
          set.status = 502;
          return {
            error: "PDF storage is not configured",
            message:
              "STORAGE_PROVIDER is unset; the PDF proxy is unavailable in this environment.",
          };
        }

        // 3. Download the buffer from S3. The StorageProvider.download
        //    contract is Buffer (Node), and Elysia can serialize a
        //    Buffer as the response body with explicit headers.
        const buffer = await storage.download(filePath);
        if (!buffer || buffer.length === 0) {
          set.status = 502;
          return { error: "PDF download returned empty buffer" };
        }
        if (buffer.length > MAX_PDF_BYTES) {
          set.status = 413;
          return {
            error: "PDF exceeds the 50 MB proxy limit",
            bytes: buffer.length,
          };
        }

        // 4. Sanitize the filename for the Content-Disposition
        //    header. Strip path separators, control chars, and any
        //    double-quote that would break the header value.
        const rawTitle = source.title || `source-${sourceId}`;
        const safeFilename =
          rawTitle
            .replace(/[\r\n\t]+/g, " ")
            .replace(/[\\/]+/g, "_")
            .replace(/[^\w.\- ()]+/g, "_")
            .slice(0, 200) + ".pdf";

        // 5. Stream the bytes back. We set headers explicitly so
        //    Elysia doesn't try to JSON-serialize the Buffer. Using
        //    a `new Response(buffer, ...)` keeps the streaming
        //    semantics tight (PDF.js doesn't need chunked
        //    streaming — it slurps the whole file — but the
        //    `Content-Length` header is still useful for progress
        //    reporting in the lightbox).
        const headers: Record<string, string> = {
          "Content-Type": "application/pdf",
          "Content-Length": String(buffer.length),
          "Content-Disposition": `inline; filename="${safeFilename}"`,
          "Cache-Control": "private, max-age=60",
        };
        return new Response(buffer, { status: 200, headers });
      } catch (error: any) {
        logger.error(
          { err: error, sourceId },
          "research_brain_pdf_failed",
        );
        set.status = 502;
        return {
          error: "Failed to proxy source PDF",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .get(
    // PR #1 of figure-image-extraction: image proxy for extracted
    // figure bytes. Same auth + size-cap pattern as the PDF proxy.
    // Spec: 401 unauthed, 404 on storage_path IS NULL, 413 on
    // > 50 MB, 502 on storage unconfigured, 200 with image bytes
    // and the documented headers.
    "/figures/:figureId/image",
    async ({ params, set }) => {
      const { figureId } = params;
      if (!figureId) {
        set.status = 400;
        return { error: "Missing figureId" };
      }

      // 50 MB cap — matches the PDF proxy's MAX_PDF_BYTES policy.
      const MAX_FIGURE_BYTES = 50 * 1024 * 1024;

      try {
        // 1. Storage provider check.
        const storage = getStorageProvider();
        if (!storage) {
          set.status = 502;
          return {
            error: "Storage not configured",
            message:
              "STORAGE_PROVIDER is unset; the figure image proxy is unavailable in this environment.",
          };
        }

        // 2. Load the figure row. The `select` includes the 5
        //    new image columns. We do a single-row lookup by id;
        //    the existing `loadFiguresForSource` reads per-source
        //    so it does not match the per-figure lookup.
        const sb = getServiceClient();
        const { data: figureRow, error: rowErr } = await sb
          .from("research_evidence_figures")
          .select(
            "id, source_id, page, figure_index, storage_path, mime_type, byte_size",
          )
          .eq("id", figureId)
          .maybeSingle();
        if (rowErr) {
          logger.warn(
            { err: rowErr, figureId },
            "research_brain_figure_image_lookup_failed",
          );
          set.status = 500;
          return {
            error: "Failed to lookup figure",
            message: rowErr.message,
          };
        }
        if (!figureRow) {
          set.status = 404;
          return { error: "Figure not found" };
        }
        const storagePath = (figureRow as any).storage_path as
          | string
          | null
          | undefined;
        if (!storagePath) {
          set.status = 404;
          return { error: "Figure has no extracted image" };
        }
        const mimeType = ((figureRow as any).mime_type as string) || "image/png";
        const declaredByteSize = (figureRow as any).byte_size as number | null;
        if (
          typeof declaredByteSize === "number" &&
          declaredByteSize > MAX_FIGURE_BYTES
        ) {
          set.status = 413;
          return {
            error: "Image exceeds 50 MB cap",
            bytes: declaredByteSize,
          };
        }

        // 3. Download from S3 via the figureStorage helper. The
        //    helper throws `FigureNotFoundError` on a 404.
        let bytes: Uint8Array;
        try {
          bytes = await downloadFigure(storagePath);
        } catch (err) {
          if (err instanceof FigureNotFoundError) {
            set.status = 404;
            return { error: "Figure image not found in storage" };
          }
          throw err;
        }

        // 4. Re-check the actual size after download (defense in
        //    depth — the declared byte_size could be stale).
        if (bytes.byteLength > MAX_FIGURE_BYTES) {
          set.status = 413;
          return {
            error: "Image exceeds 50 MB cap",
            bytes: bytes.byteLength,
          };
        }

        // 5. Compute the file extension for Content-Disposition.
        const ext = mimeType === "image/jpeg" ? "jpg" : "png";
        const figureIndex = (figureRow as any).figure_index ?? 0;
        const safeIndex = String(figureIndex).replace(/[^\w-]/g, "_");
        const filename = `figure-${safeIndex}.${ext}`;

        const headers: Record<string, string> = {
          "Content-Type": mimeType,
          "Content-Length": String(bytes.byteLength),
          "Content-Disposition": `inline; filename="${filename}"`,
          "Cache-Control": "private, max-age=300",
        };
        return new Response(
          new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          { status: 200, headers },
        );
      } catch (error: any) {
        logger.error(
          { err: error, figureId },
          "research_brain_figure_image_failed",
        );
        set.status = 502;
        return {
          error: "Failed to proxy figure image",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .get(
    "/facts/:factId/provenance",
    async ({ params, set }) => {
      const { factId } = params;
      if (!factId) {
        set.status = 400;
        return { error: "Missing factId" };
      }

      try {
        // 1. Single round-trip load: the SELECT in
        //    getBioprospectingFact already embeds source, chunk,
        //    evidence_table, evidence_figure, and (PR #3)
        //    compound_canonical (per the spec's "Supabase foreign-key
        //    embed syntax" rule).
        const fact = await getBioprospectingFact(factId);
        if (!fact) {
          set.status = 404;
          return { error: "Fact not found" };
        }

        const sourceTitle = fact.source?.title || "";
        const doi = fact.doi ?? fact.source?.doi ?? null;
        const sourceId = fact.source_id ?? fact.source?.id ?? null;

        // PR #3 of bioprospecting-compound-authority: the
        // compound_canonical embed (added to getBioprospectingFact)
        // supplies canonical_name / inchi_key / pubchem_cid. The
        // lightbox reads this block to surface InChIKey + PubChem
        // CID on click per the spec's "Provenance viewer" rule.
        const compound = (fact as any).compound_canonical
          ? {
              canonicalName: (fact as any).compound_canonical.canonical_name ?? null,
              inchiKey: (fact as any).compound_canonical.inchi_key ?? null,
              pubchemCid: (fact as any).compound_canonical.pubchem_cid ?? null,
              molecularFormula:
                (fact as any).compound_canonical.molecular_formula ?? null,
            }
          : null;
        const compoundAuthority = {
          status:
            (fact as any).compound_authority_status ?? null,
          canonicalId: (fact as any).compound_canonical_id ?? null,
          at: (fact as any).compound_authority_at ?? null,
          error: (fact as any).compound_authority_error ?? null,
          attempts: (fact as any).compound_authority_attempts ?? null,
        };

        // 2. Precedence per spec §6.3:
        //      a. evidence_table_id + row resolvable  → "table"
        //      b. evidence_figure_id + row resolvable → "figure"
        //      c. chunk_id (or chunk_index)            → "chunk"
        //      d. otherwise                            → "text-only"
        //
        //    Each branch sets the provenance.type, populates the
        //    matching child object, and computes `bbox` (null for
        //    chunk and text-only branches).
        if (fact.evidence_table_id && (fact as any).evidence_table) {
          const table = (fact as any).evidence_table;
          return {
            factId: fact.id,
            sourceId,
            sourceTitle,
            doi,
            compound,
            compoundAuthority,
            provenance: {
              type: "table",
              table: {
                id: table.id,
                page: table.page,
                tableIndex: table.table_index,
                headers: table.headers,
                rows: table.rows,
                markdown: table.markdown,
                bbox: table.bbox,
                extractionProvider: table.extraction_provider,
                extractionConfidence: Number(table.extraction_confidence),
              },
              figure: null,
              chunk: fact.chunk
                ? {
                    id: fact.chunk.id,
                    page: fact.chunk.page,
                    chunkIndex: fact.chunk.chunk_index,
                    content: fact.chunk.content,
                  }
                : null,
              bbox: table.bbox ?? null,
            },
          };
        }

        if (fact.evidence_figure_id && (fact as any).evidence_figure) {
          const figure = (fact as any).evidence_figure;
          return {
            factId: fact.id,
            sourceId,
            sourceTitle,
            doi,
            compound,
            compoundAuthority,
            provenance: {
              type: "figure",
              table: null,
              figure: {
                id: figure.id,
                page: figure.page,
                figureIndex: figure.figure_index,
                bbox: figure.bbox,
                caption: figure.caption,
              },
              chunk: fact.chunk
                ? {
                    id: fact.chunk.id,
                    page: fact.chunk.page,
                    chunkIndex: fact.chunk.chunk_index,
                    content: fact.chunk.content,
                  }
                : null,
              bbox: figure.bbox ?? null,
            },
          };
        }

        if (fact.chunk) {
          return {
            factId: fact.id,
            sourceId,
            sourceTitle,
            doi,
            compound,
            compoundAuthority,
            provenance: {
              type: "chunk",
              table: null,
              figure: null,
              chunk: {
                id: fact.chunk.id,
                page: fact.chunk.page,
                chunkIndex: fact.chunk.chunk_index,
                content: fact.chunk.content,
              },
              bbox: null,
            },
          };
        }

        // No table, figure, or chunk → text-only fallback. The
        // spec's "text-only badge" requirement is satisfied by the
        // lightbox reading `provenance.type === "text-only"` and
        // rendering a grey badge in the header.
        return {
          factId: fact.id,
          sourceId,
          sourceTitle,
          doi,
          compound,
          compoundAuthority,
          provenance: {
            type: "text-only",
            table: null,
            figure: null,
            chunk: null,
            bbox: null,
          },
        };
      } catch (error: any) {
        logger.error(
          { err: error, factId },
          "research_brain_provenance_failed",
        );
        set.status = 500;
        return {
          error: "Failed to load fact provenance",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  // -------------------------------------------------------------------------
  // Compound Authority API (PR #3 of
  // `bioprospecting-compound-authority`).
  //
  // Four routes expose the compound authority subsystem to the admin UI:
  //   1. GET  /compounds/search?q=&limit=           — public read; search
  //   2. GET  /compounds/:canonicalId               — public read; lookup
  //   3. POST /compounds/:canonicalId/aliases       — admin only; add alias
  //   4. POST /facts/:factId/authority/promote      — admin only; re-promote
  //
  // Routes 1 + 2 are `required: false` because compound metadata is
  // not user PII. Routes 3 + 4 are admin-only because they mutate
  // canonical state and the audit trail.
  // -------------------------------------------------------------------------
  .get(
    "/compounds/search",
    async ({ query, set }) => {
      const parsed = (query || {}) as { q?: string; limit?: string };
      const q = (parsed.q || "").trim();
      if (!q) {
        set.status = 400;
        return { error: "missing query parameter q" };
      }
      const limit = parsed.limit
        ? Math.max(1, Math.min(100, Number(parsed.limit) || 25))
        : 25;
      try {
        const results = await searchCompoundsByName(q, limit);
        return { results };
      } catch (error: any) {
        logger.error(
          { err: error, q, limit },
          "compound_authority_search_failed",
        );
        set.status = 500;
        return {
          error: "Failed to search compounds",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .get(
    "/compounds/:canonicalId",
    async ({ params, set }) => {
      const { canonicalId } = params;
      if (!canonicalId) {
        set.status = 400;
        return { error: "Missing canonicalId" };
      }
      try {
        const compound = await getCanonicalById(canonicalId);
        if (!compound) {
          set.status = 404;
          return { error: "Compound not found" };
        }
        return { compound };
      } catch (error: any) {
        logger.error(
          { err: error, canonicalId },
          "compound_authority_get_failed",
        );
        set.status = 500;
        return {
          error: "Failed to load compound",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .post(
    "/compounds/:canonicalId/aliases",
    async ({ params, body, request, set }) => {
      const { canonicalId } = params;
      if (!canonicalId) {
        set.status = 400;
        return { error: "Missing canonicalId" };
      }
      const parsed = (body || {}) as {
        alias?: string;
        confidence?: "high" | "medium" | "low";
      };
      const alias = (parsed.alias || "").trim();
      if (!alias) {
        set.status = 400;
        return { error: "Missing alias" };
      }
      const confidence = parsed.confidence;
      if (
        confidence !== "high" &&
        confidence !== "medium" &&
        confidence !== "low"
      ) {
        set.status = 400;
        return { error: "Invalid confidence. Use: high|medium|low" };
      }
      const userId = (request as any).auth?.userId;
      if (!userId) {
        // Defense-in-depth: authResolver({ required: true, role: 'admin' })
        // should have rejected this already.
        set.status = 401;
        return { error: "Authentication required" };
      }
      try {
        const result = await addAlias({
          canonicalId,
          alias,
          confidence,
          userId,
          source: "manual",
        });
        set.status = 201;
        return { id: result.id };
      } catch (error: any) {
        logger.error(
          { err: error, canonicalId, alias },
          "compound_authority_alias_add_failed",
        );
        // FK violation on a missing canonical surfaces as a
        // Supabase error code 23503. Translate to 404.
        const code = (error && (error.code || error?.details)) as
          | string
          | undefined;
        if (
          code === "23503" ||
          /foreign key/i.test(error?.message ?? "")
        ) {
          set.status = 404;
          return { error: "Compound not found" };
        }
        set.status = 500;
        return {
          error: "Failed to add alias",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  )
  .post(
    "/facts/:factId/authority/promote",
    async ({ params, body, request, set }) => {
      const { factId } = params;
      if (!factId) {
        set.status = 400;
        return { error: "Missing factId" };
      }
      const parsed = (body || {}) as { reason?: string };
      const reason = (parsed.reason || "").trim();
      if (!reason) {
        set.status = 400;
        return { error: "Missing reason" };
      }
      const userId = (request as any).auth?.userId;
      if (!userId) {
        set.status = 401;
        return { error: "Authentication required" };
      }
      try {
        await promoteFactToPending({ factId, userId, reason });
        return { id: factId, compound_authority_status: "pending" };
      } catch (error: any) {
        const message = error?.message ?? "";
        if (message === "not in failed state") {
          set.status = 409;
          return { error: "not in failed state" };
        }
        if (message === "fact not found") {
          set.status = 404;
          return { error: "Fact not found" };
        }
        logger.error(
          { err: error, factId, reason },
          "compound_authority_promote_failed",
        );
        set.status = 500;
        return {
          error: "Failed to promote fact",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  )
  // -------------------------------------------------------------------------
  // Bioprospecting Review UI (admin-only).
  //
  // Four new admin-only routes that feed the `/admin` page:
  //   1. GET  /contradictions                 — global, paginated, filtered
  //   2. GET  /contradictions/stats           — today + last7d × 6 metrics
  //   3. GET  /dedup/events                   — paginated, time-windowed
  //   4. POST /dedup/:factId/unmerge          — soft-delete + audit row
  //
  // All routes are gated on `authResolver({ required: true, role: 'admin' })`
  // — non-admin callers get 401/403. The route layer maps the service
  // errors (NoActiveEdgeError → 409, FactNotFoundError → 404, etc.).
  // -------------------------------------------------------------------------
  .get(
    "/contradictions",
    async ({ query, set }) => {
      const parsed = (query || {}) as {
        status?: string;
        sourceId?: string;
        limit?: string;
        offset?: string;
      };
      const status = parsed.status?.toLowerCase();
      if (
        status &&
        status !== "unresolved" &&
        status !== "resolved" &&
        status !== "dismissed"
      ) {
        set.status = 400;
        return {
          error: "Invalid status. Use: unresolved|resolved|dismissed",
        };
      }
      const limitRaw = parsed.limit ?? "50";
      const offsetRaw = parsed.offset ?? "0";
      if (!/^-?\d+$/.test(limitRaw) || !/^-?\d+$/.test(offsetRaw)) {
        set.status = 400;
        return { error: "limit and offset must be integers" };
      }
      const limit = Math.max(1, Math.min(200, Number(limitRaw) || 50));
      const offset = Math.max(0, Number(offsetRaw) || 0);
      try {
        const result = await listContradictionsGlobal({
          status: status as
            | "unresolved"
            | "resolved"
            | "dismissed"
            | undefined,
          limit,
          offset,
        });
        return {
          contradictions: result.rows,
          total: result.total,
          limit: result.limit,
          offset: result.offset,
        };
      } catch (error: any) {
        logger.error(
          { err: error, status, limit, offset },
          "admin_contradictions_list_failed",
        );
        set.status = 500;
        return {
          error: "Failed to list contradictions",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  )
  .get(
    "/contradictions/stats",
    async ({ set }) => {
      try {
        return await getContradictionStats();
      } catch (error: any) {
        logger.error({ err: error }, "admin_contradictions_stats_failed");
        set.status = 500;
        return {
          error: "Failed to compute contradiction stats",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  )
  .get(
    "/dedup/events",
    async ({ query, set }) => {
      const parsed = (query || {}) as {
        limit?: string;
        offset?: string;
        since?: string;
      };
      const limitRaw = parsed.limit ?? "50";
      const offsetRaw = parsed.offset ?? "0";
      if (!/^-?\d+$/.test(limitRaw) || !/^-?\d+$/.test(offsetRaw)) {
        set.status = 400;
        return { error: "limit and offset must be integers" };
      }
      const limit = Math.max(1, Math.min(200, Number(limitRaw) || 50));
      const offset = Math.max(0, Number(offsetRaw) || 0);
      const sinceRaw = (parsed.since ?? "7d").toLowerCase();
      if (
        sinceRaw !== "24h" &&
        sinceRaw !== "7d" &&
        sinceRaw !== "30d" &&
        sinceRaw !== "all"
      ) {
        set.status = 400;
        return { error: "Invalid since. Use: 24h|7d|30d|all" };
      }
      const since = sinceRaw as DedupEventWindow;
      try {
        return await listRecentMergeEvents({ limit, offset, since });
      } catch (error: any) {
        logger.error(
          { err: error, limit, offset, since },
          "admin_dedup_events_list_failed",
        );
        set.status = 500;
        return {
          error: "Failed to list dedup events",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  )
  .post(
    "/dedup/:factId/unmerge",
    async ({ params, body, request, set }) => {
      const { factId } = params;
      if (!factId) {
        set.status = 400;
        return { error: "Missing factId" };
      }
      const parsed = (body || {}) as {
        reasonCode?: string;
        reasonDetail?: string | null;
      };
      const reasonCode = (parsed.reasonCode || "").toLowerCase();
      if (!REASON_CATEGORIES.includes(reasonCode as any)) {
        set.status = 400;
        return {
          error: "Invalid reasonCode",
          allowed: REASON_CATEGORIES,
        };
      }
      const userId = (request as any).auth?.userId;
      if (!userId) {
        // Defense-in-depth: authResolver({ required: true, role: 'admin' })
        // should have rejected this already.
        set.status = 401;
        return { error: "Authentication required" };
      }
      const reasonDetail =
        typeof parsed.reasonDetail === "string" && parsed.reasonDetail.trim()
          ? parsed.reasonDetail.trim()
          : null;
      try {
        return await unmergeFact({
          factId,
          userId,
          reason: reasonDetail,
          reasonCategory: reasonCode as any,
        });
      } catch (error: any) {
        if (error instanceof FactNotFoundError) {
          set.status = 404;
          return { error: "Fact not found" };
        }
        if (
          error instanceof NoActiveEdgeError ||
          error instanceof AmbiguousEdgeError
        ) {
          set.status = 409;
          return { error: error.message };
        }
        if (error instanceof InvalidReasonCategoryError) {
          set.status = 400;
          return { error: error.message };
        }
        logger.error(
          { err: error, factId, reasonCode },
          "admin_dedup_unmerge_failed",
        );
        set.status = 500;
        return {
          error: "Failed to unmerge fact",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  );

export default researchBrainRoute;
