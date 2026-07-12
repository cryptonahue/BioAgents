/**
 * Menu — the Preact half of Basecoat's dropdown-menu component.
 *
 * WHY THIS FILE EXISTS
 *
 * Basecoat ships `basecoat-css/dist/js/dropdown-menu.js`, and this app
 * deliberately does NOT load it, for the same reason `Tabs.tsx` does not load
 * `tabs.js`: the script owns the DOM. It writes `aria-expanded` onto the
 * trigger, `aria-hidden` onto the popover, and adds/removes an `.active` class
 * on menu items — straight into a tree Preact owns. Two writers, one DOM, and
 * the next re-render silently reverts whatever the script did.
 *
 * The way out is the same as it was for tabs: Lyra's dropdown skin is keyed
 * entirely off roles and attributes that PREACT can render.
 *
 *   .dropdown-menu                                 (the relative wrapper)
 *   .dropdown-menu > [data-popover]                (the floating panel)
 *   [data-popover][aria-hidden='true']             (the hidden state)
 *   .dropdown-menu [role='menuitem']               (the item skin)
 *   .dropdown-menu [data-variant='destructive']    (the one status colour)
 *
 * Nothing in it needs a script. Render the attributes and the skin applies.
 *
 * THE POPOVER IS ALWAYS MOUNTED. It is `aria-hidden` when closed, never
 * unmounted. That is not incidental — it is what Lyra's CSS is written against:
 * `[data-popover]` is `visible opacity-100 scale-100 transition-all` and
 * `[aria-hidden='true']` is `invisible opacity-0 scale-95 -translate-y-2`. A
 * conditionally-rendered panel would pop in with no transition, and — the part
 * that actually matters — there would be no item in the DOM to move focus to on
 * the keystroke that opens the menu. `visibility: hidden` already takes the
 * closed panel out of the tab order and out of the accessibility tree, so
 * mounting it costs nothing.
 *
 * WHAT THE KEYBOARD CONTRACT IS, AND HOW IT DIFFERS FROM `dropdown-menu.js`
 *
 * A `role="menu"` whose arrow keys are dead is a lie to assistive tech, so the
 * behaviour the script provided has to be reimplemented here. It is NOT copied
 * verbatim, and the two deviations are deliberate:
 *
 *   1. DOM FOCUS, NOT `aria-activedescendant`. `dropdown-menu.js` keeps focus
 *      parked on the trigger and tracks the highlighted item with
 *      `aria-activedescendant` plus an `.active` class. That works, but the
 *      ARIA APG's menu-button pattern moves real focus into the menu, and real
 *      focus is what `:focus` styling, `Enter`/`Space` activation and
 *      `focusout`-based dismissal all fall out of for free. Items are all
 *      `tabIndex={-1}` — the trigger is the single tab stop, and `Tab` closes
 *      the menu rather than walking into it, which is what the APG asks for and
 *      what every unmanaged popup menu (Radix, Reach) ships.
 *
 *   2. ARROWS WRAP. `dropdown-menu.js` CLAMPS at both ends (`Math.min` /
 *      `Math.max`). The APG says wrapping is optional but recommended, `Tabs.tsx`
 *      in this same directory already wraps, and a two-item menu that dead-ends
 *      on the second ArrowDown feels broken. So it wraps.
 *
 * The full contract, which `Menu.test.tsx` holds this file to:
 *
 *   closed:  Enter / Space   native <button> activation -> onOpen()
 *            ArrowDown       open, focus the FIRST item
 *            ArrowUp         open, focus the LAST item
 *   open:    ArrowDown/Up    move focus, wrapping at both ends
 *            Home / End      focus the first / last item
 *            Enter / Space   native <button> activation on the focused item
 *            Escape          close, focus returns to the trigger
 *            Tab             close, focus leaves naturally (not trapped)
 *            click an item   close, focus returns to the trigger
 *            focus leaves    close (this is what dismisses on an outside click)
 *
 * DISMISSAL IS `focusout`, NOT A DOCUMENT LISTENER. Opening the menu means the
 * trigger was clicked or keyed, so focus is inside the wrapper by definition;
 * anything that dismisses the menu — a click elsewhere, a Tab away, a click on
 * empty page background — moves focus out of it, and `focusout` fires with a
 * `relatedTarget` outside the wrapper (or null). One handler replaces both the
 * `document.mousedown` listener the sidebar used to install and the full-screen
 * backdrop `<div>` the chat composer used to render.
 *
 * HOOK-FREE ON PURPOSE, like `Tabs.tsx`. The open flag lives in the caller, and
 * focus is moved by asking the DOM for the items at the moment the key is
 * pressed rather than by holding a `useRef` array of them. That is what lets the
 * component be INVOKED DIRECTLY in a test with no DOM and no render, which is the
 * only way components in this project can be tested — the DOM shim cannot drive
 * Preact's hook internals, and a `useRef` here would throw the moment the
 * component was called outside a render context. The keyboard contract above is
 * the part most worth testing, so it has to stay reachable from a test.
 */
