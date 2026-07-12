/**
 * Unit tests for the Pagination primitive (`client/src/components/ui/Pagination.tsx`).
 *
 * Basecoat ships NO `.pagination` component, so this one is built from
 * `.button-group` + `.btn`. Two halves are worth holding:
 *
 *   1. THE WINDOW — `pageWindow()` decides which page numbers are visible. It
 *      must keep a CONSTANT WIDTH (the control must not resize as you walk
 *      through it), always expose the first and last page, and never emit a gap
 *      that hides exactly one page (a "…" standing in for page 4 alone is worse
 *      than page 4).
 *   2. THE ARIA — Preact renders it, not Basecoat JS. `aria-current="page"` is
 *      what assistive tech reads to say "you are here", and a button labelled
 *      only "3" has no accessible name worth the word.
 *
 * Test strategy matches Tabs/Menu: the component is invoked as a plain function
 * and the returned vnode tree is walked. `Pagination` takes no hooks, so this is
 * equivalent to rendering it.
 */
import { describe, expect, it } from "bun:test";
import type { VNode } from "preact";

import { Pagination, pageWindow } from "../Pagination";

/** Depth-first collect every vnode whose props match a predicate. */
function collect(
  node: any,
  match: (props: any, type: any) => boolean,
  out: any[] = [],
): any[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, match, out);
    return out;
  }
  const props = node.props || {};
  if (match(props, node.type)) out.push(node);
  collect(props.children, match, out);
  return out;
}

describe("pageWindow", () => {
  it("lists every page when they all fit", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps a constant width once it has to elide", () => {
    for (const current of [1, 2, 5, 10, 19, 20]) {
      expect(pageWindow(current, 20)).toHaveLength(7);
    }
  });

  it("always keeps the first and the last page reachable", () => {
    for (const current of [1, 4, 10, 17, 20]) {
      const win = pageWindow(current, 20);
      expect(win[0]).toBe(1);
      expect(win[win.length - 1]).toBe(20);
    }
  });

  it("clamps to the start, slides in the middle, clamps to the end", () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, 4, 5, 0, 20]);
    expect(pageWindow(10, 20)).toEqual([1, 0, 9, 10, 11, 0, 20]);
    expect(pageWindow(20, 20)).toEqual([1, 0, 16, 17, 18, 19, 20]);
  });

  it("always contains the current page", () => {
    for (let current = 1; current <= 20; current++) {
      expect(pageWindow(current, 20)).toContain(current);
    }
  });
});

describe("Pagination", () => {
  const props = { page: 3, totalPages: 20, onPage: () => {}, label: "Library pages" };

  it("renders nothing when there is only one page", () => {
    expect(
      Pagination({ ...props, page: 1, totalPages: 1 }) as VNode | null,
    ).toBeNull();
  });

  it("is a labelled nav wrapping a Basecoat .button-group", () => {
    const tree = Pagination(props) as any;
    expect(tree.type).toBe("nav");
    expect(tree.props["aria-label"]).toBe("Library pages");

    const groups = collect(tree, (p) => p.className === "button-group");
    expect(groups).toHaveLength(1);
  });

  it("marks the current page with aria-current and a named button", () => {
    const tree = Pagination(props);
    const current = collect(tree, (p) => p["aria-current"] === "page");

    expect(current).toHaveLength(1);
    expect(current[0].props.children).toBe(3);
    expect(current[0].props["aria-label"]).toBe("Page 3 of 20");
    // The house rule: a `data-tone` NEVER rides without an explicit
    // `data-variant`, or Lyra's `.btn:not([data-variant])` wins the hover.
    expect(current[0].props["data-tone"]).toBe("brand");
    expect(current[0].props["data-variant"]).toBe("outline");
  });

  it("every page button carries a real accessible name", () => {
    const tree = Pagination(props);
    const pages = collect(tree, (p) => p.className === "btn pagination-page");

    expect(pages.length).toBeGreaterThan(0);
    for (const button of pages) {
      expect(button.props["aria-label"]).toMatch(/^Page \d+ of 20$/);
    }
  });

  it("disables Previous on the first page and Next on the last", () => {
    const first = Pagination({ ...props, page: 1 });
    const prev = collect(first, (p) => p["aria-label"] === "Previous page")[0];
    const next = collect(first, (p) => p["aria-label"] === "Next page")[0];
    expect(prev.props.disabled).toBe(true);
    expect(next.props.disabled).toBe(false);

    const last = Pagination({ ...props, page: 20 });
    expect(
      collect(last, (p) => p["aria-label"] === "Previous page")[0].props
        .disabled,
    ).toBe(false);
    expect(
      collect(last, (p) => p["aria-label"] === "Next page")[0].props.disabled,
    ).toBe(true);
  });

  it("hides the elision glyph from assistive tech", () => {
    const tree = Pagination({ ...props, page: 10 });
    const gaps = collect(tree, (p) => p.className === "pagination-gap");

    expect(gaps).toHaveLength(2);
    for (const gap of gaps) expect(gap.props["aria-hidden"]).toBe("true");
  });

  it("asks for the page the user clicked", () => {
    const asked: number[] = [];
    const tree = Pagination({ ...props, onPage: (n) => asked.push(n) });

    collect(tree, (p) => p["aria-label"] === "Page 4 of 20")[0].props.onClick();
    collect(tree, (p) => p["aria-label"] === "Previous page")[0].props.onClick();
    collect(tree, (p) => p["aria-label"] === "Next page")[0].props.onClick();

    expect(asked).toEqual([4, 2, 4]);
  });
});
