/**
 * Unit tests for the text-chunk fallback search hook
 * (`useTextChunkSearch`). The hook is the bridge between the
 * fact-provenance endpoint (which resolves a chunk to a page but
 * not a bbox) and the EvidenceViewer's bbox overlay.
 *
 * Test strategy:
 *   - Mock `client/src/lib/pdfjs` with a minimal proxy that
 *     exposes a `getTextContent()` payload we control. This lets
 *     us assert the search returns a bbox for the matched window
 *     and gracefully returns `bbox: null` on a miss — without
 *     bundling a real PDF or running the worker.
 *   - Drive the hook by exposing a tiny harness that lets the
 *     test reach into the closure created by the hook. We avoid
 *     `renderHook` / DOM rendering because bun's test runner
 *     does not provide `document` by default; the hook's effect
 *     is pure (no DOM access) so we can verify it without a
 *     host element.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

import { PDFJS_RENDER_SCALE } from "../../lib/bbox";

// ---------------------------------------------------------------------------
// Module mocks (registered BEFORE the import of the hook)
// ---------------------------------------------------------------------------

mock.module("../../lib/pdfjs", () => ({
  pdfjsLib: {
    getDocument: mock(() => ({ promise: Promise.resolve({}) })),
    GlobalWorkerOptions: { workerSrc: "" },
    version: "test",
  },
  PdfDocumentProxy: class {},
  PdfPageProxy: class {},
  PDFJS_WORKER_PATH: "/pdfjs/pdf.worker.mjs",
}));

// Importing the hook AFTER the module mock is in place so its
// dependency on `lib/pdfjs` resolves to the stub.
import { useTextChunkSearch, type TextChunkSearchResult } from "../useTextChunkSearch";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface FakeItem {
  str: string;
  x: number;       // PDF point x (bottom-left origin)
  y: number;       // PDF point y (bottom-left origin)
  width: number;   // PDF point width
  fontHeight: number; // PDF point font height
}

interface FakeDoc {
  numPages: number;
  getPage: (page: number) => Promise<{
    view: number[];
    getTextContent: () => Promise<{ items: unknown[] }>;
  }>;
}

const PAGE_HEIGHT_PT = 792;
const PAGE_WIDTH_PT = 612;

function makeDoc(items: FakeItem[]): FakeDoc {
  const textItems = items.map((it) => ({
    str: it.str,
    transform: [it.fontHeight, 0, 0, it.fontHeight, it.x, it.y],
    width: it.width,
    height: it.fontHeight,
  }));
  return {
    numPages: 1,
    getPage: async () => ({
      view: [0, 0, PAGE_WIDTH_PT, PAGE_HEIGHT_PT],
      getTextContent: async () => ({ items: textItems }),
    }),
  };
}

/**
 * The hook stores the resolved result in state. To assert on
 * that state without a DOM, we import the module's `useState`
 * via the same `preact/hooks` module the hook itself uses, and
 * pre-seeding a Probe that writes the latest result into a
 * shared mutable. The Preact render here happens against
 * `null` so we don't need `document` — the hooks state machine
 * still runs.
 */
import { useState } from "preact/hooks";

function makeProbe() {
  const ref: { current: TextChunkSearchResult | null } = { current: null };
  const refSearching: { current: boolean } = { current: false };
  return {
    ref,
    refSearching,
    capture: (args: Parameters<typeof useTextChunkSearch>[0]) => {
      const { result, isSearching } = useTextChunkSearch(args);
      // Direct assignment works because we're inside the
      // component's render scope.
      ref.current = result;
      refSearching.current = isSearching;
    },
  };
}

// Bun's test runner does not provide `document`; the hook
// itself never touches the DOM, so we can drive it through a
// Preact render-to-null harness without a host element.
import { createElement } from "preact";
import { render as preactRender } from "preact";

