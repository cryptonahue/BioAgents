/**
 * Load a source's PDF bytes, from wherever they actually are.
 *
 * There are two places a paper can live and no single code path may assume
 * one of them: object storage (a bucket) or the local docs volume. This
 * deployment ingests straight to disk and configures no S3 at all.
 *
 * That assumption has already cost us twice. The PDF proxy returned 502 for
 * every paper until it grew a disk fallback, and table extraction bailed at
 * `no_storage_provider` and produced ZERO tables for months — silently,
 * because it returned an empty list rather than an error. Both were the same
 * bug written twice, which is the strongest argument there is for writing it
 * once.
 *
 * Order: the configured provider first (it is authoritative when present),
 * then disk. Returns null when neither has it — a caller must degrade, never
 * pretend.
 */
import { getStorageProvider } from "../../storage";
import { LocalStorageProvider } from "../../storage/providers/local";
import logger from "../../utils/logger";

export interface PdfSourceRef {
  id: string;
  file_path?: string | null;
}

export async function loadSourcePdf(
  source: PdfSourceRef,
): Promise<Uint8Array | null> {
  if (!source.file_path) {
    logger.info({ sourceId: source.id }, "pdf_load_no_file_path");
    return null;
  }

  let buffer: Buffer | null = null;

  const storage = getStorageProvider();
  if (storage) {
    try {
      buffer = await storage.download(source.file_path);
    } catch (error) {
      logger.warn(
        { err: error, sourceId: source.id, filePath: source.file_path },
        "pdf_load_storage_failed",
      );
    }
  }

  if (!buffer || buffer.length === 0) {
    // LocalStorageProvider carries the path-traversal guard and accepts the
    // `docs/<sub>/<file>.pdf` shape the ingester stores.
    const localRoot =
      process.env.LOCAL_STORAGE_ROOT ||
      process.env.KNOWLEDGE_DOCS_PATH ||
      "docs";
    try {
      buffer = await new LocalStorageProvider({ rootDir: localRoot }).download(
        source.file_path,
      );
    } catch (error) {
      logger.warn(
        {
          err: error,
          sourceId: source.id,
          filePath: source.file_path,
          localRoot,
        },
        "pdf_load_local_failed",
      );
    }
  }

  if (!buffer || buffer.length === 0) {
    logger.warn(
      {
        sourceId: source.id,
        filePath: source.file_path,
        hasStorage: Boolean(storage),
      },
      "pdf_load_unavailable",
    );
    return null;
  }

  return new Uint8Array(buffer);
}
