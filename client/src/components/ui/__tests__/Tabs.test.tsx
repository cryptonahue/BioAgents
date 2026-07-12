/**
 * Unit tests for the Tabs primitive (`client/src/components/ui/Tabs.tsx`).
 *
 * This component exists because Basecoat's `tabs.js` is deliberately NOT loaded
 * — it writes `aria-selected`, `tabindex` and `panel.hidden` straight into DOM
 * that Preact owns. Everything that script did, this component has to do, and
 * these tests are what hold it to that. They cover the two halves:
 *
 *   1. ARIA — Lyra's ENTIRE tab skin is keyed off `[role=tab]` and
 *      `aria-selected`, so if Preact stops rendering those, the tabs silently
 *      lose their styling with no error anywhere. Asserted here.
 *   2. KEYBOARD — a `role="tab"` whose arrow keys are dead is a lie to assistive
 *      tech. ArrowLeft/Right (wrapping), Home/End and the roving tabindex are the
 *      behavior `tabs.js` provided, and are asserted here against the real
 *      handler.
 *
 * Test strategy matches the other component tests in this project: call the
 * component as a plain function and walk the returned vnode tree. `render()` is
 * avoided because the project's DOM shim has incompatibilities with Preact
 * internals. `TabList` reads only `useRef` (whose `.current` array is empty when
 * called this way — `refs.current[i]?.focus()` short-circuits), so calling it
 * directly is equivalent to rendering for the purposes below.
 */
import { describe, expect, it } from "bun:test";
import type { VNode } from "preact";

import {
  TabList,
  TabPanel,
  tabId,
  tabPanelId,
  type TabItem,
} from "../Tabs";

type Id = "one" | "two" | "three";

const TABS: TabItem<Id>[] = [
  { value: "one", label: "One" },
  { value: "two", label: "Two" },
  { value: "three", label: "Three" },
];

interface TabProps {
  role?: string;
  id?: string;
  "aria-selected"?: boolean;
  "aria-controls"?: string;
  tabIndex?: number;
  onKeyDown?: (event: KeyboardEvent) => void;
  onClick?: () => void;
}

/** Renders the tablist and returns the props of its `[role=tab]` children. */
function renderTabs(value: Id, onChange: (next: Id) => void) {
  const tree = TabList({
    idPrefix: "t",
    label: "Test tabs",
    tabs: TABS,
    value,
    onChange,
  }) as VNode<any>;

  const children = tree.props.children as VNode<TabProps>[];
  return {
    tablist: tree.props as Record<string, unknown>,
    tabs: children.map((child) => child.props),
  };
}

/** A KeyboardEvent stand-in that records whether the handler consumed the key. */
function keyEvent(key: string) {
  let defaultPrevented = false;
  return {
    key,
    preventDefault: () => {
      defaultPrevented = true;
    },
    get defaultPrevented() {
      return defaultPrevented;
    },
  };
}

/** Presses `key` on the tab at `index` and reports what the handler did. */
function press(key: string, index: number, value: Id = "one") {
  let selected: Id | null = null;
  const { tabs } = renderTabs(value, (next) => {
    selected = next;
  });

  const event = keyEvent(key);
  tabs[index].onKeyDown!(event as unknown as KeyboardEvent);

  return { selected: selected as Id | null, prevented: event.defaultPrevented };
}

describe("Tabs — ARIA contract (what Lyra's CSS keys off)", () => {
  it("marks the tablist and every tab with the roles Lyra selects on", () => {
    const { tablist, tabs } = renderTabs("one", () => {});

    expect(tablist.role).toBe("tablist");
    expect(tablist["aria-orientation"]).toBe("horizontal");
    expect(tablist["aria-label"]).toBe("Test tabs");
    expect(tabs).toHaveLength(3);
    for (const tab of tabs) expect(tab.role).toBe("tab");
  });

  it("sets aria-selected on exactly the active tab", () => {
    const { tabs } = renderTabs("two", () => {});

    expect(tabs.map((t) => t["aria-selected"])).toEqual([false, true, false]);
  });

  it("gives the active tab the only tab stop (roving tabindex)", () => {
    const { tabs } = renderTabs("three", () => {});

    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("wires each tab's aria-controls to its panel id", () => {
    const { tabs } = renderTabs("one", () => {});

    expect(tabs.map((t) => t.id)).toEqual([
      tabId("t", "one"),
      tabId("t", "two"),
      tabId("t", "three"),
    ]);
    expect(tabs.map((t) => t["aria-controls"])).toEqual([
      tabPanelId("t", "one"),
      tabPanelId("t", "two"),
      tabPanelId("t", "three"),
    ]);
  });

  it("labels the panel with the tab that controls it", () => {
    const panel = TabPanel({
      idPrefix: "t",
      value: "two",
      children: null,
    }) as VNode<any>;

    expect(panel.props.role).toBe("tabpanel");
    expect(panel.props.id).toBe(tabPanelId("t", "two"));
    expect(panel.props["aria-labelledby"]).toBe(tabId("t", "two"));
  });

  it("selects a tab on click", () => {
    let selected: Id | null = null;
    const { tabs } = renderTabs("one", (next) => {
      selected = next;
    });

    tabs[2].onClick!();

    expect(selected).toBe("three");
  });
});

describe("Tabs — keyboard behavior (the part tabs.js used to provide)", () => {
  it("ArrowRight moves to the next tab", () => {
    expect(press("ArrowRight", 0).selected).toBe("two");
  });

  it("ArrowLeft moves to the previous tab", () => {
    expect(press("ArrowLeft", 2).selected).toBe("two");
  });

  it("ArrowRight wraps from the last tab to the first", () => {
    expect(press("ArrowRight", 2).selected).toBe("one");
  });

  it("ArrowLeft wraps from the first tab to the last", () => {
    expect(press("ArrowLeft", 0).selected).toBe("three");
  });

  it("Home jumps to the first tab and End to the last", () => {
    expect(press("Home", 1).selected).toBe("one");
    expect(press("End", 1).selected).toBe("three");
  });

  it("consumes only the keys it handles", () => {
    // ArrowLeft/Right must not also scroll the page when the tablist used them.
    expect(press("ArrowRight", 0).prevented).toBe(true);
    expect(press("End", 0).prevented).toBe(true);

    // Anything else has to fall through untouched — Tab in particular, or the
    // roving tabindex would trap focus inside the tablist forever.
    const tab = press("Tab", 0);
    expect(tab.prevented).toBe(false);
    expect(tab.selected).toBeNull();
  });
});
