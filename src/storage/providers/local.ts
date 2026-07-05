/**
 * LocalStorageProvider — serves files from the local filesystem.
 *
 * Intended for development and single-node deployments where papers
 * ingested via KNOWLEDGE_DOCS_PATH are already on disk. The provider
 * satisfies the StorageProvider contract used by the PDF / figure
 * proxy endpoints; upload and presigned-URL methods are not
 * supported and throw a clear error.
 *
 * Path semantics: the `path` argument is the same absolute path that
 * the document ingestion worker writes to `research_sources.file_path`.
 * No key resolution or remapping is performed — callers that want
 * sandboxing should pre-resolve against KNOWLEDGE_DOCS_PATH before
 * invoking the provider.
 */
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

import logger from "../../utils/logger";
import { StorageProvider } from "../types";

export class LocalStorageProvider extends StorageProvider {
  private rootDir: string;

  constructor(config: { rootDir: string }) {
    super();
    this.rootDir = path.resolve(config.rootDir);
  }

  /**
   * Resolve a stored path against the configured root.
   *
   * Real-world `file_path` values come in two shapes (see the
   * ingestion worker, which runs with CWD = `/app` and
   * KNOWLEDGE_DOCS_PATH=docs, producing paths like
   * `docs/marinedrugs/foo.pdf`). We accept both:
   *
   *   - absolute paths that live inside the root (verbatim)
   *   - relative paths that resolve against CWD into the root —
   *     the common case for ingestion workers, where `file_path`
   *     already begins with the root directory's basename
   *   - relative paths that resolve relative to the root (e.g. a
   *     bare `papers/foo.pdf` when `rootDir=/app/docs`)
   *
   * Refuses paths whose resolution escapes the configured root
   * (e.g. via `..`).
   */
  private resolvePath(p: string): string {
    const normalizedRoot = this.rootDir.endsWith(path.sep)
      ? this.rootDir
      : this.rootDir + path.sep;
    const isInside = (resolved: string) =>
      resolved === this.rootDir || resolved.startsWith(normalizedRoot);

    if (path.isAbsolute(p)) {
      const abs = path.resolve(p);
      if (!isInside(abs)) {
        throw new Error(
          `LocalStorageProvider: absolute path escapes root (${this.rootDir}): ${p}`,
        );
      }
      return abs;
    }

    // Try CWD-rooted resolution first — handles the most common
    // case where `file_path` already starts with the root
    // directory's basename (because the ingestion worker CWD equals
    // the parent of `KNOWLEDGE_DOCS_PATH`).
    const cwdResolved = path.resolve(p);
    if (isInside(cwdResolved)) {
      return cwdResolved;
    }
    // Fall back to rootDir-relative resolution — handles bare
    // relative paths like `papers/foo.pdf` against
    // `rootDir=/app/docs`.
    const rootResolved = path.resolve(this.rootDir, p);
    if (isInside(rootResolved)) {
      return rootResolved;
    }
    throw new Error(
      `LocalStorageProvider: path escapes root (${this.rootDir}): ${p}`,
    );
  }

  async upload(_path: string, _buffer: Buffer, _mimeType: string): Promise<string> {
    throw new Error(
      "LocalStorageProvider: upload() is not supported; files must be placed on disk via KNOWLEDGE_DOCS_PATH",
    );
  }

  async download(p: string): Promise<Buffer> {
    const filePath = this.resolvePath(p);
    if (!existsSync(filePath)) {
      throw new Error(`LocalStorageProvider: file not found: ${filePath}`);
    }
    const buf = await readFile(filePath);
    if (buf.length === 0) {
      throw new Error(`LocalStorageProvider: empty file: ${filePath}`);
    }
    return buf;
  }

  async downloadRange(p: string, start: number, end: number): Promise<Buffer> {
    const filePath = this.resolvePath(p);
    if (!existsSync(filePath)) {
      throw new Error(`LocalStorageProvider: file not found: ${filePath}`);
    }
    if (start < 0 || end < start) {
      throw new Error(
        `LocalStorageProvider: invalid range ${start}-${end} for ${filePath}`,
      );
    }
    // Read the requested slice only. We open the file, seek, and read
    // (end - start + 1) bytes. Node's fs handles this efficiently.
    const fh = await import("node:fs/promises");
    const handle = await fh.open(filePath, "r");
    try {
      const length = end - start + 1;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, start);
      return buf;
    } finally {
      await handle.close();
    }
  }

  async delete(p: string): Promise<void> {
    const filePath = this.resolvePath(p);
    if (!existsSync(filePath)) return;
    await unlink(filePath);
    if (logger) {
      logger.info({ filePath }, "local_storage_deleted");
    }
  }

  async exists(p: string): Promise<boolean> {
    const filePath = this.resolvePath(p);
    return existsSync(filePath);
  }

  async getPresignedUrl(_path: string, _expiresIn?: number): Promise<string> {
    throw new Error(
      "LocalStorageProvider: getPresignedUrl() is not supported; serve files through the API proxy instead",
    );
  }

  async getPresignedUploadUrl(
    _path: string,
    _contentType: string,
    _expiresIn?: number,
    _contentLength?: number,
  ): Promise<string> {
    throw new Error(
      "LocalStorageProvider: getPresignedUploadUrl() is not supported; place files on disk via KNOWLEDGE_DOCS_PATH",
    );
  }
}