import type { ComponentChildren, JSX } from "preact";

/** The id of the trigger `<button>` for `prefix`. Also labels the menu. */
export function menuTriggerId(prefix: string): string {
  return `${prefix}-menu-trigger`;
}

/** The id of the `[data-popover]` panel for `prefix`. The trigger controls it. */
export function menuPopoverId(prefix: string): string {
  return `${prefix}-menu-popover`;
}

/**
 * The ARIA a menu trigger must carry. Spread onto the caller's own `<button>` so
 * the trigger keeps whatever skin its page already gives it.
 */
export function menuTriggerProps(prefix: string, open: boolean) {
  return {
    id: menuTriggerId(prefix),
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "aria-controls": menuPopoverId(prefix),
  };
}

/** The enabled `[role=menuitem]`s of `root`, in DOM order. */
function menuItems(root: HTMLElement): HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>('[role="menuitem"]');
  return Array.from(nodes).filter(
    (item) =>
      !(item as HTMLButtonElement).disabled &&
      item.getAttribute("aria-disabled") !== "true",
  );
}

/**
 * The selector the trigger contract is written in, and the only place it is
 * spelled out. `[aria-haspopup]` is in it because `menuTriggerProps()` stamps
 * exactly that attribute on whatever the caller uses as a trigger — so an `<a>`
 * or a `<summary>` trigger resolves here just as a `<button>` does, as long as it
 * is a DIRECT CHILD of the wrapper. The `:scope >` half is not negotiable: Lyra
 * reaches the popover through `.dropdown-menu > [data-popover]`, a child
 * selector, so a trigger wrapped in a layout div would break the SKIN as well as
 * this lookup.
 */
const TRIGGER_SELECTOR = ":scope > button, :scope > [aria-haspopup]";

/**
 * The trigger of `root` — its first matching element child.
 *
 * FAILS LOUDLY. `closeToTrigger()` used to call `menuTrigger(root)?.focus()`, and
 * the optional chain swallowed a null: the menu closed, focus fell to `<body>`,
 * and a keyboard user pressing Escape silently lost their place — no throw, no
 * warning, nothing to grep for. A contract that is only documented is not
 * enforced. It does not THROW, because a dropped focus is a degradation and a
 * thrown error inside a keydown handler would take the whole page's interaction
 * down with it; a `console.error` naming the element is loud enough to be
 * impossible to miss in development and harmless in production.
 */
function menuTrigger(root: HTMLElement): HTMLElement | null {
  const trigger = root.querySelector<HTMLElement>(TRIGGER_SELECTOR);
  if (!trigger) {
    console.error(
      "[DropdownMenu] No trigger found. The trigger must be a DIRECT child of " +
        `.dropdown-menu and match \`${TRIGGER_SELECTOR}\` — spread ` +
        "menuTriggerProps() onto it and do not wrap it in a layout div. " +
        "Focus cannot be returned to it, so Escape and item activation will " +
        "drop focus onto <body>.",
      root,
    );
  }
  return trigger;
}

/**
 * Is `root`'s popover open, as far as the DOM Preact has actually painted is
 * concerned?
 *
 * `open` is a prop, and by the time a deferred callback runs (see `afterPaint`)
 * the caller may have closed the menu — the prop the callback captured is stale.
 * The popover's own `aria-hidden` is not: Preact re-rendered it. So the DOM is
 * the source of truth for "is it still open two frames later".
 */
function isMenuOpen(root: HTMLElement): boolean {
  const popover = root.querySelector<HTMLElement>(":scope > [data-popover]");
  return !!popover && popover.getAttribute("aria-hidden") !== "true";
}

