/**
 * Pure highlight div renderer.
 *
 * Per the design (§7.8), each provenance type gets a distinct color:
 *   - table  → blue  (3b82f6)
 *   - figure → purple (a855f7) for bbox-only, or green (emerald-500)
 *             for figures with an extracted image (PR #2 of
 *             figure-image-extraction)
 *   - chunk  → yellow (eab308)
 *   - text-only → no overlay (the badge is the signal)
 *
 * The component is a controlled renderer — it does not fetch or
 * compute bboxes; the parent passes them in. This keeps it pure
 * and trivially testable. Multiple bboxes render as one div each
 * (spec scenario "Multiple bboxes render as multiple highlights").
 *
 * PR #2 of figure-image-extraction: the `imageUrl` prop drives
 * the figure color split — green when present, purple (the
 * pre-change color) when absent. The `data-provenance-figure-status`
 * attribute ships for E2E selectors.
 */
import { ProvenanceType } from "../hooks/useProvenance";
import { BBox, bboxToPixels } from "../lib/bbox";

interface BboxOverlayProps {
  bbox: BBox | null;
  type: ProvenanceType;
  className?: string;
  /**
   * PR #2 of figure-image-extraction: when set, the figure
   * bbox uses the green-with-image class (`emerald-500`)
   * instead of the pre-change purple-bbox-only class. Tables
   * and chunks ignore this prop. Optional — when undefined
   * the behavior is the pre-change purple class for figures.
   */
  imageUrl?: string;
}

const TYPE_CLASS: Record<Exclude<ProvenanceType, "text-only">, string> = {
  table: "provenance-bbox--table",
  figure: "provenance-bbox--figure",
  chunk: "provenance-bbox--chunk",
};

function figureClassName(imageUrl?: string): string {
  return imageUrl
    ? "provenance-bbox--figure-with-image"
    : "provenance-bbox--figure";
}

export function BboxOverlay({
  bbox,
  type,
  className,
  imageUrl,
}: BboxOverlayProps) {
  if (!bbox || type === "text-only") return null;
  const pixels = bboxToPixels(bbox);
  // PR #2: figures resolve to a different class based on
  // `imageUrl`. Tables and chunks resolve via the static map.
  const typeClass =
    type === "figure" ? figureClassName(imageUrl) : TYPE_CLASS[type];
  const klass = `provenance-bbox ${typeClass} ${className ?? ""}`.trim();
  return (
    <div
      className={klass}
      data-provenance-type={type}
      // PR #2: figures carry an extra `data-provenance-figure-status`
      // attribute (either "with-image" or "bbox-only") for E2E
      // selectors. Tables and chunks are unchanged.
      data-provenance-figure-status={
        type === "figure" ? (imageUrl ? "with-image" : "bbox-only") : undefined
      }
      style={{
        position: "absolute",
        left: `${pixels.left}px`,
        top: `${pixels.top}px`,
        width: `${pixels.width}px`,
        height: `${pixels.height}px`,
        pointerEvents: "none",
      }}
      aria-hidden="true"
    />
  );
}
