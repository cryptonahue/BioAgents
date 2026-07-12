import { render } from "preact";
import { Icon } from "../components/icons";

/**
 * EXTERNAL LINKS IN MARKDOWN, WHICH IS WHERE MOST OF THIS APP'S LINKS ACTUALLY ARE.
 *
 * Every `<a>` this client writes in JSX can be given `target` and `rel` at its call
 * site. The links inside an assistant message and inside a paper chat turn cannot:
 * they are produced by `marked` from the model's markdown, as an HTML STRING, and
 * `marked` emits a bare `<a href="…">` with no attributes. Those were the majority
 * of the external links in the product and NOT ONE of them opened in a new tab —
 * clicking a DOI in an answer navigated the SPA away from the conversation, losing
 * the reader's place, which is the failure the user reported.
 *
 * This is the same seam `renderMarkdown` already uses for tables, one step later:
 * after the sanitized HTML is in the DOM, walk it and decorate.
 *
 * WHAT "EXTERNAL" MEANS HERE — and this is the part that must be precise, because
 * putting `target="_blank"` on an INTERNAL link is its own bug (it breaks SPA
 * routing and opens a second copy of the app):
 *
 *   external  = an absolute http(s) URL whose ORIGIN differs from ours.
 *   internal  = anything relative (`/library/…`, `#anchor`), and an absolute URL
 *               that happens to point back at this origin.
 *   ignored   = `mailto:`, `tel:` and any other scheme — those are handed to the
 *               OS, not to a browsing context, and `target` is meaningless on them.
 *
 * `noopener` is a SECURITY requirement, not a style choice: without it the page we
 * open receives a live `window.opener` handle to this window and can navigate it.
 * `noreferrer` goes with it so the target does not learn the conversation URL.
 *
 * WCAG 3.2.5: opening a new tab with no warning is a change of context the user did
 * not request. The affordance is BOTH an icon (for sighted readers) and an
 * `aria-label` that ends in "(opens in a new tab)" — the icon is `aria-hidden`, so
 * a screen reader hears the link text plus the warning, once.
 */

interface ExternalLinkProps extends preact.JSX.HTMLAttributes<HTMLAnchorElement> {
  href: string;
  className?: string;
  children?: preact.ComponentChildren;
  /**
   * The accessible name, WITHOUT the new-tab warning — this component appends it.
   *
   * REQUIRED, and deliberately so: `aria-label` REPLACES the accessible name, so
   * deriving it from an optional prop would have produced links whose only name was
   * "(opens in a new tab)" the moment a call site forgot to pass one. Making it
   * mandatory also forces each site to say something better than the visible text
   * where the visible text is a bare "DOI".
   */
  label: string;
  title?: string;
  onClick?: (e: MouseEvent) => void;
}

/**
 * The JSX counterpart of `decorateExternalLinks`, for the links this client writes
 * itself. One component so `target`, `rel` and the affordance cannot drift apart at
 * eleven different call sites — which is exactly what had happened: three DOI links
 * in the graph explorer and one in the research brain carried `rel="noreferrer"`
 * with NO `noopener`, so the page they opened kept a live handle on this window.
 *
 * Hook-free, so it can be invoked as a plain function (the `ui/Tabs` / `ui/Menu`
 * precedent).
 */
export function ExternalLink({
  href,
  className,
  children,
  label,
  ...rest
}: ExternalLinkProps) {
  return (
    /* `...rest` is load-bearing, not tidiness. Two of the call sites are Basecoat
       BUTTONS (`.btn` + `data-variant` + `data-tone` on the landing page); a
       destructure-only signature would have silently swallowed those attributes and
       the buttons would have rendered unstyled. */
    <a
      {...rest}
      href={href}
      className={className}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${label} (opens in a new tab)`}
    >
      {children}
      <Icon name="externalLink" size={12} className="external-link-icon" />
    </a>
  );
}

/** True only for an absolute http(s) URL that leaves this origin. */
export function isExternalHref(href: string | null | undefined): boolean {
  if (!href) return false;
  if (!/^https?:\/\//i.test(href)) return false;
  try {
    return new URL(href).origin !== window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Decorate every external link inside `root`. Idempotent — re-running it over the
 * same DOM (a re-render, a streamed message growing) will not double-decorate.
 */
export function decorateExternalLinks(root: HTMLElement | null): void {
  if (!root) return;

  root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
    if (anchor.dataset.externalLink === "true") return;
    if (!isExternalHref(anchor.getAttribute("href"))) return;

    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
    anchor.classList.add("external-link");

    // Read the name BEFORE the icon is appended, so the glyph does not end up in
    // the label.
    const label = (anchor.textContent || anchor.getAttribute("href") || "").trim();
    anchor.setAttribute("aria-label", `${label} (opens in a new tab)`);

    // The icon goes through `Icon.tsx` like every other glyph in the client, which
    // is why this file is a .tsx and mounts a Preact subtree rather than injecting
    // a hand-copied SVG string.
    const slot = document.createElement("span");
    slot.className = "external-link-icon";
    slot.setAttribute("aria-hidden", "true");
    anchor.appendChild(slot);
    render(<Icon name="externalLink" size={12} />, slot);

    anchor.dataset.externalLink = "true";
  });
}
