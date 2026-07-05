/**
 * Single-source PDF.js setup for the provenance viewer.
 *
 * Why a dedicated module: the standard build of `pdfjs-dist@5` uses
 * a web worker, and the worker URL must be set exactly once before
 * any `getDocument` call. Centralizing the setup here means every
 * import site gets the same configured instance, and tests can mock
 * this module to swap in a stub.
 *
 * Worker URL strategy: the pdfjs worker is served by the backend at
 * `GET /pdfjs/pdf.worker.mjs` (a static asset route mounted in
 * `src/index.ts`). This is portable across deployments — the
 * frontend bundle ships the absolute path, no `import.meta.url`
 * magic, no per-environment rebuild. The spike confirmed Bun's
 * bundler can resolve the standard build + named exports
 * (`getDocument`, `GlobalWorkerOptions`, `version`) without issue;
 * the resulting client bundle adds ~770 KB gzipped.
 *
 * The legacy build (`pdfjs-dist/legacy/build/pdf.mjs`) is what the
 * backend uses for table detection; we deliberately do NOT use it
 * here because the legacy build is single-threaded and the viewer
 * needs the worker for responsive rendering on multi-page PDFs.
 */
import {
  GlobalWorkerOptions,
  getDocument,
  version,
} from "pdfjs-dist/build/pdf.mjs";

export const PDFJS_WORKER_PATH = "/pdfjs/pdf.worker.mjs";

// One-time worker config. Setting `workerSrc` to an absolute path
// is the documented PDF.js pattern for the standard build.
GlobalWorkerOptions.workerSrc = PDFJS_WORKER_PATH;

export const pdfjsLib = {
  getDocument,
  GlobalWorkerOptions,
  version,
};

export type PdfDocumentProxy = Awaited<ReturnType<typeof getDocument>>;
export type PdfPageProxy = Awaited<
  ReturnType<PdfDocumentProxy["getPage"]>
>;
