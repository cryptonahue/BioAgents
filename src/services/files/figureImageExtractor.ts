/**
 * Figure image extractor orchestrator.
 *
 * Runs the v1 image-extraction pipeline for a single source AFTER
 * the table-extraction pass writes the bbox rows. The pipeline has
 * two tracks:
 *
 *   1. Mistral raster path (preferred when Mistral returned base64
 *      image bytes for the figure — see the Mistral provider's
 *      `consumeMistralFigureBytes` helper).
 *   2. Render-crop vector path (fallback; renders the PDF page and
 *      crops the bbox region via `renderCroppedFigure`).
 *
 * For each figure with `bytes !== null`, the orchestrator:
 *   1. Builds the S3 key (`figures/{sourceId}/{figureIndex}.{format}`).
 *   2. Uploads the bytes via `uploadFigure`.
 *   3. UPDATEs the row with all 5 image columns atomically.
 *   4. Accumulates the per-source byte total.
 *
 * After the loop, fires a single `recordApiCall` per source with
 * `units: totalBytes, costUsd: 0, metadata: { kind: 'figure_image_bytes', ... }`.
 * `costUsd: 0` is intentional — the bytes are an informational
 * observation, not a new cost line (the table-extraction call's
 * `costUsd` already covers the Mistral page price).
 *
 * Failure handling:
 *   - Per-figure try/catch (S3 failure → WARN + leave row NULL).
 *   - The orchestrator's outer try/catch at the call site
 *     (`pdfTableExtractor.extractPDFTables`) catches any throw
 *     and logs `pdf_figure_image_extraction_failed` so a
 *     misconfigured S3 doesn't roll back the table rows.
 *
 * Write-once guard: rows with `storage_path IS NOT NULL` are
 * skipped (the spec's Idempotent Extraction contract).
 */

import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";
import { recordApiCall } from "../researchBrain/costService";
import {
  FigureFormat,
  FigureMimeType,
  getFigureStoragePath,
  uploadFigure,
} from "../../storage/figureStorage";
import {
  renderCroppedFigure,
  FigureRenderCropError,
} from "./renderCrop";
import type { BBox, ResearchEvidenceFigureRow } from "./pdfTableExtractor";
import { consumeMistralFigureBytes } from "./providers/mistralOcrProvider";

/** Per-figure result from the orchestrator. Mirrors `ExtractedFigure`
 * with the image fields populated post-extraction. */
export interface ExtractedFigureImage {
  page: number;
  figureIndex: number;
  bbox: BBox;
  bytes: Uint8Array | null;
  format: FigureFormat | null;
  width: number | null;
  height: number | null;
  byteSize: number | null;
  origin: "mistral" | "render-crop" | null;
}

/** Orchestrator context. `runId` / `jobId` are passed to
 * `costService.recordApiCall` for the per-run cap. */
export interface ExtractFigureImagesContext {
  runId?: string;
  jobId?: string;
}

/**
 * Run the v1 figure-image extraction pipeline for a source.
 *
 * The function is defensive: a single figure's failure MUST NOT
 * abort the source's other figures. Each figure is wrapped in
 * try/catch. The function returns one `ExtractedFigureImage` per
 * figure row read from `research_evidence_figures`, even if all
 * paths failed (the caller can then enumerate the partial-success
 * state from the return value).
 */
