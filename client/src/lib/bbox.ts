/**
 * Coordinate transform from PDF point space to viewer pixel space.
 *
 * The local table provider (PR #1) renders pages at 1.5× to compute
 * bboxes, so 1.5 is used as the DEFAULT viewer scale. The constant is
 * exported so tests and the EvidenceViewer share the same initial
 * value.
 *
 * The viewer now supports dynamic zoom (fit-to-width + manual
 * controls), so `bboxToPixels` accepts the live render `scale`. The
 * overlay MUST be computed with the SAME scale the canvas renders at,
 * or highlights drift out of alignment. Bbox units are PDF points
 * (1pt = 1/72in); multiply by the render scale to get CSS pixels.
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

export function bboxToPixels(
  bbox: BBox,
  scale: number = PDFJS_RENDER_SCALE,
): BBoxPixels {
  return {
    left: bbox.x * scale,
    top: bbox.y * scale,
    width: bbox.w * scale,
    height: bbox.h * scale,
  };
}
