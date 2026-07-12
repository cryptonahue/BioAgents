/**
 * Unit tests for the Menu primitive (`client/src/components/ui/Menu.tsx`).
 *
 * This component exists because Basecoat's `dropdown-menu.js` is deliberately NOT
 * loaded — it writes `aria-expanded`, `aria-hidden` and an `.active` class
 * straight into DOM that Preact owns. Everything that script did, this component
 * has to do, and these tests are what hold it to that. They cover the two halves:
 *
 *   1. ARIA — Lyra's ENTIRE dropdown skin is keyed off `.dropdown-menu`,
 *      `[data-popover]`, `aria-hidden`, `[role=menu]` and `[role=menuitem]`. If
 *      Preact stops rendering those, the menu silently loses its styling — and,
 *      for `aria-hidden`, stops HIDING — with no error anywhere. Asserted here.
 *   2. KEYBOARD — a `role="menu"` whose arrow keys are dead is a lie to assistive
 *      tech. Open-on-arrow, Up/Down (wrapping), Home/End, Escape-returns-focus,
 *      Tab-closes and focusout-dismissal are the behaviour `dropdown-menu.js`
 *      provided, and are asserted here against the real handler.
 *
 * Test strategy matches the other component tests in this project: call the
 * component as a plain function and walk the returned vnode tree. `render()` is
 * avoided because the project's DOM shim has incompatibilities with Preact
 * internals, and `Menu.tsx` is hook-free precisely so that this works.
 *
 * The handlers reach for the DOM through `event.currentTarget`, so the tests hand
 * them a hand-built stand-in `root` whose `querySelectorAll` returns fake items
 * that record `.focus()`. That is enough to assert WHICH item the handler chose,
 * which is the whole of the contract.
 */
import { describe, expect, it } from "bun:test";
import type { VNode } from "preact";

import {
  DropdownMenu,
  Menu,
  MenuHeading,
  MenuItem,
  MenuPopover,
  MenuSeparator,
  menuPopoverId,
  menuTriggerId,
  menuTriggerProps,
} from "../Menu";

/* ------------------------------------------------------------------ fixtures */

interface FakeItem {
  focused: boolean;
  disabled: boolean;
  ariaDisabled: string | null;
  focus(): void;
  getAttribute(name: string): string | null;
}

function fakeItem(disabled = false, ariaDisabled: string | null = null): FakeItem {
  return {
    focused: false,
    disabled,
    ariaDisabled,
    focus() {
      this.focused = true;
    },
    getAttribute(name: string) {
      return name === "aria-disabled" ? this.ariaDisabled : null;
    },
  };
}

/** The selector `Menu.tsx` resolves its trigger with. Kept verbatim: broadening
 *  it is what lets a non-`<button>` trigger (an `<a>` carrying
 *  `aria-haspopup`) resolve, and the test has to fail if it narrows again. */
const TRIGGER_SELECTOR = ":scope > button, :scope > [aria-haspopup]";
const POPOVER_SELECTOR = ":scope > [data-popover]";

interface FakeRootOptions {
  /** What the DOM says AT CALLBACK TIME — not the `open` prop. See afterPaint. */
  popoverOpen?: boolean;
  /** Drop the trigger to construct the broken contract Finding 4 is about. */
  withTrigger?: boolean;
}

/** A stand-in for the `.dropdown-menu` element the handlers query. */
function fakeRoot(
  items: FakeItem[],
  activeElement: unknown = null,
  { popoverOpen = true, withTrigger = true }: FakeRootOptions = {},
) {
  const trigger = { focused: false, focus() { this.focused = true; } };
  const popover = {
    getAttribute: (name: string) =>
      name === "aria-hidden" ? String(!popoverOpen) : null,
  };
  return {
    trigger,
    querySelector: (selector: string) => {
      if (selector === TRIGGER_SELECTOR) return withTrigger ? trigger : null;
      if (selector === POPOVER_SELECTOR) return popover;
      return null;
    },
    querySelectorAll: () => items,
    contains: (node: unknown) => items.includes(node as FakeItem) || node === trigger,
    ownerDocument: { activeElement },
  };
}

/** Capture whatever `fn` writes to `console.error`. */
function captureErrors(fn: () => void): unknown[][] {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return calls;
}