export async function extractFigureImages(
  sourceId: string,
  pdf: Uint8Array,
  ctx: ExtractFigureImagesContext = {},
): Promise<ExtractedFigureImage[]> {
  if (!sourceId || typeof sourceId !== "string") {
    logger.warn(
      { sourceId, event: "figure_image_extract_invalid_source" },
      "extractFigureImages: sourceId is required",
    );
    return [];
  }

  // Read the figure rows. The write-once guard is a SQL filter:
  // we only fetch rows that need processing. A row whose
  // `storage_path` is non-null is already-extracted and is
  // returned by `loadFiguresForSource` but skipped from the loop.
  const rows = await loadFiguresForSourceInternal(sourceId);
  if (rows.length === 0) {
    return [];
  }

  // Snapshot the Mistral raster bytes for this source. The provider
  // holds a process-local cache keyed by `(page, figureIndex)`. The
  // cache is consumed (drained) by this call so subsequent calls do
  // not see stale data.
  const mistralBytes = consumeMistralFigureBytes(sourceId);

  const out: ExtractedFigureImage[] = [];
  let totalBytes = 0;
  let imageCount = 0;
  const originCounts = { mistral: 0, "render-crop": 0, "bbox-only": 0 };

  for (const row of rows) {
    // Write-once guard
    if (row.storage_path) {
      out.push({
        page: row.page,
        figureIndex: row.figure_index,
        bbox: row.bbox,
        bytes: null,
        format: null,
        width: null,
        height: null,
        byteSize: null,
        origin: null,
      });
      continue;
    }

    // Per-figure try/catch
    try {
      const result = await extractOneFigure(
        sourceId,
        row,
        pdf,
        mistralBytes,
        ctx,
      );
      out.push(result);
      if (result.bytes && result.byteSize) {
        totalBytes += result.byteSize;
        imageCount++;
        if (result.origin) {
          originCounts[result.origin]++;
        }
      } else {
        originCounts["bbox-only"]++;
      }
    } catch (err) {
      logger.warn(
        {
          err,
          event: "figure_image_extraction_failed",
          sourceId,
          figureIndex: row.figure_index,
          page: row.page,
        },
        "figure_image_extraction_failed: leaving row null",
      );
      out.push({
        page: row.page,
        figureIndex: row.figure_index,
        bbox: row.bbox,
        bytes: null,
        format: null,
        width: null,
        height: null,
        byteSize: null,
        origin: null,
      });
      originCounts["bbox-only"]++;
    }
  }

  // Single per-source `recordApiCall` for the byte total. `costUsd: 0`
  // is intentional — informational, not a new cost line.
  if (totalBytes > 0) {
    try {
      await recordApiCall({
        provider: "mistral_ocr",
        units: totalBytes,
        costUsd: 0,
        runId: ctx.runId,
        sourceId,
        metadata: {
          kind: "figure_image_bytes",
          image_count: imageCount,
          image_bytes_total: totalBytes,
        },
      });
    } catch (err) {
      // recordApiCall never throws (it soft-fails), but guard for
      // future contract changes.
      logger.warn(
        { err, sourceId, event: "figure_image_cost_record_failed" },
        "figure_image: recordApiCall failed; continuing",
      );
    }
  }

  // Structured completion log
  logger.info(
    {
      event: "pdf_figure_image_extraction_complete",
      sourceId,
      figureCount: rows.length,
      imageCount,
      byteTotal: totalBytes,
      originCounts,
    },
    "pdf_figure_image_extraction_complete",
  );

  return out;
}

/**
 * Extract the image bytes for a single figure row. Tries Mistral
 * first, then render-crop. Returns an `ExtractedFigureImage` with
 * either the populated bytes/format/width/height/byteSize fields
 * OR all-null fields (the bbox-only case).
 */
async function extractOneFigure(
  sourceId: string,
  row: ResearchEvidenceFigureRow,
  pdf: Uint8Array,
  mistralBytes: Map<string, Uint8Array>,
  ctx: ExtractFigureImagesContext,
): Promise<ExtractedFigureImage> {
  // 1. Try the Mistral raster path
  const mistralKey = figureKey(row.page, row.figure_index);
  const mistralBytesForFigure = mistralBytes.get(mistralKey);
  if (mistralBytesForFigure && mistralBytesForFigure.byteLength > 0) {
    const written = await persistFigureBytes(
      sourceId,
      row,
      mistralBytesForFigure,
      "png", // Mistral returns image_base64 in PNG; the parser
             // could also detect JPEG via the data: URL prefix.
             // The current Mistral OCR docs default to PNG.
      "mistral",
      ctx,
    );
    return written;
  }

  // 2. Fall back to render-crop
  const format: FigureFormat = "png";
  try {
    const rendered = await renderCroppedFigure(
      pdf,
      row.page,
      row.bbox,
      format,
    );
    const written = await persistFigureBytes(
      sourceId,
      row,
      rendered.bytes,
      format,
      "render-crop",
      ctx,
    );
    return {
      ...written,
      width: rendered.width,
      height: rendered.height,
    };
  } catch (err) {
    if (err instanceof FigureRenderCropError) {
      logger.warn(
        {
          event: "figure_image_render_crop_failed",
          sourceId,
          page: row.page,
          figureIndex: row.figure_index,
          reason: err.reason,
        },
        "render-crop failed; leaving figure as bbox-only",
      );
      return {
        page: row.page,
        figureIndex: row.figure_index,
        bbox: row.bbox,
        bytes: null,
        format: null,
        width: null,
        height: null,
        byteSize: null,
        origin: null,
      };
    }
    throw err;
  }
}

