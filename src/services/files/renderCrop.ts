/**
 * Render-crop helper.
 *
 * Renders a single PDF page region (the figure's bbox) to a PNG or
 * JPEG image. The render scale is hardcoded to 1.5× — the same
 * constant the viewer's `EvidenceViewer.tsx` uses to display the
 * PDF, so the rendered crop is pixel-aligned to the on-screen
 * highlight. See design §"Decision: Render scale is fixed at 1.5×,
 * matching the viewer".
 *
 * Strategy:
 *   1. Try to load `canvas@3.2.0` (the project's standard canvas
 *      package). If it loads, render the page to a `canvas.Canvas`
 *      via `pdfjs-dist@5.4.296` legacy build + crop the bbox region.
 *   2. On canvas import failure (or any canvas-related error
 *      during the render), fall back to
 *      `Bun.spawn(['pdftoppm', ...])` from `poppler-utils` with
 *      `--x`/`--y`/`--W`/`--H` flags. The PDF is written to a temp
 *      file in `Bun.writeTempFile` (Bun runtime) and cleaned up
 *      in `finally`.
 *
 * The spike (PR #1's `scripts/spike-pdfjs-xobject.ts`) showed
 * `canvas@3.2.0`'s native binding is NOT loadable in the local Bun
 * environment — `pdftoppm` is the operative path. The fallback
 * keeps the helper's public signature stable: callers see the same
 * `{ bytes, width, height, format }` shape regardless of which
 * branch ran.
 *
 * Errors are surfaced as `FigureRenderCropError` carrying the
 * `page` and a `reason` string. The orchestrator catches and
 * records the figure as bbox-only (no throw propagates).
 */

import { unlink } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { loadPdfjsLegacy } from "./loaders/pdfjsLegacy";
import type { BBox } from "./pdfTableExtractor";

/** The render scale. Hardcoded to match the viewer's 1.5×. */
export const RENDER_SCALE = 1.5;

/** Format selector. Mirrors the `figureStorage` `FigureFormat` type. */
export type RenderFormat = "png" | "jpeg";

/** Output of `renderCroppedFigure`. */
export interface RenderedCrop {
  bytes: Uint8Array;
  width: number;
  height: number;
  format: RenderFormat;
}

/** Typed error from the render-crop helper. */
export class FigureRenderCropError extends Error {
  readonly page: number;
  readonly reason: string;
  constructor(opts: { page: number; reason: string }) {
    super(`render-crop failed on page ${opts.page}: ${opts.reason}`);
    this.name = "FigureRenderCropError";
    this.page = opts.page;
    this.reason = opts.reason;
  }
}

/**
 * Render a cropped figure from a PDF page.
 *
 * - `pdf` is the full PDF bytes (Uint8Array).
 * - `page` is 1-indexed.
 * - `bbox` is the figure bbox in PDF point space (units = "pt").
 * - `format` is the output format. v1 always passes "png" at the
 *   call site, but the helper supports "jpeg" for future entropy-
 *   based format selection.
 *
 * The strategy is canvas-first, pdftoppm-fallback. The `format`
 * argument is honored in the canvas branch; the pdftoppm branch
 * always emits PNG (poppler default), which is acceptable since v1
 * is PNG-only.
 */
export async function renderCroppedFigure(
  pdf: Uint8Array,
  page: number,
  bbox: BBox,
  format: RenderFormat = "png",
): Promise<RenderedCrop> {
  if (!pdf || !(pdf instanceof Uint8Array)) {
    throw new FigureRenderCropError({ page, reason: "pdf bytes missing" });
  }
  if (!Number.isFinite(page) || page < 1) {
    throw new FigureRenderCropError({ page, reason: "page must be >= 1" });
  }
  if (!bbox || typeof bbox.x !== "number" || typeof bbox.y !== "number") {
    throw new FigureRenderCropError({ page, reason: "bbox missing" });
  }

  // Branch 1: canvas
  try {
    return await renderWithCanvas(pdf, page, bbox, format);
  } catch (canvasErr) {
    const reason =
      canvasErr instanceof FigureRenderCropError
        ? canvasErr.reason
        : (canvasErr as Error).message ?? String(canvasErr);

    // Branch 2: pdftoppm via Bun.spawn
    if (typeof (globalThis as any).Bun?.spawn === "function") {
      try {
        return await renderWithPdftoppm(pdf, page, bbox, format);
      } catch (popplerErr) {
        throw new FigureRenderCropError({
          page,
          reason: `canvas: ${reason}; pdftoppm: ${
            (popplerErr as Error).message ?? String(popplerErr)
          }`,
        });
      }
    }

    // No Bun.spawn (Node fallback) — also try poppler via the
    // platform-default path: spawnSync via `node:child_process`.
    // We intentionally keep this minimal: the project standardizes
    // on Bun, and `pdftoppm` is the Plan B for environments that
    // DO have poppler installed.
    throw new FigureRenderCropError({
      page,
      reason: `canvas: ${reason}; pdftoppm unavailable (no Bun.spawn)`,
    });
  }
}

