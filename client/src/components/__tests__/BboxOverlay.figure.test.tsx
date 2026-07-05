/**
 * Unit tests for the BboxOverlay color split
 * (`client/src/components/BboxOverlay.tsx`) introduced in
 * PR #2 of `figure-image-extraction`. The bbox switches
 * between two CSS classes for the `figure` provenance type
 * based on whether the figure has an extracted image:
 *
 *   - `imageUrl` present  →
 *       `provenance-bbox--figure-with-image` (emerald-500)
 *       `data-provenance-figure-status="with-image"`
 *   - `imageUrl` absent   →
 *       `provenance-bbox--figure` (purple, pre-change color)
 *       `data-provenance-figure-status="bbox-only"`
 *
 * Tables (`type="table"`) and chunks (`type="chunk"`) are
 * unaffected — they keep their pre-change blue / yellow
 * classes regardless of `imageUrl`.
 *
 * Test strategy mirrors `CompoundAuthorityBadge.test.tsx`:
 * we invoke the component function directly and walk the
 * returned vnode tree. The component is pure (no state, no
 * effects) so the vnode tree is equivalent to what `render()`
 * would mount, and the DOM shim's Preact incompatibilities
 * are avoided.
 */
import { describe, expect, it } from "bun:test";
import type { ComponentChildren, VNode } from "preact";

import type { ProvenanceType } from "../../hooks/useProvenance";
import type { BBox } from "../../lib/bbox";
import { BboxOverlay } from "../BboxOverlay";

interface OverlaySnapshot {
  classes: string[];
  types: string[];
  figureStatuses: Array<string | undefined>;
}

function snapshotVNode(node: VNode | null | undefined): OverlaySnapshot {
  const snapshot: OverlaySnapshot = {
    classes: [],
    types: [],
    figureStatuses: [],
  };
  if (!node) return snapshot;
  walk(node, snapshot);
  return snapshot;
}

function walk(n: unknown, snapshot: OverlaySnapshot): void {
  if (!n) return;
  if (typeof n !== "object") return;
  const vnode = n as VNode;
  if (vnode.props) {
    const props = vnode.props as Record<string, unknown>;
    // Preact accepts `className` in JSX. We collect the raw
    // className string so the tests can assert the exact
    // modifier.
    const cls = props.className;
    if (typeof cls === "string") snapshot.classes.push(cls);
    const t = props["data-provenance-type"];
    if (typeof t === "string") snapshot.types.push(t);
    const status = props["data-provenance-figure-status"];
    snapshot.figureStatuses.push(
      typeof status === "string" ? status : undefined,
    );
    const children = props.children as ComponentChildren;
    walkChildren(children, snapshot);
  }
}

function walkChildren(
  children: ComponentChildren,
  snapshot: OverlaySnapshot,
): void {
  if (children == null || children === false) return;
  if (Array.isArray(children)) {
    for (const child of children) walkChildren(child, snapshot);
    return;
  }
  if (typeof children === "object" && "props" in children) {
    walk(children as VNode, snapshot);
  }
}

// A minimal but realistic bbox (PDF points). The component
// only reads it through `bboxToPixels`, which we don't need
// to re-verify here — the color-split logic is independent
// of the bbox math.
const sampleBbox: BBox = {
  x: 100,
  y: 200,
  w: 300,
  h: 220,
  page: 2,
  units: "pt",
};

function renderAndSnapshot(props: {
  type: ProvenanceType;
  imageUrl?: string;
}): OverlaySnapshot {
  const vnode = (BboxOverlay as any)({
    bbox: sampleBbox,
    type: props.type,
    imageUrl: props.imageUrl,
  }) as VNode;
  return snapshotVNode(vnode);
}

// ---------------------------------------------------------------------------
// 1. Figure with imageUrl → green / with-image
// ---------------------------------------------------------------------------

describe("BboxOverlay — figure with imageUrl", () => {
  it("renders the green-with-image class and the with-image status", () => {
    const snap = renderAndSnapshot({
      type: "figure",
      imageUrl: "/api/research-brain/figures/abc/image",
    });
    // The className is the merged `provenance-bbox` +
    // modifier + (no caller class). The modifier is the
    // green class. We assert the exact modifier rather
    // than a substring — the substring `provenance-bbox--figure`
    // is a prefix of `provenance-bbox--figure-with-image`,
    // so a contains check would be ambiguous.
    expect(snap.classes).toContain(
      "provenance-bbox provenance-bbox--figure-with-image",
    );
    expect(snap.types).toContain("figure");
    expect(snap.figureStatuses).toContain("with-image");
  });
});

// ---------------------------------------------------------------------------
// 2. Figure without imageUrl → purple / bbox-only (pre-change)
// ---------------------------------------------------------------------------

describe("BboxOverlay — figure without imageUrl (bbox-only)", () => {
  it("renders the legacy purple class and the bbox-only status when imageUrl is undefined", () => {
    const snap = renderAndSnapshot({ type: "figure" });
    expect(snap.classes).toContain("provenance-bbox provenance-bbox--figure");
    expect(snap.classes).not.toContain(
      "provenance-bbox provenance-bbox--figure-with-image",
    );
    expect(snap.types).toContain("figure");
    expect(snap.figureStatuses).toContain("bbox-only");
  });
});

// ---------------------------------------------------------------------------
// 3. Tables are unaffected
// ---------------------------------------------------------------------------

describe("BboxOverlay — tables are unaffected by imageUrl", () => {
  it("renders the blue table class regardless of imageUrl", () => {
    const snap = renderAndSnapshot({
      type: "table",
      // Even if a caller mistakenly forwards imageUrl on a
      // table, the type-based static class wins.
      imageUrl: "/should-be-ignored",
    });
    expect(snap.classes.some((c) => c.includes("provenance-bbox--table"))).toBe(
      true,
    );
    expect(snap.types).toContain("table");
    // Tables don't carry a figure-status attribute.
    expect(snap.figureStatuses[0]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Chunks are unaffected
// ---------------------------------------------------------------------------

describe("BboxOverlay — chunks are unaffected by imageUrl", () => {
  it("renders the yellow chunk class regardless of imageUrl", () => {
    const snap = renderAndSnapshot({
      type: "chunk",
      imageUrl: "/should-be-ignored",
    });
    expect(snap.classes.some((c) => c.includes("provenance-bbox--chunk"))).toBe(
      true,
    );
    expect(snap.types).toContain("chunk");
    expect(snap.figureStatuses[0]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. text-only renders nothing (pre-change contract preserved)
// ---------------------------------------------------------------------------

describe("BboxOverlay — text-only still renders nothing", () => {
  it("returns null when type is 'text-only'", () => {
    const vnode = (BboxOverlay as any)({
      bbox: sampleBbox,
      type: "text-only",
      imageUrl: "/should-be-ignored",
    }) as VNode;
    const snap = snapshotVNode(vnode);
    expect(snap.classes).toEqual([]);
    expect(snap.types).toEqual([]);
  });
});
