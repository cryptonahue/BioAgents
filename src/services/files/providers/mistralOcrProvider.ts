/**
 * Mistral OCR table extraction provider.
 *
 * Pure `fetch` HTTP client for the Mistral OCR endpoint. Activated by
 * the orchestrator when the local provider's output fails the quality
 * gate, OR when the `TABLE_EXTRACTION_PROVIDER=mistral` env var is set.
 *
 * Endpoint:
 *   POST https://api.mistral.ai/v1/ocr
 *   Authorization: Bearer ${MISTRAL_API_KEY}
 *   Content-Type: application/json
 *
 * Request:
 *   { model: "mistral-ocr-latest", document: { type: "document_url",
 *     document_url: "<data:application/pdf;base64,...>" },
 *     include_image_base64: <flag> }
 *
 * Response (paraphrased):
 *   { pages: [{ index, markdown, tables?: [...], images?: [{ bbox,
 *     caption, image_base64? }] }] }
 *
 * Strategy:
 *   - If Mistral returns structured `pages[i].tables`, use them and
 *     derive a markdown mirror via `renderTableToMarkdown`.
 *   - If Mistral only returns `pages[i].markdown`, store the markdown
 *     and return best-effort empty rows. The orchestrator's
 *     `buildTablesPromptSection` will use the markdown directly.
 *   - Bbox is in pixels relative to Mistral's OCR rasterization
 *     resolution. We divide by `DPI/72` to convert to PDF points.
 *   - Per-row confidence defaults to 0.5 when Mistral does not
 *     provide a per-block confidence (per the spec).
 *
 * PR #1 of figure-image-extraction: `include_image_base64` is
 * gated on `MISTRAL_OCR_INCLUDE_IMAGE_BASE64` (default `true`).
 * The base64 payload is decoded and surfaced to the
 * `figureImageExtractor` orchestrator via
 * `consumeMistralFigureBytes(sourceId)`. The orchestrator
 * drains the cache to avoid leaking bytes across sources.
 */

import type {
  BBox,
  ExtractedFigure,
  ExtractedTable,
  TableExtractionProvider,
} from "../pdfTableExtractor";
import { TableExtractionProviderError } from "../pdfTableExtractor";
import {
  checkCap,
  recordApiCall,
  CostCapExceededError,
  type ApiProvider,
  type CapScope,
} from "../../researchBrain/costService";
import logger from "../../../utils/logger";
import { renderTableToMarkdown } from "./localPdfTableProvider";

const MISTRAL_OCR_URL = "https://api.mistral.ai/v1/ocr";
const MISTRAL_MODEL = "mistral-ocr-latest";
const MISTRAL_PROVIDER: ApiProvider = "mistral_ocr";

/**
 * Provider-disabled flags (TDZ-safe via `globalThis`). Mirrors
 * `costService.flagKey` layout. Set when a `recordApiCall` reports
 * `cap_hit='day'|'month'`; the orchestrator reads them in
 * `pdfTableExtractor.ts` to short-circuit subsequent calls.
 *
 * The user can also pre-set `globalThis.__mistralOcrEnabled__ = false`
 * from a debug REPL to force-disable the provider without touching
 * the env var.
 */
function getEnabledFlag(): boolean {
  const g = globalThis as Record<string, unknown>;
  const cached = g.__mistralOcrEnabled__;
  if (typeof cached === "boolean") return cached;
  const env = process.env.MISTRAL_OCR_ENABLED;
  const enabled = env == null || env === "" ? true : env.toLowerCase() !== "false" && env !== "0";
  g.__mistralOcrEnabled__ = enabled;
  return enabled;
}

export function isMistralEnabled(): boolean {
  return getEnabledFlag();
}

/**
 * Default Mistral OCR rasterization DPI. Mistral's docs do not pin
 * a single value; 200 DPI is the typical default and matches what
 * their playground uses for table bbox output.
 */
const MISTRAL_DEFAULT_DPI = 200;
const PDFJS_PT_PER_INCH = 72;
const DEFAULT_PIXEL_TO_PT = PDFJS_PT_PER_INCH / MISTRAL_DEFAULT_DPI;