/**
 * Upload the bytes to S3, UPDATE the row with the 5 image columns,
 * and return the populated `ExtractedFigureImage`. On S3 failure
 * the row is left NULL and a WARN is logged; the caller treats
 * the figure as bbox-only.
 */
async function persistFigureBytes(
  sourceId: string,
  row: ResearchEvidenceFigureRow,
  bytes: Uint8Array,
  format: FigureFormat,
  origin: "mistral" | "render-crop",
  _ctx: ExtractFigureImagesContext,
): Promise<ExtractedFigureImage> {
  const key = getFigureStoragePath(sourceId, row.figure_index, format);
  const mime: FigureMimeType = format === "jpeg" ? "image/jpeg" : "image/png";

  let byteSize: number;
  try {
    const upload = await uploadFigure(key, bytes, mime);
    byteSize = upload.byteSize;
  } catch (err) {
    logger.warn(
      {
        err,
        event: "figure_image_upload_failed",
        sourceId,
        figureIndex: row.figure_index,
        page: row.page,
        key,
      },
      "figure_image_upload_failed: leaving row null",
    );
    return {
      page: row.page,
      figureIndex: row.figure_index,
      bbox: row.bbox,
      bytes: null,
      format: null,
      width: null,
      height: null,
      byteSize: null,
      origin: null,
    };
  }

  // Pixel dimensions: best-effort. For the Mistral path we have
  // no clean way to recover width/height from the raw bytes in
  // v1 (no PNG/JPEG decoder in the helper). We set them to NULL
  // and let the viewer size the <img> from the natural aspect
  // ratio; the spec accepts this for the v1 informational
  // surface. The render-crop path passes the canvas width/height
  // back via the caller, which sets them on the result.
  let width: number | null = null;
  let height: number | null = null;

  // Best-effort PNG width/height probe (bytes 16-23 of a valid
  // PNG are the IHDR width/height big-endian uint32s). This
  // avoids pulling in a PNG decoder.
  if (format === "png" && bytes.length >= 24) {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    let isPng = true;
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== sig[i]) {
        isPng = false;
        break;
      }
    }
    if (isPng) {
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      width = view.getUint32(16);
      height = view.getUint32(20);
    }
  }

  // UPDATE the row atomically. The Supabase client returns
  // `{ data, error }`; we treat any error as a soft failure (WARN
  // + return the bytes anyway, so the caller's accounting is
  // consistent with what was uploaded).
  try {
    const sb = getServiceClient();
    const { error: updateErr } = await sb
      .from("research_evidence_figures")
      .update({
        storage_path: key,
        mime_type: mime,
        width,
        height,
        byte_size: byteSize,
      })
      .eq("id", row.id);
    if (updateErr) {
      logger.warn(
        {
          err: updateErr,
          event: "figure_image_row_update_failed",
          sourceId,
          figureIndex: row.figure_index,
          page: row.page,
        },
        "figure_image: row update failed; S3 object remains",
      );
    }
  } catch (err) {
    logger.warn(
      {
        err,
        event: "figure_image_row_update_threw",
        sourceId,
        figureIndex: row.figure_index,
        page: row.page,
      },
      "figure_image: row update threw; S3 object remains",
    );
  }

  return {
    page: row.page,
    figureIndex: row.figure_index,
    bbox: row.bbox,
    bytes,
    format,
    width,
    height,
    byteSize,
    origin,
  };
}

/**
 * Internal: load the figure rows for a source WITHOUT the cost of
 * re-importing `pdfTableExtractor` (avoids a circular import —
 * the orchestrator lives in the same directory as the table
 * extractor, but we want a clean split).
 *
 * Mirrors `loadFiguresForSource` from `pdfTableExtractor.ts` but
 * is private to this module so callers don't have to thread the
 * `ResearchEvidenceFigureRow` type.
 */
async function loadFiguresForSourceInternal(
  sourceId: string,
): Promise<ResearchEvidenceFigureRow[]> {
  const sb = getServiceClient();
  const { data, error } = await sb
    .from("research_evidence_figures")
    .select("*")
    .eq("source_id", sourceId)
    .order("page", { ascending: true })
    .order("figure_index", { ascending: true });
  if (error) {
    logger.warn(
      { err: error, sourceId },
      "figure_image_load_figures_failed",
    );
    return [];
  }
  return (data || []) as ResearchEvidenceFigureRow[];
}

/** Internal: build a (page, figureIndex) → key string. */
function figureKey(page: number, figureIndex: number): string {
  return `${page}:${figureIndex}`;
}