async function driveHook(args: Parameters<typeof useTextChunkSearch>[0]): Promise<{
  result: TextChunkSearchResult | null;
  isSearching: boolean;
}> {
  const probe = makeProbe();
  function Probe() {
    probe.capture(args);
    return createElement("div", null);
  }
  // Render into a detached node — we just need Preact to
  // invoke the hook on each tick. Use Bun's `document`
  // shim if available, otherwise fall back to a noop host.
  const host: any = (globalThis as any).document
    ? (globalThis as any).document.createElement("div")
    : {
        // Minimal host stub — Preact's render() falls back to
        // a no-op for the host when the runtime doesn't
        // support DOM. We don't need the rendered output.
        appendChild() {},
        removeChild() {},
        insertBefore() {},
        nodeType: 1,
        ownerDocument: null,
        _children: [],
      };
  if ((globalThis as any).document) {
    (globalThis as any).document.body.appendChild(host);
  }
  preactRender(createElement(Probe), host);
  // Yield many microtasks so the effect's async chain
  // (await getTextContent → setState → re-render) completes
  // even under load. The hook is fast (synchronous after the
  // single `getTextContent` await), so 10 ticks at 10 ms is
  // plenty of headroom.
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if ((globalThis as any).document) {
    preactRender(null as any, host);
    host.remove();
  }
  return {
    result: probe.ref.current,
    isSearching: probe.refSearching.current,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useTextChunkSearch", () => {
  beforeEach(() => {
    // Reset module-level state on the hook between tests. The
    // hook itself is stateless across renders, but the
    // `useState` initial value is created at first render
    // only — for a fresh test we just need a fresh probe.
  });

  it("returns null bbox when the search is disabled", async () => {
    const doc = makeDoc([
      { str: "Q. officinale extract inhibited cell proliferation.", x: 72, y: 100, width: 200, fontHeight: 12 },
    ]);
    const { result } = await driveHook({
      doc: doc as any,
      page: 1,
      chunkContent: "Q. officinale extract inhibited cell proliferation.",
      enabled: false,
    });
    expect(result).toBeNull();
  });

  it("returns null bbox on a graceful miss (chunk text not on page)", async () => {
    const doc = makeDoc([
      { str: "Different content on this page.", x: 72, y: 100, width: 200, fontHeight: 12 },
    ]);
    const { result } = await driveHook({
      doc: doc as any,
      page: 1,
      chunkContent: "Q. officinale extract inhibited cell proliferation.",
      enabled: true,
    });
    expect(result).not.toBeNull();
    expect(result!.bbox).toBeNull();
    expect(result!.snippet).toContain("Q. officinale");
  });

  it("locates the chunk's first 80 chars and returns a PDF-point bbox", async () => {
    const chunk =
      "Q. officinale extract inhibited cell proliferation in vitro at concentrations above 0.5 mg/mL.";
    const doc = makeDoc([
      { str: chunk, x: 72, y: 200, width: 360, fontHeight: 12 },
    ]);
    const { result } = await driveHook({
      doc: doc as any,
      page: 1,
      chunkContent: chunk,
      enabled: true,
    });
    expect(result).not.toBeNull();
    expect(result!.bbox).not.toBeNull();
    const bbox = result!.bbox!;
    expect(bbox.units).toBe("pt");
    expect(bbox.page).toBe(1);
    // Run is at (x=72, y=200) PDF points with width 360 and font
    // height 12. Allow a small floating-point tolerance — the
    // hook normalizes via PDFJS_RENDER_SCALE so small epsilon
    // is expected.
    expect(bbox.x).toBeCloseTo(72, 1);
    expect(bbox.w).toBeCloseTo(360, 1);
    expect(bbox.h).toBeCloseTo(12, 1);
    // The bbox contract uses PDF bottom-left origin: the
    // returned `y` is the BOTTOM of the bbox (the lowest PDF
    // y). The run's top is at y=200; the bottom is y=200
    // (the baseline), so bbox.y should be 200.
    expect(bbox.y).toBeCloseTo(200, 1);
  });

  it("unions bboxes when the chunk text spans multiple runs", async () => {
    const doc = makeDoc([
      { str: "Q. officinale extract inhibited", x: 72, y: 200, width: 180, fontHeight: 12 },
      { str: " cell proliferation in vitro.", x: 260, y: 200, width: 160, fontHeight: 12 },
    ]);
    const chunk =
      "Q. officinale extract inhibited cell proliferation in vitro at concentrations above 0.5 mg/mL.";
    const { result } = await driveHook({
      doc: doc as any,
      page: 1,
      chunkContent: chunk,
      enabled: true,
    });
    expect(result).not.toBeNull();
    const bbox = result!.bbox!;
    // The union spans from x=72 to x=260+160=420.
    expect(bbox.x).toBeCloseTo(72, 1);
    expect(bbox.w).toBeCloseTo(420 - 72, 1);
    expect(bbox.h).toBeCloseTo(12, 1);
    // y is the bottom of the bbox in PDF coords.
    expect(bbox.y).toBeCloseTo(200, 1);
  });

  it("truncates the snippet to 80 chars", async () => {
    const long = "A".repeat(200);
    const doc = makeDoc([
      { str: long, x: 72, y: 200, width: 200, fontHeight: 12 },
    ]);
    const { result } = await driveHook({
      doc: doc as any,
      page: 1,
      chunkContent: long,
      enabled: true,
    });
    expect(result).not.toBeNull();
    expect(result!.snippet.length).toBeLessThanOrEqual(80);
  });

  it("returns null when no doc is provided", async () => {
    const { result } = await driveHook({
      doc: null,
      page: 1,
      chunkContent: "anything",
      enabled: true,
    });
    expect(result).toBeNull();
  });
});

// Suppress the "unused import" lint for the scale constant
// (it's used by the hook internally; we re-import it here to
// lock the contract).
void PDFJS_RENDER_SCALE;