type MistralResponsePage = {
  index?: number;
  markdown?: string;
  tables?: Array<{
    headers?: string[];
    rows?: string[][];
    bbox?: { x: number; y: number; w: number; h: number };
    confidence?: number;
  }>;
  images?: Array<{
    bbox?: { x: number; y: number; w: number; h: number };
    caption?: string;
    /**
     * PR #1 of figure-image-extraction: base64-encoded image bytes
     * returned by Mistral when `include_image_base64=true`. The
     * Mistral OCR API may emit a `data:` URL prefix (e.g.
     * `data:image/png;base64,...`) OR a raw b64 string. The
     * decoder in this provider tolerates both forms. */
    image_base64?: string;
  }>;
};

type MistralResponse = {
  pages?: MistralResponsePage[];
};

/**
 * Per-source cache of decoded figure image bytes. Keyed by sourceId
 * (so concurrent sources don't clobber each other); within a source
 * the per-figure key is `${page}:${figureIndex}` (1-indexed page,
 * 0-based figureIndex on the page).
 *
 * The cache is filled by `extractFigures` and drained by the
 * orchestrator via `consumeMistralFigureBytes(sourceId)`. The
 * drain pattern is intentional: once the orchestrator has
 * persisted the bytes, the cache is no longer needed and a stale
 * entry from a prior run would only confuse debugging.
 *
 * `globalThis` memoization avoids TDZ in Bun workers (see
 * CLAUDE.md).
 */
type MistralFigureBytesMap = Map<string, Uint8Array>;

const MISTRAL_FIGURE_BYTES_KEY = "__bioprospectingMistralFigureBytes";

interface MistralFigureBytesStore {
  bySource: Map<string, MistralFigureBytesMap>;
}

function getFigureBytesStore(): MistralFigureBytesStore {
  let s = (globalThis as any)[MISTRAL_FIGURE_BYTES_KEY] as
    | MistralFigureBytesStore
    | undefined;
  if (!s) {
    s = { bySource: new Map() };
    (globalThis as any)[MISTRAL_FIGURE_BYTES_KEY] = s;
  }
  return s;
}

/**
 * Drain the figure bytes for a source. The orchestrator calls this
 * exactly once per source. The map is deleted from the store
 * (drain semantics) so subsequent calls return an empty map.
 */
export function consumeMistralFigureBytes(
  sourceId: string,
): MistralFigureBytesMap {
  const store = getFigureBytesStore();
  const m = store.bySource.get(sourceId);
  if (!m) return new Map();
  store.bySource.delete(sourceId);
  return m;
}

/**
 * TDZ-safe env resolution for the `include_image_base64` flag.
 * Default `true` (PR #1 of figure-image-extraction).
 */
const MISTRAL_INCLUDE_B64_KEY = "__bioprospectingMistralIncludeImageBase64";

function resolveIncludeImageBase64(): boolean {
  const cached = (globalThis as any)[MISTRAL_INCLUDE_B64_KEY] as
    | boolean
    | undefined;
  if (typeof cached === "boolean") return cached;
  const raw = process.env.MISTRAL_OCR_INCLUDE_IMAGE_BASE64;
  // Default true unless explicitly set to "false" or "0".
  const enabled = raw == null || raw === "" ? true : raw.toLowerCase() !== "false" && raw !== "0";
  (globalThis as any)[MISTRAL_INCLUDE_B64_KEY] = enabled;
  return enabled;
}

/** Test-only hook to force a re-read of the env var. */
export function _resetMistralIncludeImageBase64ForTests(): void {
  delete (globalThis as any)[MISTRAL_INCLUDE_B64_KEY];
}

export class MistralTableExtractionProvider implements TableExtractionProvider {
  readonly name = "mistral" as const;

  private readonly apiKey: string | null;
  private readonly dpi: number;

  constructor(opts?: { apiKey?: string; dpi?: number }) {
    this.apiKey = opts?.apiKey ?? process.env.MISTRAL_API_KEY ?? null;
    this.dpi =
      opts?.dpi ?? readPositiveInt("MISTRAL_OCR_DPI", MISTRAL_DEFAULT_DPI);
  }

  /**
   * Estimate the page count of a PDF using a safe over-count
   * formula: ~1 page per 100KB. Used by the pre-call cost check
   * to bound the worst-case spend BEFORE the HTTP call.
   */
  static estimatePages(pdf: Uint8Array): number {
    return Math.max(1, Math.ceil(pdf.byteLength / 100_000));
  }

