/**
 * Tabs — the Preact half of Basecoat's tab component.
 *
 * WHY THIS FILE EXISTS
 *
 * Basecoat ships `basecoat-css/dist/js/tabs.js`, and this app deliberately does
 * NOT load it. That script owns the DOM: on init and on every click it walks the
 * tablist and *writes* `aria-selected`, `tabindex` and `panel.hidden` straight
 * into the tree. Preact owns this tree. Two writers, one DOM, and the next
 * re-render silently reverts whatever the script did.
 *
 * The way out is that Lyra's tab CSS is keyed entirely off ARIA:
 *
 *   .tabs > [role='tablist'] > [role='tab']                      (the resting skin)
 *   .tabs > [role='tablist'] > [role='tab'][aria-selected='true'] (the selected skin)
 *
 * There is no `.active` class and no JS-only hook anywhere in it. So if PREACT
 * renders `role` and `aria-selected`, the entire Lyra skin applies with no script
 * at all. That is the whole reason the CSS-only approach works, and it is why the
 * source of truth for "which tab is selected" is Preact state, as it should be.
 *
 * What `tabs.js` provides beyond styling is KEYBOARD BEHAVIOR, and a `role="tab"`
 * without it is a lie to assistive tech: a screen-reader user is told "tab, 1 of 3"
 * and then finds the arrow keys dead. So this component reimplements exactly what
 * the script does:
 *
 *   - roving tabindex — the selected tab is the only tab stop (`tabindex=0`),
 *     the rest are `-1`, so Tab enters and leaves the tablist as ONE stop
 *   - ArrowRight / ArrowLeft — move within the list, wrapping at both ends
 *   - Home / End — jump to the first / last tab
 *   - automatic activation — moving focus also selects, which is what `tabs.js`
 *     does (`root.select(nextTab, true)`) and what the ARIA APG recommends for
 *     tab sets whose panels are cheap to swap
 *
 * PANELS ARE CONDITIONALLY RENDERED. Both call sites mount only the active panel
 * (`{tab === 'contras' && <ContrasTab/>}`), so `aria-controls` on an INACTIVE tab
 * points at an id that is not in the document. That is deliberate and is what
 * Radix, Reach and every other unmount-by-default tab implementation ships: the
 * selected tab — the only one whose panel relationship an AT will actually
 * traverse — always resolves. The alternative (rendering every panel and hiding
 * the inactive ones) would mount three admin tables and fire their fetches.
 *
 * `role="tabpanel"` intentionally carries NO `tabindex`. The APG only asks for a
 * focusable panel when the panel holds no focusable content; every panel here is
 * full of buttons and inputs, so adding a tab stop would just be an extra, empty
 * stop on the way in.
 */
import type { ComponentChildren } from "preact";

/** The id of the <button role="tab"> for `value`. */
export function tabId(prefix: string, value: string): string {
  return `${prefix}-tab-${value}`;
}

/** The id of the <div role="tabpanel"> that `value`'s tab controls. */
export function tabPanelId(prefix: string, value: string): string {
  return `${prefix}-panel-${value}`;
}

export interface TabItem<T extends string> {
  value: T;
  label: ComponentChildren;
}

/**
 * The `.tabs` shell. Lyra's rules are all `.tabs > [role=…]` CHILD selectors, so
 * the tablist and the panel must both be direct children of this element — do not
 * wrap either one in a layout div.
 */
export function Tabs({
  children,
  className,
}: {
  children: ComponentChildren;
  className?: string;
}) {
  return <div class={className ? `tabs ${className}` : "tabs"}>{children}</div>;
}

export interface TabListProps<T extends string> {
  /** Namespace for the generated tab/panel ids. Must be unique per tablist. */
  idPrefix: string;
  /** Names the tablist for assistive tech. */
  label: string;
  tabs: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
}

/**
 * HOOK-FREE ON PURPOSE. This component holds no state of its own — the selected
 * tab is the caller's — and it moves focus the way `tabs.js` did: by asking the
 * DOM for its sibling tabs at the moment the key is pressed, rather than by
 * keeping a `useRef` array of them.
 *
 * That is not a stylistic choice. Being a pure function of its props means it can
 * be INVOKED DIRECTLY in a test with no DOM and no render, which is the only way
 * the components in this project can be tested (see the header of
 * `CompoundAuthorityBadge.test.tsx` — the DOM shim cannot drive Preact's hook
 * internals, and a `useRef` here throws the moment the component is called
 * outside a render context). The keyboard contract that replaces `tabs.js` is the
 * part most worth testing, so it must stay reachable from a test.
 */
export function TabList<T extends string>({
  idPrefix,
  label,
  tabs,
  value,
  onChange,
}: TabListProps<T>) {
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    let next: number;

    switch (event.key) {
      case "ArrowRight":
        next = index === last ? 0 : index + 1;
        break;
      case "ArrowLeft":
        next = index === 0 ? last : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        // Everything else falls through untouched. `Tab` above all: the roving
        // tabindex means it is the key that LEAVES the tablist, and swallowing
        // it would trap focus here.
        return;
    }

    // Only now that we know we handled the key — an unconsumed ArrowLeft/Right
    // still has to reach the page.
    event.preventDefault();
    onChange(tabs[next].value);

    // Automatic activation: `tabs.js` moved focus with the selection
    // (`root.select(nextTab, true)`), and a roving tabindex REQUIRES it — the tab
    // we just deselected is about to become `tabindex=-1`, so leaving focus on it
    // would strand the keyboard user outside the tab order entirely.
    const tablist = (event.currentTarget as HTMLElement | null)?.parentElement;
    const nodes = tablist?.querySelectorAll<HTMLElement>('[role="tab"]');
    nodes?.[next]?.focus();
  };

  return (
    <div role="tablist" aria-label={label} aria-orientation="horizontal">
      {tabs.map((tab, index) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          id={tabId(idPrefix, tab.value)}
          aria-selected={tab.value === value}
          aria-controls={tabPanelId(idPrefix, tab.value)}
          // Roving tabindex: the tablist is a SINGLE stop in the page's tab order.
          tabIndex={tab.value === value ? 0 : -1}
          onClick={() => onChange(tab.value)}
          onKeyDown={(event: KeyboardEvent) => onKeyDown(event, index)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** The panel `value`'s tab controls. Render only when `value` is selected. */
export function TabPanel({
  idPrefix,
  value,
  children,
}: {
  idPrefix: string;
  value: string;
  children: ComponentChildren;
}) {
  return (
    <div
      role="tabpanel"
      id={tabPanelId(idPrefix, value)}
      aria-labelledby={tabId(idPrefix, value)}
    >
      {children}
    </div>
  );
}