/**
 * Run `fn` after the browser has RECALCULATED STYLE for Preact's next render.
 *
 * The double `requestAnimationFrame` is load-bearing, and a single one is a bug
 * this slice actually shipped and then measured: pressing ArrowDown on the closed
 * menu opened it but left focus parked on the trigger.
 *
 * The sequence is: the key handler calls `onOpen()`, Preact re-renders on a
 * microtask (its default `debounceRendering`), so by the FIRST animation frame the
 * `aria-hidden="false"` attribute is already in the DOM — but rAF callbacks run
 * BEFORE the frame's style/layout phase, so the item's COMPUTED style is still the
 * closed one, `visibility: hidden`. A `visibility: hidden` element is not
 * focusable, and `.focus()` on it is a silent no-op. One more frame and the style
 * is fresh.
 *
 * Falls back to a macrotask where there is no `requestAnimationFrame` — which is
 * the test runner, not any browser this app ships to.
 */
function afterPaint(fn: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(fn));
  } else {
    setTimeout(fn, 0);
  }
}

export interface DropdownMenuProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** The trigger `<button>` first, then exactly one `<MenuPopover>`. */
  children: ComponentChildren;
  className?: string;
}

/**
 * The `.dropdown-menu` wrapper, and the whole of the menu's behaviour.
 *
 * Lyra's rules reach the popover through `.dropdown-menu > [data-popover]`, a
 * CHILD selector, so the trigger and the popover must both be direct children of
 * this element — do not wrap either one in a layout div.
 */
export function DropdownMenu({
  open,
  onOpen,
  onClose,
  children,
  className,
}: DropdownMenuProps) {
  /** Close and hand focus back to the trigger, the way `Escape` must. */
  const closeToTrigger = (root: HTMLElement) => {
    onClose();
    // Before the re-render, so the item we are leaving is still focusable and
    // the `focusout` it fires names the trigger as its `relatedTarget` — which
    // is inside the wrapper, so the dismissal handler below correctly ignores it.
    menuTrigger(root)?.focus();
  };

  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    const root = event.currentTarget;

    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        closeToTrigger(root);
      }
      return;
    }

    if (!open) {
      // `Enter` and `Space` are not handled here: the trigger is a real
      // <button>, so the browser turns them into a click, and the caller's
      // `onClick` opens the menu. Only the arrows need intercepting, because
      // they also have to say WHICH item to land on.
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const toLast = event.key === "ArrowUp";
        onOpen();
        // The items exist already (the popover is always mounted) but they are
        // `visibility: hidden` until `aria-hidden` flips, and a hidden element
        // cannot take focus. So the focus call has to wait for Preact to paint
        // the open state — one frame, not a guess at a timeout.
        afterPaint(() => {
          // The menu may already be CLOSED again by the time this runs: ArrowDown
          // then Escape inside two frames (~32ms — trivially reachable with key
          // repeat) queues this callback and then hides the panel before it
          // fires. Focusing an item inside a `visibility: hidden` panel happens
          // to be a silent no-op today, so the outcome was benign — but that is
          // an accident of the CSS, not a decision. Ask the DOM whether the menu
          // is still open, and if it is not, do nothing on purpose.
          if (!isMenuOpen(root)) return;
          const items = menuItems(root);
          (toLast ? items[items.length - 1] : items[0])?.focus();
        });
      }
      return;
    }

    if (event.key === "Tab") {
      // Not `preventDefault`ed: a menu does not trap focus. Tab closes it and
      // moves on to whatever follows the trigger. `focusout` would catch this
      // anyway; closing here keeps the two paths from racing.
      onClose();
      return;
    }

    const items = menuItems(root);
    if (items.length === 0) return;

    const active = root.ownerDocument.activeElement as HTMLElement | null;
    const index = active ? items.indexOf(active) : -1;
    const last = items.length - 1;
    let next: number;

    switch (event.key) {
      case "ArrowDown":
        next = index === -1 || index === last ? 0 : index + 1;
        break;
      case "ArrowUp":
        next = index === -1 || index === 0 ? last : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        // Everything else falls through untouched — typing, shortcuts, and any
        // key the page has its own plans for.
        return;
    }

    event.preventDefault();
    items[next]?.focus();
  };

  /**
   * Activating an item closes the menu. Delegated rather than wired onto each
   * `<MenuItem>` so that `MenuItem` stays a dumb `<button>` the caller can hand
   * any `onClick` to — including one that routes away, at which point the
   * `.focus()` below lands on a detached node and harmlessly does nothing.
   */
  const onClick = (event: JSX.TargetedMouseEvent<HTMLDivElement>) => {
    if (!open) return;
    const target = event.target as HTMLElement | null;
    const item = target?.closest?.('[role="menuitem"]');
    if (item) closeToTrigger(event.currentTarget);
  };

  /** The outside-click dismissal. See the header. */
  const onFocusOut = (event: JSX.TargetedFocusEvent<HTMLDivElement>) => {
    if (!open) return;
    const next = event.relatedTarget as Node | null;
    if (!next || !event.currentTarget.contains(next)) onClose();
  };

  return (
    <div
      class={className ? `dropdown-menu ${className}` : "dropdown-menu"}
      onKeyDown={onKeyDown}
      onClick={onClick}
      onFocusOut={onFocusOut}
    >
      {children}
    </div>
  );
}