// ---------------------------------------------------------------------------
// Canvas branch
// ---------------------------------------------------------------------------

/** Lazily-loaded canvas module. The dynamic import lets the
 * fallback path stay cheap when canvas is unavailable. */
let canvasModuleCache: any = null;
let canvasLoadFailed = false;

async function loadCanvasModule(): Promise<any> {
  if (canvasModuleCache) return canvasModuleCache;
  if (canvasLoadFailed) {
    throw new FigureRenderCropError({ page: 0, reason: "canvas load failed" });
  }
  try {
    canvasModuleCache = await import("canvas");
    return canvasModuleCache;
  } catch (err) {
    canvasLoadFailed = true;
    throw new FigureRenderCropError({
      page: 0,
      reason: `canvas import failed: ${(err as Error).message ?? String(err)}`,
    });
  }
}

async function renderWithCanvas(
  pdf: Uint8Array,
  page: number,
  bbox: BBox,
  format: RenderFormat,
): Promise<RenderedCrop> {
  const canvasMod = await loadCanvasModule();
  const pdfjs = await loadPdfjsLegacy();

  let doc: any;
  try {
    const loadingTask = pdfjs.getDocument({
      data: pdf,
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
      verbosity: 0,
    });
    doc = await loadingTask.promise;
  } catch (err) {
    throw new FigureRenderCropError({
      page,
      reason: `getDocument failed: ${(err as Error).message ?? String(err)}`,
    });
  }

  try {
    const pageObj = await doc.getPage(page);
    const viewport = pageObj.getViewport({ scale: RENDER_SCALE });
    const canvas = canvasMod.createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    const ctx = canvas.getContext("2d");
    await pageObj.render({ canvasContext: ctx, viewport }).promise;
    try {
      pageObj.cleanup();
    } catch {
      // ignore
    }

    // Map the PDF-point bbox to canvas pixel space (multiply by 1.5).
    // Note: pdfjs's getViewport at scale 1.5 already scales x/y/w/h
    // by 1.5 internally, so the bbox must be multiplied by 1.5 here.
    const x = Math.max(0, Math.floor(bbox.x * RENDER_SCALE));
    const y = Math.max(0, Math.floor(bbox.y * RENDER_SCALE));
    const w = Math.max(1, Math.ceil(bbox.w * RENDER_SCALE));
    const h = Math.max(1, Math.ceil(bbox.h * RENDER_SCALE));
    const cropCanvas = canvasMod.createCanvas(w, h);
    const cropCtx = cropCanvas.getContext("2d");
    // Source rectangle: (x, y, w, h) from the page render.
    // Destination: (0, 0, w, h) on the crop canvas.
    cropCtx.drawImage(canvas, x, y, w, h, 0, 0, w, h);

    // Encode to the requested format. `canvas.toBuffer('image/png')`
    // returns a Node Buffer; convert to Uint8Array.
    const mime = format === "jpeg" ? "image/jpeg" : "image/png";
    const buf: Buffer = cropCanvas.toBuffer(mime);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return { bytes, width: w, height: h, format };
  } catch (err) {
    throw new FigureRenderCropError({
      page,
      reason: `canvas render failed: ${(err as Error).message ?? String(err)}`,
    });
  } finally {
    try {
      await doc.destroy();
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// pdftoppm branch
// ---------------------------------------------------------------------------

/**
 * Render the cropped region via `pdftoppm` from poppler-utils.
 *
 * Strategy: write the PDF to a temp file, spawn `pdftoppm` with
 * `-x`/`-y`/`-W`/`-H` flags to crop a specific region of one page,
 * read the resulting PNG (poppler default output), and clean up the
 * temp file in a `finally` block.
 *
 * The output file naming is `pdf-{N}` where N is the page index;
 * pdftoppm writes one PNG per page when given `-png`.
 */
async function renderWithPdftoppm(
  pdf: Uint8Array,
  page: number,
  bbox: BBox,
  _format: RenderFormat,
): Promise<RenderedCrop> {
  const Bun = (globalThis as any).Bun;
  if (!Bun?.spawn || !Bun?.write) {
    throw new FigureRenderCropError({
      page,
      reason: "Bun.spawn / Bun.write unavailable",
    });
  }

  const tmpRoot = tmpdir();
  const stamp = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const pdfPath = path.join(tmpRoot, `figure-crop-${stamp}.pdf`);
  const outPrefix = path.join(tmpRoot, `figure-crop-${stamp}-page`);

  // pdftoppm uses the page's user-space coordinates (PDF points
  // in our case), with origin at the top-left of the page. The
  // bbox from the detector is in PDF points with origin BOTTOM-left.
  // We need to flip the y axis: y_topdown = pageHeight - y_bottom - h.
  //
  // pdftoppm `-x`/`-y` are inclusive top-left corners (top-down).
  // `-W`/`-H` are the width/height in points.
  //
  // We need the page height. Resolve it via a quick pdfjs probe
  // (no canvas needed) — pdfjs legacy build exposes
  // `getViewport({scale:1.0}).height` without canvas.
  const pageHeight = await readPageHeightPt(pdf, page);
  if (!Number.isFinite(pageHeight) || pageHeight <= 0) {
    throw new FigureRenderCropError({
      page,
      reason: "could not determine page height for pdftoppm crop",
    });
  }
  const x = Math.max(0, Math.floor(bbox.x));
  const w = Math.max(1, Math.ceil(bbox.w));
  const h = Math.max(1, Math.ceil(bbox.h));
  const yTopdown = Math.max(0, Math.floor(pageHeight - bbox.y - h));

  // Write the PDF to disk.
  await Bun.write(pdfPath, pdf);

  // pdftoppm args:
  //   -f N -l N            → first/last page (single page render)
  //   -png                 → output format
  //   -r <DPI>             → resolution; 144 ≈ 2x of 72dpi (we use
  //                          the project's RENDER_SCALE * 72 = 108,
  //                          so the crop lands in canvas pixel space)
  //   -x <x> -y <y>        → top-left of crop region (in points)
  //   -W <w> -H <h>        → size of crop region (in points)
  //   <pdf> <outPrefix>    → input + output filename prefix
  const dpi = Math.round(72 * RENDER_SCALE);
  const args = [
    "-f",
    String(page),
    "-l",
    String(page),
    "-png",
    "-r",
    String(dpi),
    "-x",
    String(x),
    "-y",
    String(yTopdown),
    "-W",
    String(w),
    "-H",
    String(h),
    pdfPath,
    outPrefix,
  ];

  const proc = Bun.spawn(["pdftoppm", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text().catch(() => "");
    throw new FigureRenderCropError({
      page,
      reason: `pdftoppm exit ${exitCode}: ${stderr.slice(0, 200)}`,
    });
  }

  try {
    // pdftoppm output: <outPrefix>-<padded-page>.png
    // E.g. `figure-crop-abc-page-01.png` for page 1.
    const paddedPage = String(page).padStart(2, "0") + (page >= 100 ? "" : "");
    const expectedOut = `${outPrefix}-${paddedPage}.png`;
    // Try a few common naming patterns; pdftoppm has changed
    // padding behavior across versions.
    const candidates = [
      `${outPrefix}-${String(page).padStart(2, "0")}.png`,
      `${outPrefix}-${String(page).padStart(3, "0")}.png`,
      `${outPrefix}-${String(page)}.png`,
    ];
    const fs = await import("fs/promises");
    let pngPath: string | null = null;
    for (const c of candidates) {
      try {
        await fs.access(c);
        pngPath = c;
        break;
      } catch {
        // try next
      }
    }
    if (!pngPath) {
      // Last-ditch: list the dir and pick any *.png we wrote.
      const dirEntries = await fs.readdir(tmpRoot);
      const matches = dirEntries
        .filter((f) => f.startsWith(path.basename(outPrefix)) && f.endsWith(".png"))
        .map((f) => path.join(tmpRoot, f));
      if (matches.length > 0) pngPath = matches[0];
    }
    if (!pngPath) {
      throw new FigureRenderCropError({
        page,
        reason: `pdftoppm produced no PNG (expected ${expectedOut})`,
      });
    }

    const fileBytes = await fs.readFile(pngPath);
    const bytes = new Uint8Array(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);

    // pdftoppm output is sized by `-r` DPI; recompute pixel dims.
    // At dpi=108, the crop of w×h points is (w * 1.5) × (h * 1.5) px.
    const pxW = Math.round(w * RENDER_SCALE);
    const pxH = Math.round(h * RENDER_SCALE);
    return { bytes, width: pxW, height: pxH, format: "png" };
  } finally {
    // Cleanup both the PDF and any output PNGs we wrote.
    try {
      await unlink(pdfPath);
    } catch {
      // ignore
    }
    const fs = await import("fs/promises");
    try {
      const dirEntries = await fs.readdir(tmpRoot);
      await Promise.allSettled(
        dirEntries
          .filter((f) => f.startsWith(path.basename(outPrefix)))
          .map((f) => unlink(path.join(tmpRoot, f))),
      );
    } catch {
      // ignore
    }
  }
}

/**
 * Read the page height in PDF points without canvas. Uses the
 * pdfjs legacy build's `getViewport({scale:1.0})` API which does
 * not need a canvas factory.
 */
async function readPageHeightPt(
  pdf: Uint8Array,
  page: number,
): Promise<number> {
  const pdfjs = await loadPdfjsLegacy();
  const loadingTask = pdfjs.getDocument({
    data: pdf,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  try {
    const pageObj = await doc.getPage(page);
    const viewport = pageObj.getViewport({ scale: 1.0 });
    return viewport.height;
  } finally {
    try {
      await doc.destroy();
    } catch {
      // ignore
    }
  }
}