  /**
   * Read the configured per-page USD cost for Mistral OCR.
   * Mirrors `llm-cost.calculateCost('mistral-ocr', ...)` so the
   * pre-check estimate matches the post-call `recordApiCall`
   * increment.
   */
  static costPerPageUsd(): number {
    const raw = process.env.MISTRAL_OCR_COST_PER_PAGE_USD;
    if (raw != null && raw !== "" && !Number.isNaN(Number(raw))) {
      return Number(raw);
    }
    return 0.05;
  }

  async extract(
    pdf: Uint8Array,
    ctx?: { runId?: string; sourceId?: string },
  ): Promise<ExtractedTable[]> {
    const response = await this.runWithCostCap(pdf, ctx, "extract");
    const pixelToPt = PDFJS_PT_PER_INCH / this.dpi;
    const tables: ExtractedTable[] = [];

    const pages = response.pages || [];
    for (const page of pages) {
      const pageNum = (page.index ?? 0) + 1; // Mistral is 0-indexed
      const pageTables = page.tables || [];

      if (pageTables.length === 0) {
        // Markdown-only fallback: emit a single best-effort table
        // carrying the page markdown. Rows are empty; the LLM will
        // use the markdown directly via the prompt builder.
        if (page.markdown) {
          const bbox = pageBboxFromMarkdown(page, pixelToPt, pageNum);
          tables.push({
            page: pageNum,
            tableIndex: 0,
            headers: [],
            rows: [],
            bbox,
            confidence: 0.5,
            markdown: page.markdown,
          });
        }
        continue;
      }

      for (let i = 0; i < pageTables.length; i++) {
        const pt = pageTables[i];
        const headers = Array.isArray(pt.headers) ? pt.headers : [];
        const rows = Array.isArray(pt.rows)
          ? pt.rows.map((r) =>
              Array.isArray(r)
                ? r.map((c) => (typeof c === "string" ? c : String(c ?? "")))
                : [],
            )
          : [];
        const bbox: BBox = pt.bbox
          ? {
              x: pt.bbox.x * pixelToPt,
              y: pt.bbox.y * pixelToPt,
              w: pt.bbox.w * pixelToPt,
              h: pt.bbox.h * pixelToPt,
              page: pageNum,
              units: "pt",
            }
          : { x: 0, y: 0, w: 0, h: 0, page: pageNum, units: "pt" };
        const confidence =
          typeof pt.confidence === "number"
            ? Math.max(0, Math.min(1, pt.confidence))
            : 0.5;
        const markdown = page.markdown ?? renderTableToMarkdown(headers, rows);
        tables.push({
          page: pageNum,
          tableIndex: i,
          headers,
          rows,
          bbox,
          confidence,
          markdown,
        });
      }
    }

    return tables;
  }

  async extractFigures(
    pdf: Uint8Array,
    ctx?: { runId?: string; sourceId?: string },
  ): Promise<ExtractedFigure[]> {
    const response = await this.runWithCostCap(pdf, ctx, "extractFigures");
    const pixelToPt = PDFJS_PT_PER_INCH / this.dpi;
    const out: ExtractedFigure[] = [];
    const pages = response.pages || [];
    const includeB64 = resolveIncludeImageBase64();

    // Per-source figure bytes cache. The orchestrator drains this
    // via `consumeMistralFigureBytes(sourceId)` after `extractPDFTables`
    // returns.
    const figureBytes: MistralFigureBytesMap = new Map();

    for (const page of pages) {
      const pageNum = (page.index ?? 0) + 1;
      const images = page.images || [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (!img.bbox) continue;

        // Decode base64 when the flag is on. The decoder tolerates
        // both standard and URL-safe alphabets; decode failures
        // are WARN-logged and treated as "no image for this
        // figure" (the render-crop path gets a chance).
        let decodedBytes: Uint8Array | null = null;
        if (includeB64 && typeof img.image_base64 === "string" && img.image_base64.length > 0) {
          try {
            decodedBytes = decodeBase64Flexible(img.image_base64);
          } catch (err) {
            logger.warn(
              {
                err,
                event: "mistral_image_base64_decode_failed",
                sourceId: ctx?.sourceId,
                page: pageNum,
                figureIndex: i,
              },
              "Mistral image_base64 decode failed; falling through to render-crop",
            );
            decodedBytes = null;
          }
        }

        if (decodedBytes && decodedBytes.byteLength > 0) {
          figureBytes.set(`${pageNum}:${i}`, decodedBytes);
        }

        out.push({
          page: pageNum,
          figureIndex: i,
          bbox: {
            x: img.bbox.x * pixelToPt,
            y: img.bbox.y * pixelToPt,
            w: img.bbox.w * pixelToPt,
            h: img.bbox.h * pixelToPt,
            page: pageNum,
            units: "pt",
          },
          caption: img.caption ?? null,
        });
      }
    }

    // Persist the bytes to the process-local store, keyed by
    // sourceId. The orchestrator consumes (drains) this.
    if (figureBytes.size > 0 && ctx?.sourceId) {
      const store = getFigureBytesStore();
      store.bySource.set(ctx.sourceId, figureBytes);
    }

    return out;
  }

