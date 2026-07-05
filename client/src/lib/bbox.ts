/**
 * Coordinate transform from PDF point space to viewer pixel space.
 *
 * The local table provider (PR #1) renders pages at 1.5× to compute
 * bboxes, so the same scale is used in the viewer. The constant is
 * exported so tests and the EvidenceViewer share the same value.
 *
 * Per the design (§7.2), the scale is fixed at 1.5 — it MUST NOT
 * be parameterized per document. Bbox units are PDF points
 * (1pt = 1/72in); multiply by 1.5 to get CSS pixels at the
 * render scale.
 */

export const PDFJS_RENDER_SCALE = 1.5;

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
  units: "pt";
}

export interface BBoxPixels {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function bboxToPixels(bbox: BBox): BBoxPixels {
  return {
    left: bbox.x * PDFJS_RENDER_SCALE,
    top: bbox.y * PDFJS_RENDER_SCALE,
    width: bbox.w * PDFJS_RENDER_SCALE,
    height: bbox.h * PDFJS_RENDER_SCALE,
  };
}
