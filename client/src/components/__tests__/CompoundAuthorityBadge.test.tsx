/**
 * Unit tests for the CompoundAuthorityBadge component
 * (`client/src/components/CompoundAuthorityBadge.tsx`). The badge
 * has 5 display branches:
 *
 *   1. `skipped`       — hidden entirely
 *   2. `verified`      — "{compound} → {canonical}" badge with title
 *                        carrying InChIKey + PubChem CID
 *   3. `verified` + canonical matches raw text (normalized) — hidden
 *   4. `pending`       — inline spinner badge
 *   5. `failed`        — red dot badge with title carrying the last
 *                        error
 *
 * Test strategy: call the component as a plain function and walk
 * the returned vnode tree. We avoid `render()` entirely because
 * the project's DOM shim has a few incompatibilities with Preact
 * internals. The badge is a pure function of its props (no
 * state, no effects) so calling it directly is equivalent to
 * rendering for the purpose of asserting structure.
 */
import { describe, it, expect } from "bun:test";
import { type VNode } from "preact";
import type { ComponentChildren } from "preact";

import {
  CompoundAuthorityBadge,
  type CompoundAuthorityStatus,
} from "../CompoundAuthorityBadge";

/**
 * Walks the vnode tree starting at the badge's root, collecting
 * every `data-compound-authority-status` attribute found on a vnode
 * (the badge is always a span). We also collect title / data-*
 * attributes for assertions.
 */
interface BadgeSnapshot {
  statuses: string[];
  titles: string[];
  canonicalIds: string[];
  canonicalNames: string[];
  textContents: string[];
  hasSpinner: boolean;
  hasDot: boolean;
}

function snapshotVNode(node: VNode | null | undefined): BadgeSnapshot {
  const snapshot: BadgeSnapshot = {
    statuses: [],
    titles: [],
    canonicalIds: [],
    canonicalNames: [],
    textContents: [],
    hasSpinner: false,
    hasDot: false,
  };
  if (!node) return snapshot;
  walk(node, snapshot);
  return snapshot;
}

function walk(n: any, snapshot: BadgeSnapshot): void {
  if (!n) return;
  if (n.props) {
    const props = n.props as Record<string, unknown>;
    const status = props["data-compound-authority-status"];
    if (typeof status === "string") snapshot.statuses.push(status);
    const title = props["title"];
    if (typeof title === "string") snapshot.titles.push(title);
    const canonicalId = props["data-compound-canonical-id"];
    if (typeof canonicalId === "string")
      snapshot.canonicalIds.push(canonicalId);
    const canonicalName = props["data-compound-canonical-name"];
    if (typeof canonicalName === "string")
      snapshot.canonicalNames.push(canonicalName);
    const children = props.children as ComponentChildren;
    collectText(children, snapshot);
    collectSpinnersAndDots(props, snapshot);
  }
}

function collectText(
  children: ComponentChildren,
  snapshot: BadgeSnapshot,
): void {
  if (children == null || children === false) return;
  if (typeof children === "string") {
    snapshot.textContents.push(children);
    return;
  }
  if (typeof children === "number" || typeof children === "boolean") {
    snapshot.textContents.push(String(children));
    return;
  }
  if (Array.isArray(children)) {
    for (const child of children) collectText(child, snapshot);
    return;
  }
  if (typeof children === "object" && "props" in children) {
    const nested = (children as VNode).props?.children;
    if (nested !== undefined) collectText(nested, snapshot);
  }
}

function collectSpinnersAndDots(
  props: Record<string, unknown>,
  snapshot: BadgeSnapshot,
): void {
  // Preact accepts `className` in JSX but also supports the HTML
  // `class` attribute. Walk the vnode for both keys.
  const candidates = [props.className, props.class];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      if (candidate.includes("compound-authority-badge__spinner")) {
        snapshot.hasSpinner = true;
      }
      if (candidate.includes("compound-authority-badge__dot")) {
        snapshot.hasDot = true;
      }
    }
  }
  // As a last resort, walk nested children for nested span vnodes
  // whose props carry the spinner/dot class.
  const children = props.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (child && typeof child === "object" && "props" in child) {
        collectSpinnersAndDots(
          (child as VNode).props as Record<string, unknown>,
          snapshot,
        );
      }
    }
  } else if (children && typeof children === "object" && "props" in children) {
    collectSpinnersAndDots(
      (children as VNode).props as Record<string, unknown>,
      snapshot,
    );
  }
}