  /**
   * Run the Mistral HTTP call inside the cost-cap wrap: enabled-flag
   * short-circuit, pre-call `checkCap`, the HTTP call, and the
   * post-call `recordApiCall`. Throws `CostCapExceededError` on a
   * cap hit so the orchestrator can fall back to `local`.
   *
   * `path` is the public method name (`extract` | `extractFigures`)
   * used only for log fields. The two public methods share this
   * helper to keep the wrap logic single-sourced.
   */
  private async runWithCostCap(
    pdf: Uint8Array,
    ctx: { runId?: string; sourceId?: string } | undefined,
    path: "extract" | "extractFigures",
  ): Promise<MistralResponse> {
    if (!getEnabledFlag()) {
      throw new TableExtractionProviderError(
        "MISTRAL_OCR_ENABLED=false; Mistral OCR is disabled",
      );
    }

    const estimatedPages = MistralTableExtractionProvider.estimatePages(pdf);
    const estimatedCostUsd =
      estimatedPages * MistralTableExtractionProvider.costPerPageUsd();
    const pre = await checkCap({
      provider: MISTRAL_PROVIDER,
      estimatedCostUsd,
      sourceId: ctx?.sourceId,
      runId: ctx?.runId,
    });
    if (!pre.allowed) {
      const scope: CapScope = pre.wouldHitPerSource
        ? "source"
        : pre.wouldHitDaily
          ? "day"
          : pre.wouldHitMonthly
            ? "month"
            : "run";
      logger.warn(
        {
          event: "mistral_cap_precheck",
          sourceId: ctx?.sourceId,
          runId: ctx?.runId,
          scope,
          estimatedCostUsd,
          estimatedPages,
          path,
        },
        "Mistral OCR pre-call cap check failed; aborting",
      );
      throw new CostCapExceededError({ scope, provider: MISTRAL_PROVIDER });
    }

    const response = await this.callOcr(pdf);

    const actualUnits = response.pages?.length ?? 0;
    const actualCostUsd =
      actualUnits * MistralTableExtractionProvider.costPerPageUsd();

    // PR #1 of figure-image-extraction: thread the parsed image
    // base64 byte total + image count into the `recordApiCall`
    // metadata. The orchestrator consumes the bytes via
    // `consumeMistralFigureBytes`; we calculate the total here
    // for the metadata block. When `MISTRAL_OCR_INCLUDE_IMAGE_BASE64`
    // is false, the totals are 0.
    let imageBytesTotal = 0;
    let imageCount = 0;
    if (resolveIncludeImageBase64()) {
      for (const page of response.pages || []) {
        const images = page.images || [];
        for (const img of images) {
          if (typeof img.image_base64 === "string" && img.image_base64.length > 0) {
            try {
              const decoded = decodeBase64Flexible(img.image_base64);
              imageBytesTotal += decoded.byteLength;
              imageCount++;
            } catch {
              // Skip decode failures here — the orchestrator's
              // own decode pass is the authoritative one.
            }
          }
        }
      }
    }

    const post = await recordApiCall({
      provider: MISTRAL_PROVIDER,
      units: actualUnits,
      costUsd: actualCostUsd,
      sourceId: ctx?.sourceId,
      runId: ctx?.runId,
      metadata:
        imageCount > 0
          ? {
              image_bytes_total: imageBytesTotal,
              image_count: imageCount,
            }
          : undefined,
    });
    if (post.capHit) {
      logger.warn(
        {
          event:
            post.capHit === "month"
              ? "mistral_disabled_this_month"
              : "mistral_disabled_today",
          sourceId: ctx?.sourceId,
          runId: ctx?.runId,
          scope: post.capHit,
          actualCostUsd,
          actualUnits,
          path,
        },
        "Mistral OCR call crossed a cap; orchestrator will fall back to local",
      );
      throw new CostCapExceededError({
        scope: post.capHit,
        provider: MISTRAL_PROVIDER,
      });
    }

    return response;
  }