export interface MenuPopoverProps {
  idPrefix: string;
  open: boolean;
  /** Which edge of the trigger the panel hangs off. Lyra reads `data-side`. */
  side?: "top" | "bottom";
  /** Contents: `[role=heading]` / `<MenuSeparator>` first if any, then `<Menu>`. */
  children: ComponentChildren;
  className?: string;
}

/**
 * The floating panel. `p-1` is a Tailwind utility rather than a house rule on
 * purpose: Lyra sets `p-0` on `.dropdown-menu > [data-popover]` and expects the
 * markup to supply the padding, and its separator rule (`-mx-1`) is written to
 * cancel exactly this 1-unit inset. The utilities layer is declared last in
 * `basecoat.css`, so `p-1` beats Lyra's `p-0` by layer, not by accident.
 *
 * `min-w-full` restores the "at least as wide as the trigger" sizing that Lyra
 * asks for with `min-width: anchor-size(width)` — a CSS anchor-positioning
 * function that is invalid at computed-value time without an anchor name, which
 * this menu has none of.
 */
export function MenuPopover({
  idPrefix,
  open,
  side = "bottom",
  children,
  className,
}: MenuPopoverProps) {
  const base = "p-1 min-w-full";
  return (
    <div
      id={menuPopoverId(idPrefix)}
      data-popover
      data-side={side}
      aria-hidden={!open}
      class={className ? `${base} ${className}` : base}
    >
      {children}
    </div>
  );
}

/**
 * The `[role=menu]` itself. Its children must be `<MenuItem>`s and nothing else
 * — `role="menu"` only permits `menuitem` / `menuitemcheckbox` / `menuitemradio`
 * / `group` / `separator` children, which is why the account e-mail line in the
 * sidebar is a heading OUTSIDE this element rather than inside it.
 */
export function Menu({
  idPrefix,
  children,
}: {
  idPrefix: string;
  children: ComponentChildren;
}) {
  return (
    <div role="menu" aria-labelledby={menuTriggerId(idPrefix)}>
      {children}
    </div>
  );
}

export interface MenuItemProps {
  children: ComponentChildren;
  onClick?: (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  /**
   * `destructive` is the only variant Basecoat models, and it is the one this
   * app needs here (Log out). It paints `text-destructive` at rest and a tinted
   * fill when focused — see `menus.css`.
   */
  variant?: "destructive";
}

/**
 * One `[role=menuitem]`. `tabIndex={-1}` on every item, always: the trigger is
 * the menu's single tab stop and focus is moved by `DropdownMenu`'s key handler.
 */
export function MenuItem({
  children,
  onClick,
  disabled,
  variant,
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={disabled}
      data-variant={variant}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A `[role=separator]`. Lyra paints it `bg-border h-px -mx-1`. */
export function MenuSeparator() {
  return <hr role="separator" />;
}

/**
 * A muted label line above the menu — Lyra's `[role=heading]` skin.
 *
 * It must be a SIBLING of `<Menu>` inside `<MenuPopover>`, never a child of it:
 * `role="menu"` does not permit a heading child. Lyra's skin rule is
 * `.dropdown-menu [role='heading']`, a plain descendant selector, so it lands
 * here just the same. `truncate` is a Tailwind utility (long e-mail addresses).
 */
export function MenuHeading({ children }: { children: ComponentChildren }) {
  return (
    <div role="heading" aria-level={2} class="truncate">
      {children}
    </div>
  );
}