interface FakeEvent {
  key?: string;
  currentTarget: unknown;
  target?: unknown;
  relatedTarget?: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function keyEvent(key: string, currentTarget: unknown): FakeEvent {
  return {
    key,
    currentTarget,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

/** The props of the `<div class="dropdown-menu">` DropdownMenu returns. */
function wrapper(open: boolean, onOpen = () => {}, onClose = () => {}) {
  const tree = DropdownMenu({
    open,
    onOpen,
    onClose,
    children: null,
  }) as VNode<any>;
  return tree.props as {
    class: string;
    onKeyDown: (event: unknown) => void;
    onClick: (event: unknown) => void;
    onFocusOut: (event: unknown) => void;
  };
}

/**
 * The open-and-focus step is deferred until after Preact paints the open state
 * (a hidden item cannot take focus). Drain that. There is no
 * `requestAnimationFrame` under the test runner, so `Menu.tsx` falls back to a
 * macrotask — which is what this awaits.
 */
function nextFrame() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/* ---------------------------------------------------------------------- ARIA */

describe("Menu — the Basecoat contract Lyra's CSS is keyed off", () => {
  it("wraps in .dropdown-menu, which is what makes the popover position at all", () => {
    expect(wrapper(false).class).toBe("dropdown-menu");
    const tree = DropdownMenu({
      open: false,
      onOpen: () => {},
      onClose: () => {},
      children: null,
      className: "sidebar-user",
    }) as VNode<any>;
    expect(tree.props.class).toBe("dropdown-menu sidebar-user");
  });

  it("hides the popover with aria-hidden, not by unmounting it", () => {
    const closed = MenuPopover({
      idPrefix: "u",
      open: false,
      children: null,
    }) as VNode<any>;
    const open = MenuPopover({
      idPrefix: "u",
      open: true,
      side: "top",
      children: null,
    }) as VNode<any>;

    // Lyra paints `[data-popover]` visible by default and `[aria-hidden=true]`
    // invisible/opacity-0. The attribute IS the closed state.
    expect(closed.props["aria-hidden"]).toBe(true);
    expect(open.props["aria-hidden"]).toBe(false);
    expect(closed.props["data-popover"]).toBe(true);
    expect(closed.props.id).toBe(menuPopoverId("u"));

    // `data-side` is how Lyra decides the panel hangs UPWARD off the trigger.
    expect(closed.props["data-side"]).toBe("bottom");
    expect(open.props["data-side"]).toBe("top");

    // `p-1` cancels Lyra's `p-0`, and the separator's `-mx-1` is written against
    // exactly this inset. `min-w-full` restores the sizing Lyra asks for with an
    // `anchor-size()` that has no anchor to read.
    expect(open.props.class).toContain("p-1");
    expect(open.props.class).toContain("min-w-full");
  });

  it("wires the trigger to the popover it controls", () => {
    const props = menuTriggerProps("u", true);
    expect(props.id).toBe(menuTriggerId("u"));
    expect(props["aria-haspopup"]).toBe("menu");
    expect(props["aria-expanded"]).toBe(true);
    expect(props["aria-controls"]).toBe(menuPopoverId("u"));
    expect(menuTriggerProps("u", false)["aria-expanded"]).toBe(false);
  });

  it("labels the menu with its trigger and renders role=menu", () => {
    const tree = Menu({ idPrefix: "u", children: null }) as VNode<any>;
    expect(tree.props.role).toBe("menu");
    expect(tree.props["aria-labelledby"]).toBe(menuTriggerId("u"));
  });

  it("renders items as role=menuitem, never in the page tab order", () => {
    const tree = MenuItem({ children: "Settings" }) as VNode<any>;
    expect(tree.type).toBe("button");
    expect(tree.props.role).toBe("menuitem");
    expect(tree.props.type).toBe("button");
    // The trigger is the menu's single tab stop; focus inside is script-moved.
    expect(tree.props.tabIndex).toBe(-1);
    expect(tree.props["data-variant"]).toBeUndefined();

    const danger = MenuItem({
      children: "Log out",
      variant: "destructive",
    }) as VNode<any>;
    // Lyra's ONE status colour. `data-variant` is Basecoat 1.0's API.
    expect(danger.props["data-variant"]).toBe("destructive");
  });

  it("keeps the heading OUT of role=menu — a menu may not have a heading child", () => {
    const tree = MenuHeading({ children: "a@b.com" }) as VNode<any>;
    expect(tree.props.role).toBe("heading");
    expect(tree.props["aria-level"]).toBe(2);
    expect(tree.type).not.toBe("button");

    const sep = MenuSeparator() as VNode<any>;
    expect(sep.type).toBe("hr");
    expect(sep.props.role).toBe("separator");
  });
});

/* ------------------------------------------------------------------ KEYBOARD */

describe("Menu — the keyboard contract that replaces dropdown-menu.js", () => {
  it("ArrowDown on a closed menu opens it and lands on the FIRST item", async () => {
    let opened = false;
    const items = [fakeItem(), fakeItem(), fakeItem()];
    const root = fakeRoot(items);
    const event = keyEvent("ArrowDown", root);

    wrapper(false, () => {
      opened = true;
    }).onKeyDown(event);

    expect(opened).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    // The focus call waits one frame — the items exist, but they are
    // `visibility: hidden` until Preact paints `aria-hidden=false`.
    await nextFrame();
    expect(items.map((item) => item.focused)).toEqual([true, false, false]);
  });

  it("ArrowUp on a closed menu opens it and lands on the LAST item", async () => {
    let opened = false;
    const items = [fakeItem(), fakeItem(), fakeItem()];
    const event = keyEvent("ArrowUp", fakeRoot(items));

    wrapper(false, () => {
      opened = true;
    }).onKeyDown(event);

    expect(opened).toBe(true);
    await nextFrame();
    expect(items.map((item) => item.focused)).toEqual([false, false, true]);
  });

  it("leaves Enter and Space alone on a closed menu — the trigger is a real button", () => {
    let opened = false;
    for (const key of ["Enter", " "]) {
      const event = keyEvent(key, fakeRoot([fakeItem()]));
      wrapper(false, () => {
        opened = true;
      }).onKeyDown(event);
      // Not consumed: the browser turns it into a click on the <button>, and the
      // caller's onClick opens the menu. Swallowing it here would double-fire.
      expect(event.defaultPrevented).toBe(false);
    }
    expect(opened).toBe(false);
  });

  it("ArrowDown walks down and WRAPS at the end", () => {
    const items = [fakeItem(), fakeItem(), fakeItem()];

    const first = keyEvent("ArrowDown", fakeRoot(items, items[0]));
    wrapper(true).onKeyDown(first);
    expect(first.defaultPrevented).toBe(true);
    expect(items[1].focused).toBe(true);

    // Basecoat's own script CLAMPS here. This wraps — see the header of Menu.tsx.
    const last = keyEvent("ArrowDown", fakeRoot(items, items[2]));
    wrapper(true).onKeyDown(last);
    expect(items[0].focused).toBe(true);
  });

  it("ArrowUp walks up and WRAPS at the start", () => {
    const items = [fakeItem(), fakeItem(), fakeItem()];

    const mid = keyEvent("ArrowUp", fakeRoot(items, items[2]));
    wrapper(true).onKeyDown(mid);
    expect(items[1].focused).toBe(true);

    const top = keyEvent("ArrowUp", fakeRoot(items, items[0]));
    wrapper(true).onKeyDown(top);
    expect(items[2].focused).toBe(true);
  });

  it("Home and End jump to the ends", () => {
    const items = [fakeItem(), fakeItem(), fakeItem()];

    wrapper(true).onKeyDown(keyEvent("Home", fakeRoot(items, items[2])));
    expect(items[0].focused).toBe(true);

    wrapper(true).onKeyDown(keyEvent("End", fakeRoot(items, items[0])));
    expect(items[2].focused).toBe(true);
  });

  it("skips disabled items entirely", () => {
    const items = [fakeItem(), fakeItem(true), fakeItem(false, "true"), fakeItem()];
    wrapper(true).onKeyDown(keyEvent("End", fakeRoot(items, items[0])));
    // The last ENABLED item, not the last item.
    expect(items[3].focused).toBe(true);
    expect(items[1].focused).toBe(false);
    expect(items[2].focused).toBe(false);
  });

  it("Escape closes and returns focus to the trigger", () => {
    let closed = false;
    const items = [fakeItem()];
    const root = fakeRoot(items, items[0]);
    const event = keyEvent("Escape", root);

    wrapper(true, () => {}, () => {
      closed = true;
    }).onKeyDown(event);

    expect(closed).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(root.trigger.focused).toBe(true);
  });

  it("Tab closes WITHOUT trapping focus", () => {
    let closed = false;
    const root = fakeRoot([fakeItem()]);
    const event = keyEvent("Tab", root);

    wrapper(true, () => {}, () => {
      closed = true;
    }).onKeyDown(event);

    expect(closed).toBe(true);
    // Not consumed — the browser still moves focus on to whatever follows.
    expect(event.defaultPrevented).toBe(false);
    expect(root.trigger.focused).toBe(false);
  });

  it("passes every other key through untouched", () => {
    const items = [fakeItem(), fakeItem()];
    const event = keyEvent("a", fakeRoot(items, items[0]));
    wrapper(true).onKeyDown(event);
    expect(event.defaultPrevented).toBe(false);
    expect(items.some((item) => item.focused)).toBe(false);
  });

  it("closes and returns focus to the trigger when an item is activated", () => {
    let closed = false;
    const items = [fakeItem()];
    const root = fakeRoot(items);
    const item = { closest: (selector: string) => (selector === '[role="menuitem"]' ? {} : null) };

    wrapper(true, () => {}, () => {
      closed = true;
    }).onClick({ currentTarget: root, target: item });

    expect(closed).toBe(true);
    expect(root.trigger.focused).toBe(true);
  });

  it("dismisses on focus leaving the wrapper — this is the outside click", () => {
    const items = [fakeItem()];
    const root = fakeRoot(items);

    let closed = 0;
    const handlers = wrapper(true, () => {}, () => {
      closed += 1;
    });

    // Focus moved somewhere outside (or nowhere — a click on empty background).
    handlers.onFocusOut({ currentTarget: root, relatedTarget: null });
    expect(closed).toBe(1);

    // Focus moved BETWEEN items inside the menu: not a dismissal.
    handlers.onFocusOut({ currentTarget: root, relatedTarget: items[0] });
    expect(closed).toBe(1);

    // A closed menu never re-fires the close.
    wrapper(false, () => {}, () => {
      closed += 1;
    }).onFocusOut({ currentTarget: root, relatedTarget: null });
    expect(closed).toBe(1);
  });
});

/* ------------------------------------------------- THE CONTRACTS, ENFORCED */

describe("Menu — the trigger contract fails LOUDLY, not silently", () => {
  it("screams when the trigger cannot be resolved, instead of dropping focus", () => {
    let closed = false;
    const root = fakeRoot([fakeItem()], null, { withTrigger: false });

    // A caller who wrapped the trigger in a layout div, or used a plain <span>.
    // The menu still closes — a dropped focus is a degradation, not a reason to
    // throw inside a keydown handler and take the page's interaction down — but
    // it is now impossible to ship without noticing.
    const errors = captureErrors(() => {
      wrapper(true, () => {}, () => {
        closed = true;
      }).onKeyDown(keyEvent("Escape", root));
    });

    expect(closed).toBe(true);
    expect(errors.length).toBe(1);
    expect(String(errors[0][0])).toContain("[DropdownMenu] No trigger found");
  });

  it("resolves a non-<button> trigger that carries aria-haspopup", () => {
    // `menuTriggerProps()` stamps `aria-haspopup="menu"` on whatever the caller
    // uses. An <a> trigger is a legitimate shape; the old `:scope > button`
    // selector returned null for it and said nothing.
    const link = { focused: false, focus() { this.focused = true; } };
    const root = {
      querySelector: (selector: string) =>
        selector === TRIGGER_SELECTOR ? link : null,
      querySelectorAll: () => [] as FakeItem[],
      contains: () => false,
      ownerDocument: { activeElement: null },
    };

    const errors = captureErrors(() => {
      wrapper(true, () => {}, () => {}).onKeyDown(keyEvent("Escape", root));
    });

    expect(link.focused).toBe(true);
    expect(errors.length).toBe(0);
  });

  it("does not focus an item when the menu closed before the frame arrived", async () => {
    // ArrowDown queues the focus for two frames' time; Escape within those two
    // frames (~32ms, reachable with key repeat) closes the menu first. The
    // queued callback must notice — the DOM's `aria-hidden`, not the stale
    // `open` prop it captured, is what it asks.
    const items = [fakeItem(), fakeItem()];
    const root = fakeRoot(items, null, { popoverOpen: false });

    wrapper(false, () => {}, () => {}).onKeyDown(keyEvent("ArrowDown", root));
    await nextFrame();

    expect(items.some((item) => item.focused)).toBe(false);
  });
});