  private async callOcr(pdf: Uint8Array): Promise<MistralResponse> {
    if (!this.apiKey) {
      throw new TableExtractionProviderError(
        "MISTRAL_API_KEY is not set; cannot call Mistral OCR",
      );
    }

    const base64 = bytesToBase64(pdf);
    const documentUrl = `data:application/pdf;base64,${base64}`;

    // PR #1 of figure-image-extraction: gate `include_image_base64`
    // on the env var. Default `true`. When false, the request body
    // restores pre-change behavior (no image base64 in the
    // response, no Mistral raster path).
    const includeB64 = resolveIncludeImageBase64();

    let response: Response;
    try {
      response = await fetch(MISTRAL_OCR_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MISTRAL_MODEL,
          document: {
            type: "document_url",
            document_url: documentUrl,
          },
          include_image_base64: includeB64,
        }),
      });
    } catch (error) {
      throw new TableExtractionProviderError(
        `Mistral OCR request failed: ${(error as Error).message ?? String(error)}`,
        error,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new TableExtractionProviderError(
        `Mistral OCR returned ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    try {
      return (await response.json()) as MistralResponse;
    } catch (error) {
      throw new TableExtractionProviderError(
        `Mistral OCR returned non-JSON body: ${(error as Error).message ?? String(error)}`,
        error,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pageBboxFromMarkdown(
  page: MistralResponsePage,
  pixelToPt: number,
  pageNum: number,
): BBox {
  // Mistral markdown-only pages don't carry a bbox; default to a
  // full-page bbox so the viewer at least knows which page to show.
  if (page.images?.[0]?.bbox) {
    const b = page.images[0].bbox;
    return {
      x: b.x * pixelToPt,
      y: b.y * pixelToPt,
      w: b.w * pixelToPt,
      h: b.h * pixelToPt,
      page: pageNum,
      units: "pt",
    };
  }
  return { x: 0, y: 0, w: 0, h: 0, page: pageNum, units: "pt" };
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name] || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Use Bun's fast base64 encoder when available; fallback to
  // the manual decoder for other runtimes.
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // @ts-ignore - btoa is available in browsers; not in Node
  if (typeof btoa === "function") return btoa(binary);
  // Fallback manual encoder
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | (b >> 4)];
    out += chars[((b & 15) << 2) | (c >> 6)];
    out += chars[c & 63];
  }
  if (i < bytes.length) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? chars[(b & 15) << 2] : "=";
    out += "=";
  }
  return out;
}

/**
 * Decode a base64 string tolerating both standard and URL-safe
 * alphabets. Mistral OCR may emit either form depending on the
 * payload path. We strip a `data:<mime>;base64,` prefix if
 * present, replace URL-safe chars (`-` and `_`) with their
 * standard equivalents, and decode via `Buffer.from(b64, 'base64')`
 * (which ignores padding).
 */
function decodeBase64Flexible(input: string): Uint8Array {
  let s = input.trim();
  // Strip data: URL prefix if present
  const dataPrefix = /^data:[^;]+;base64,/i;
  if (dataPrefix.test(s)) {
    s = s.replace(dataPrefix, "");
  }
  // URL-safe → standard alphabet
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  // Strip whitespace
  s = s.replace(/\s+/g, "");
  if (s.length === 0) {
    throw new Error("empty base64 payload");
  }
  // Buffer.from with 'base64' encoding is permissive about
  // padding (it ignores missing '=' chars at the end) and
  // ignores invalid chars. This matches the spec's tolerance.
  const buf = Buffer.from(s, "base64");
  if (buf.length === 0) {
    throw new Error("base64 decode produced empty buffer");
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
