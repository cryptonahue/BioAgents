import { describe, it, expect } from "bun:test";

import { bboxFromRunRange, type TextRun } from "./useTextChunkSearch";
import { PDFJS_RENDER_SCALE } from "../lib/bbox";

/**
 * The MATCHING logic now lives in `shared/textAnchor.ts` and is tested
 * there — once, for both the client and the server-side anchor. What
 * remains client-specific, and what this file guards, is the GEOMETRY:
 * turning canvas-pixel runs into the bbox the overlay renders.
 */
describe("bboxFromRunRange", () => {
  // Two runs side by side on the same line, 200px down the canvas.
  const runs: TextRun[] = [
    { str: "a", x: 100, yTopCanvas: 200, fontHeight: 20, width: 50 },
    { str: "b", x: 160, yTopCanvas: 200, fontHeight: 20, width: 40 },
  ];

  it("unions runs into a top-left-origin bbox the overlay can render", () => {
    const bbox = bboxFromRunRange(runs, 0, 1, 3);
    expect(bbox).not.toBeNull();
    expect(bbox!.page).toBe(3);
    expect(bbox!.units).toBe("pt");
    expect(bbox!.x).toBeCloseTo(100 / PDFJS_RENDER_SCALE);
    // Spans both runs: x=100 through x=160+40=200.
    expect(bbox!.w).toBeCloseTo(100 / PDFJS_RENDER_SCALE);
    expect(bbox!.h).toBeCloseTo(20 / PDFJS_RENDER_SCALE);
  });

  // THE REGRESSION THAT SHIPPED. `bboxToPixels` renders `top = y * scale`,
  // so `y` MUST be the distance from the TOP of the page. An earlier
  // version flipped it through the page height (a bottom-left origin) and
  // drew every text highlight mirrored — a couple of lines off for
  // mid-page text, and far out over blank space near an edge.
  it("measures y downward from the page top, never flipped", () => {
    const bbox = bboxFromRunRange(runs, 0, 1, 3);
    expect(bbox!.y).toBeCloseTo(200 / PDFJS_RENDER_SCALE);
    // Round-tripping through the overlay must land back on the canvas row
    // the run actually occupies.
    expect(bbox!.y * PDFJS_RENDER_SCALE).toBeCloseTo(200);
  });

  it("keeps a run near the page top near the top (not flipped to the bottom)", () => {
    const nearTop: TextRun[] = [
      { str: "hdr", x: 50, yTopCanvas: 10, fontHeight: 12, width: 80 },
    ];
    const bbox = bboxFromRunRange(nearTop, 0, 0, 1);
    expect(bbox!.y).toBeCloseTo(10 / PDFJS_RENDER_SCALE);
    // A flipped origin would push this far down the page.
    expect(bbox!.y).toBeLessThan(20);
  });

  it("rejects degenerate geometry rather than drawing a zero-size box", () => {
    const degenerate: TextRun[] = [
      { str: "a", x: 100, yTopCanvas: 200, fontHeight: 0, width: 0 },
    ];
    expect(bboxFromRunRange(degenerate, 0, 0, 1)).toBeNull();
  });
});
