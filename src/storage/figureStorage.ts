/**
 * Figure image storage helpers.
 *
 * Owns the S3 key construction + upload/download for figure image
 * bytes. Persists figure crops under `figures/{sourceId}/{figureIndex}.{format}`
 * on the same bucket the rest of the system uses for
 * `research_sources.file_path`. No new S3 client; delegates to the
 * existing `getStorageProvider()` from `src/storage/index.ts`.
 *
 * The helper follows the project's TDZ-safe pattern (no module-level
 * state, all cached singletons on `globalThis`) so Bun workers do not
 * hit TDZ on `process.env` (see CLAUDE.md).
 *
 * `getFigureStoragePath` is pure — safe to call in unit tests without
 * a storage backend.
 */

import logger from "../utils/logger";
import { getStorageProvider } from "./index";

/** Format selector for figure image bytes. PNG (lossless) is the v1
 * default; JPEG is reserved for a future per-figure entropy picker. */
export type FigureFormat = "png" | "jpeg";

/** IANA MIME type for the encoded image. Drives the proxy's
 * `Content-Type` response header. */
export type FigureMimeType = "image/png" | "image/jpeg";

/**
 * Suffix mapping: format → file extension. Lowercase, matching the
 * existing S3 layout convention (no uppercase extensions). */
function extensionFor(format: FigureFormat): string {
  return format === "jpeg" ? "jpg" : "png";
}

/** Map format → IANA MIME type. */
function mimeTypeFor(format: FigureFormat): FigureMimeType {
  return format === "jpeg" ? "image/jpeg" : "image/png";
}

/**
 * Build the canonical S3 key for a figure's image bytes.
 * Pure function — no I/O. Safe to call in unit tests.
 *
 * Layout: `figures/{sourceId}/{figureIndex}.{ext}`
 * - `{sourceId}` is the lowercase UUID the rest of the system uses.
 * - `{figureIndex}` is the 0-based ordinal on the page.
 * - `{ext}` is `png` for `image/png`, `jpg` for `image/jpeg`.
 */
export function getFigureStoragePath(
  sourceId: string,
  figureIndex: number,
  format: FigureFormat,
): string {
  if (!sourceId || typeof sourceId !== "string") {
    throw new Error("getFigureStoragePath: sourceId is required");
  }
  if (!Number.isFinite(figureIndex) || figureIndex < 0) {
    throw new Error(
      `getFigureStoragePath: figureIndex must be a non-negative integer, got ${figureIndex}`,
    );
  }
  return `figures/${sourceId}/${figureIndex}.${extensionFor(format)}`;
}

/**
 * Thrown by `downloadFigure` when the S3 object is missing. The
 * proxy route translates this to HTTP 404. The error carries the
 * key so callers can log it without re-deriving it.
 */
export class FigureNotFoundError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`S3 object not found: ${key}`);
    this.name = "FigureNotFoundError";
    this.key = key;
  }
}

/**
 * Upload figure image bytes to S3 at `key`. Returns the byte count
 * that was uploaded so the caller can persist it to `byte_size`.
 *
 * Delegates to `getStorageProvider().upload()`. Throws if no
 * storage provider is configured (the orchestrator's caller is
 * expected to check `getStorageProvider()` first; the throw is
 * the defense-in-depth path).
 */
export async function uploadFigure(
  key: string,
  bytes: Uint8Array,
  mimeType: FigureMimeType,
): Promise<{ byteSize: number }> {
  if (!key || typeof key !== "string") {
    throw new Error("uploadFigure: key is required");
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("uploadFigure: bytes must be a Uint8Array");
  }
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
    throw new Error(`uploadFigure: unsupported mimeType: ${mimeType}`);
  }

  const provider = getStorageProvider();
  if (!provider) {
    throw new Error(
      "uploadFigure: storage provider is not configured (STORAGE_PROVIDER env unset)",
    );
  }

  // The S3 provider's `upload` contract is `Buffer`; convert once.
  const buffer = Buffer.from(bytes);
  await provider.upload(key, buffer, mimeType);
  return { byteSize: bytes.byteLength };
}

/**
 * Download figure image bytes from S3 at `key`. Throws
 * `FigureNotFoundError` on a 404 (the proxy route catches and
 * returns 404). The S3 provider's underlying `download` throws a
 * generic `Error("S3 download failed: NoSuchKey - <key>")`; we
 * translate by inspecting the message (the existing S3 provider
 * already filters 404s to a custom message — see
 * `src/storage/providers/s3.ts:108`).
 */
export async function downloadFigure(key: string): Promise<Uint8Array> {
  if (!key || typeof key !== "string") {
    throw new Error("downloadFigure: key is required");
  }

  const provider = getStorageProvider();
  if (!provider) {
    throw new Error(
      "downloadFigure: storage provider is not configured (STORAGE_PROVIDER env unset)",
    );
  }

  let buffer: Buffer;
  try {
    buffer = await provider.download(key);
  } catch (err) {
    const msg = (err as Error).message || "";
    // The S3 provider throws a generic message; we use a known
    // substring ("NoSuchKey") to detect 404s. AWS SDK uses
    // "NoSuchKey" in `error.name` but the S3 provider collapses
    // that into its message string in `s3.ts:108`.
    if (/NoSuchKey|not found|404/i.test(msg) || (err as any).name === "NoSuchKey") {
      logger.warn({ key }, "figure_storage_download_not_found");
      throw new FigureNotFoundError(key);
    }
    throw err;
  }

  return new Uint8Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
}

/**
 * Test-only: clear the storage provider singleton so the next
 * `getStorageProvider()` call re-initializes from `process.env`.
 * Mirrors the `_reset…ForTests()` pattern used elsewhere in the
 * codebase (e.g. `localPdfTableProvider._resetMergeConfigForTests`).
 */
export function _resetFigureStorageForTests(): void {
  // No module-level state to clear; the storage provider is on
  // `globalThis` via `src/storage/index.ts` and the figureStorage
  // helper does not cache anything of its own. This hook exists
  // for future use when we add a per-key metadata cache.
  void logger;
}