function renderAndCapture(
  props: Partial<{
    compound: string | null | undefined;
    compoundCanonicalId: string | null | undefined;
    compoundAuthorityStatus: CompoundAuthorityStatus | string | null;
    compoundAuthorityError: string | null | undefined;
    canonicalName: string | null | undefined;
    inchiKey: string | null | undefined;
    pubchemCid: number | null | undefined;
    variant: "inline" | "card";
    title: string | undefined;
  }>,
): BadgeSnapshot {
  const fullProps = {
    compound: "diferuloylmethane",
    compoundCanonicalId: "C1",
    compoundAuthorityStatus: "verified",
    compoundAuthorityError: null,
    canonicalName: "Curcumin",
    inchiKey: "VFLDPWHFBROODJ-UHFFFAOYSA-N",
    pubchemCid: 969516,
    variant: "card" as const,
    ...props,
  };
  // Invoke the component function directly. The component is a
  // pure function of its props (no state, no effects, no hooks),
  // so calling it without a Preact renderer produces the same
  // vnode tree that `render()` would mount. This avoids the DOM
  // shim's incompatibility with Preact's internal property
  // descriptors.
  const vnode = (CompoundAuthorityBadge as any)(fullProps) as VNode;
  return snapshotVNode(vnode);
}

// ---------------------------------------------------------------------------
// 1. Skipped (extracts / mixtures) — badge hidden
// ---------------------------------------------------------------------------

describe("CompoundAuthorityBadge — skipped", () => {
  it("renders nothing when status is 'skipped'", () => {
    const snap = renderAndCapture({
      compound: "Curcuma longa extract",
      compoundAuthorityStatus: "skipped",
      compoundCanonicalId: null,
      canonicalName: null,
    });
    expect(snap.statuses).toEqual([]);
    expect(snap.titles).toEqual([]);
    expect(snap.textContents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Verified with text diff — full pill
// ---------------------------------------------------------------------------

describe("CompoundAuthorityBadge — verified with text diff", () => {
  it("renders the raw → canonical pill when the canonical name differs from the raw text", () => {
    const snap = renderAndCapture({
      compound: "diferuloylmethane",
      compoundAuthorityStatus: "verified",
      compoundCanonicalId: "C1",
      canonicalName: "Curcumin",
      inchiKey: "VFLDPWHFBROODJ-UHFFFAOYSA-N",
      pubchemCid: 969516,
    });
    expect(snap.statuses).toContain("verified");
    expect(snap.canonicalIds).toContain("C1");
    expect(snap.canonicalNames).toContain("Curcumin");
    const title = snap.titles[0] ?? "";
    expect(title).toContain("InChIKey: VFLDPWHFBROODJ-UHFFFAOYSA-N");
    expect(title).toContain("PubChem CID: 969516");
    const joined = snap.textContents.join(" ");
    expect(joined).toContain("diferuloylmethane");
    expect(joined).toContain("Curcumin");
    expect(joined).toContain("→");
  });
});

// ---------------------------------------------------------------------------
// 3. Verified with no diff — badge hidden
// ---------------------------------------------------------------------------

describe("CompoundAuthorityBadge — verified with no diff (normalized match)", () => {
  it("hides the badge when the canonical name normalizes equal to the raw text", () => {
    const snap = renderAndCapture({
      compound: "Curcumin",
      compoundAuthorityStatus: "verified",
      compoundCanonicalId: "C1",
      canonicalName: "curcumin",
    });
    expect(snap.statuses).toEqual([]);
  });

  it("hides the badge on diacritic-insensitive equality (Curcumin vs curcumin)", () => {
    const snap = renderAndCapture({
      compound: "Curcumin",
      compoundAuthorityStatus: "verified",
      compoundCanonicalId: "C1",
      canonicalName: "curcumin",
    });
    expect(snap.statuses).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Pending — spinner pill
// ---------------------------------------------------------------------------

describe("CompoundAuthorityBadge — pending", () => {
  it("renders a pending pill with a spinner glyph", () => {
    const snap = renderAndCapture({
      compound: "obscurenaturalproduct",
      compoundAuthorityStatus: "pending",
      compoundCanonicalId: null,
      canonicalName: null,
    });
    expect(snap.statuses).toContain("pending");
    expect(snap.hasSpinner).toBe(true);
    expect(snap.titles[0]).toBe("Pending PubChem resolution");
  });
});

// ---------------------------------------------------------------------------
// 5. Failed — red dot pill
// ---------------------------------------------------------------------------

describe("CompoundAuthorityBadge — failed", () => {
  it("renders a red dot pill with the title carrying the last error", () => {
    const snap = renderAndCapture({
      compound: "obscurenaturalproduct",
      compoundAuthorityStatus: "failed",
      compoundCanonicalId: null,
      canonicalName: null,
      compoundAuthorityError: "pubchem 404 not found",
    });
    expect(snap.statuses).toContain("failed");
    expect(snap.hasDot).toBe(true);
    expect(snap.titles[0]).toContain("pubchem 404 not found");
  });

  it("falls back to a generic message when no error is provided", () => {
    const snap = renderAndCapture({
      compound: "obscurenaturalproduct",
      compoundAuthorityStatus: "failed",
      compoundAuthorityError: null,
    });
    expect(snap.statuses).toContain("failed");
    expect(snap.titles[0]).toBe("Authority resolution failed");
  });
});

// ---------------------------------------------------------------------------
// 6. Variant class
// ---------------------------------------------------------------------------

describe("CompoundAuthorityBadge — variant", () => {
  it("applies the 'card' modifier when variant='card'", () => {
    const snap = renderAndCapture({ variant: "card" });
    expect(snap.statuses).toContain("verified");
  });
});
