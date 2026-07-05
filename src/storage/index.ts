import logger from "../utils/logger";
import { STORAGE_CONFIG } from "./config";
import { LocalStorageProvider } from "./providers/local";
import type { StorageProvider } from "./types";

/**
 * Create a storage provider based on environment configuration.
 *
 * `S3StorageProvider` is loaded lazily (sync `require`) so that
 * loading this module does not eagerly evaluate the S3 class body
 * and trip the Bun TDZ ordering bug when `StorageProvider` is still
 * being initialized (see CLAUDE.md "TDZ in worker processes").
 */
function createStorageProvider(): StorageProvider | null {
  const { provider, s3, local } = STORAGE_CONFIG;

  if (!provider) {
    if (logger) {
      logger.warn(
        "STORAGE_PROVIDER not configured. File uploads will not be persisted to cloud storage.",
      );
    }
    return null;
  }

  switch (provider) {
    case "s3": {
      if (!s3.accessKeyId || !s3.secretAccessKey || !s3.bucket) {
        throw new Error(
          "S3 storage provider requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and S3_BUCKET environment variables",
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { S3StorageProvider } = require("./providers/s3") as typeof import("./providers/s3");
      return new S3StorageProvider({
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
        region: s3.region,
        bucket: s3.bucket,
        endpoint: s3.endpoint,
      });
    }

    case "local": {
      if (logger) {
        logger.info(
          { rootDir: local.rootDir },
          "LocalStorageProvider initialized (read-only proxy for files on disk)",
        );
      }
      return new LocalStorageProvider({ rootDir: local.rootDir });
    }

    default:
      throw new Error(
        `Unknown storage provider: ${provider}. Supported providers: s3, local`,
      );
  }
}

// Singleton instance
let storageProviderInstance: StorageProvider | null | undefined;

/**
 * Get the configured storage provider instance (singleton)
 */
export function getStorageProvider(): StorageProvider | null {
  if (storageProviderInstance === undefined) {
    storageProviderInstance = createStorageProvider();
  }
  return storageProviderInstance;
}

/**
 * Check if a storage provider is available without throwing an exception
 */
export function isStorageProviderAvailable(): boolean {
  try {
    const provider = getStorageProvider();
    return provider !== null;
  } catch {
    return false;
  }
}

/**
 * Default base storage path for a conversation
 */
export const getConversationBasePath = (
  userId: string,
  conversationId: string,
): string => `user/${userId}/conversation/${conversationId}`;

/**
 * Default storage path template for uploaded files
 */
export const getUploadPath = (filename: string): string =>
  `uploads/${filename}`;

/**
 * Full storage path for a file upload
 * Format: user/{userId}/conversation/{conversationId}/uploads/{filename}
 * Note: Uses same structure as old upload system for compatibility
 */
export const getFileUploadPath = (
  userId: string,
  conversationId: string,
  _fileId: string, // Kept for API compatibility but not used in path
  filename: string,
): string => `user/${userId}/conversation/${conversationId}/uploads/${filename}`;

/**
 * Simple helper to guess MIME type from filename
 */
export function getMimeTypeFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    pdf: "application/pdf",
    csv: "text/csv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    txt: "text/plain",
    json: "application/json",
    md: "text/markdown",
  };
  return mimeTypes[ext || ""] || "application/octet-stream";
}
