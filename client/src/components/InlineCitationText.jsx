import { render } from 'preact';
import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { parseCitationsFromText, extractDomainName } from '../utils/parseCitations';
import { openProvenanceLightbox, openProvenanceInTab } from '../utils/provenanceTrigger';
import { Icon } from './icons';

/**
 * Render markdown to sanitized HTML, giving any table Basecoat's `.table`.
 *
 * `marked` emits a BARE `<table>` with no attributes and no wrapper, so a Basecoat
 * table cannot be asked for at the call site the way every other component in this
 * app can — there is no JSX here, only an HTML string. Decorating that string is
 * the only seam. The `<table>` tag `marked` produces is always attribute-less and
 * markdown tables cannot nest, so the two substitutions are exact.
 *
 * `.table-container` is not cosmetic. Lyra's `.table` sets `whitespace-nowrap` on
 * every `th`/`td` and relies on the container's `overflow-x-auto` to scroll a wide
 * table. The hand-written skin this replaces had NEITHER — a wide markdown table
 * (and a table of measurements is exactly that) simply overflowed the message
 * column with no way to reach the right-hand cells. The container is the fix.
 *
 * Runs BEFORE DOMPurify, so the markup we add is sanitized like everything else.
 * DOMPurify keeps `div` and `class` by default.
 */
function renderMarkdown(text) {
  const html = marked(text)
    .replace(/<table>/g, '<div class="table-container"><table class="table">')
    .replace(/<\/table>/g, '</table></div>');
  return DOMPurify.sanitize(html);
}

/**
 * Extract a fact id from a citation URL. The chat agent emits citation URLs as
 * `/library/<docId>?fact=<factId>` when the answer is anchored to a specific
 * bioprospecting fact. The lightbox and the dedicated viewer both key on `factId`,
 * so we surface it via `data-fact-id`.
 *
 * Returns `null` for non-fact URLs (e.g., a DOI link or a library link without a
 * fact anchor). The chip is still annotated as a provenance trigger so screen
 * readers announce the affordance consistently, but the click handler falls back to
 * the legacy open-in-new-tab behavior.
 */
function factIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    // Tolerate absolute and relative URLs.
    const isAbsolute = /^https?:\/\//i.test(url);
    const parsed = isAbsolute
      ? new URL(url)
      : new URL(url, 'http://placeholder.local');
    // /library/<docId>?fact=<factId>  and  /viewer/<sourceId>?fact=<factId>
    if (
      parsed.pathname.startsWith('/library') ||
      parsed.pathname.startsWith('/viewer/')
    ) {
      const fact = parsed.searchParams.get('fact');
      if (fact && /^[A-Za-z0-9-]{6,}$/.test(fact)) return fact;
    }
  } catch {
    // Fall through: not a parseable URL.
  }
  // Direct fact id (UUID-shaped) — the chat agent may emit a raw fact id as the
  // URL. Match the common UUID shape and trust it; the lightbox 404s cleanly if
  // the id is bad.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url)) {
    return url;
  }
  return null;
}

/**
 * A DOI IS NOT A HOSTNAME, AND THE PREVIEW USED TO SAY IT WAS.
 *
 * The old card ran every URL through `extractDomainName(hostname)`, so a citation
 * to `https://doi.org/10.1039/D0NP00027B` rendered as the word "doi" over the word
 * "doi.org". That tells a reader nothing: every DOI in the answer looked identical,
 * and the one string that actually identifies the paper — the DOI itself — was
 * never shown. Pulling it out is the difference between "some source" and "this
 * source".
 */
function doiFromUrl(url) {
  const match = /^https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/\S+)$/i.exec(
    String(url).trim(),
  );
  return match ? match[1] : null;
}

/**
 * Classify a citation URL into the three things a citation in this app can be.
 * `kind` drives the badge, the action row and the click routing.
 */
function describeSource(url) {
  if (typeof url === 'string' && url.startsWith('/library')) {
    return { kind: 'library', label: 'Library', doi: null, detail: url };
  }
  const doi = doiFromUrl(url);
  if (doi) return { kind: 'doi', label: 'DOI', doi, detail: doi };
  try {
    const hostname = new URL(url).hostname;
    return {
      kind: 'web',
      label: extractDomainName(hostname),
      doi: null,
      detail: hostname,
    };
  } catch {
    return { kind: 'web', label: 'Source', doi: null, detail: String(url) };
  }
}

/**
 * ONE CITATION: a Basecoat `.badge` chip and the `.popover` that previews it.
 *
 * WHAT WAS WRONG WITH THE OLD ONE
 *
 *  1. THE PREVIEW WAS HOVER-ONLY. `onmouseenter` / `onmouseleave` and nothing else —
 *     no focus handler, no Escape. A keyboard or screen-reader user could Tab to the
 *     citation and get NOTHING; the entire source preview was unreachable without a
 *     pointer. That is WCAG 1.4.13 (Content on Hover or Focus), which requires the
 *     content to appear on focus as well, to stay while the pointer is over it, and
 *     to be dismissible without moving focus. All three are implemented below.
 *  2. THE MARKER WAS NOT A TARGET. `background: none; border: none; padding: 0 2px`
 *     on an 11px superscript is a ~14px hit area with no visible affordance — a blue
 *     `[1]` that does not read as pressable. It is a `.badge` chip now, which is what
 *     Basecoat ships for an inline marker and which gives it a real box.
 *  3. THE CARD NESTED BUTTONS INSIDE AN ANCHOR. The whole preview was one `<a
 *     target="_blank">`, and the prev/next source buttons were INSIDE it. Interactive
 *     content inside an anchor is invalid HTML and the reason those two buttons each
 *     needed a `preventDefault()` + `stopPropagation()` to not navigate. The card is
 *     a plain container now; leaving for the source is one explicit action.
 *  4. IT DID NOT SAY WHAT THE SOURCE WAS. See `doiFromUrl`.
 *
 * WHAT IT DOES NOT DO, AND WHY: it does not show title / authors / year / journal.
 * That metadata does not exist on the client — `parseCitationsFromText` yields the
 * cited claim and a list of URLs, and nothing in the message payload carries
 * bibliographic fields. Showing them would need a resolver endpoint. What the card
 * can honestly answer is "which source is this, and what did it support", so it says
 * that, and labels the snippet as the CLAIM rather than implying it is an abstract.
 *
 * THE PROVENANCE CONTRACT IS UNCHANGED: plain click opens the inline
 * EvidenceLightbox for the fact, Ctrl/Cmd/Shift-click opens the dedicated
 * `/viewer/:sourceId` route in a new tab, and `data-provenance-trigger` /
 * `data-fact-id` are still on the chip.
 */
function Citation({ citation }) {
  const [isOpen, setIsOpen] = useState(false);
  const [sourceIndex, setSourceIndex] = useState(0);
  const wrapperRef = useRef(null);
  const chipRef = useRef(null);
  const closeTimer = useRef(null);

  const url = citation.urls[sourceIndex] || citation.urls[0];
  const source = describeSource(url);
  const factId = factIdFromUrl(citation.urls[0]);
  const cardId = `citation-preview-${citation.index}`;

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const open = () => {
    cancelClose();
    setIsOpen(true);
  };
  // The 200ms grace is what makes the card HOVERABLE: the pointer has to be able to
  // travel from the chip into the card without the card vanishing under it.
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setIsOpen(false), 200);
  };
  useEffect(() => cancelClose, []);

  const handleClick = (e) => {
    e.preventDefault();
    const isModifierClick =
      e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1;
    const first = citation.urls[0];
    if (factId) {
      if (isModifierClick) {
        openProvenanceInTab(factId, '', {});
        return;
      }
      openProvenanceLightbox(factId, null, chipRef.current);
      return;
    }
    if (first.startsWith('/')) {
      window.location.assign(first);
    } else {
      window.open(first, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    /* Basecoat's `.popover`. `[data-popover]` is Lyra's positioning primitive:
       `absolute z-50 w-max`, the side/align offsets, and the visibility + scale
       transition keyed off `aria-hidden`. It positions against the nearest
       `.popover` ancestor, which is this wrapper — so the ~25 lines of
       `getBoundingClientRect` math the old card used to place itself are GONE, and
       with them the bug where the coordinates were captured on mouseenter and never
       updated if the message reflowed underneath.

       `aria-hidden` (not conditional rendering) is what drives it, so `invisible`
       takes the closed card out of the tab order for free. */
    <span
      className="popover citation-popover"
      ref={wrapperRef}
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
      onFocusIn={open}
      onFocusOut={(e) => {
        // Only close when focus actually LEFT the citation — moving from the chip
        // into the card's "Open source" link must not dismiss it.
        if (!wrapperRef.current?.contains(e.relatedTarget)) setIsOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && isOpen) {
          // Dismissible without moving the pointer, and focus lands back on the chip
          // rather than nowhere.
          e.stopPropagation();
          setIsOpen(false);
          chipRef.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={chipRef}
        className="badge citation-button"
        data-variant="primary"
        aria-expanded={isOpen}
        aria-describedby={cardId}
        aria-haspopup={factId ? 'dialog' : undefined}
        data-provenance-trigger="true"
        data-fact-id={factId || undefined}
        title={
          `Source ${citation.index}: ${source.label}` +
          (citation.urls.length > 1 ? ` (+${citation.urls.length - 1} more)` : '')
        }
        onClick={handleClick}
      >
        {citation.index}
      </button>

      <div
        id={cardId}
        data-popover
        data-side="top"
        data-align="center"
        aria-hidden={!isOpen}
        className="citation-preview-card"
      >
        <div className="citation-preview-header">
          <span className="badge citation-preview-kind" data-variant="outline">
            {source.kind === 'library' ? (
              <Icon name="bookOpen" size={12} />
            ) : source.kind === 'doi' ? (
              <Icon name="file" size={12} />
            ) : (
              <Icon name="globe" size={12} />
            )}
            {source.label}
          </span>
          {citation.urls.length > 1 && (
            <span className="citation-nav-counter">
              {sourceIndex + 1} / {citation.urls.length}
            </span>
          )}
        </div>

        {/* The DOI in the mono face, because it is an IDENTIFIER, not prose. */}
        <p className="citation-preview-detail">{source.detail}</p>

        {citation.text && (
          <>
            <p className="citation-preview-label">Cited claim</p>
            <p className="citation-preview-text">{citation.text}</p>
          </>
        )}

        <div className="citation-preview-actions">
          {citation.urls.length > 1 && (
            <div className="citation-navigation">
              <button
                type="button"
                className="btn citation-nav-button"
                data-variant="ghost"
                data-size="icon-xs"
                onClick={() => setSourceIndex((i) => Math.max(0, i - 1))}
                disabled={sourceIndex === 0}
                aria-label="Previous source"
              >
                <Icon name="chevronLeft" size={12} />
              </button>
              <button
                type="button"
                className="btn citation-nav-button"
                data-variant="ghost"
                data-size="icon-xs"
                onClick={() =>
                  setSourceIndex((i) =>
                    Math.min(citation.urls.length - 1, i + 1),
                  )
                }
                disabled={sourceIndex === citation.urls.length - 1}
                aria-label="Next source"
              >
                <Icon name="chevronRight" size={12} />
              </button>
            </div>
          )}

          {/* ONE explicit way out, instead of the whole card being a link. An
              in-app library URL is in-app navigation and must NOT open a tab; an
              http(s) source leaves the app and must, with `noopener` (without it
              the opened page gets a handle on this window) and a visible icon
              saying so. */}
          {url.startsWith('/') ? (
            <a className="btn citation-preview-open" data-variant="outline" data-size="xs" href={url}>
              Open in library
            </a>
          ) : (
            <a
              className="btn citation-preview-open"
              data-variant="outline"
              data-size="xs"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open source ${citation.index} in a new tab`}
            >
              Open source
              <Icon name="externalLink" size={12} />
            </a>
          )}
        </div>
      </div>
    </span>
  );
}

/**
 * Component that renders text with inline citations.
 * Citations format: [text]{url1,url2}
 * Renders as: text[1] with a Basecoat chip and a popover preview.
 */
export function InlineCitationText({ content }) {
  const contentRef = useRef(null);

  const { citations } = useMemo(() => parseCitationsFromText(content), [content]);

  const contentWithAnchors = useMemo(() => {
    if (citations.length === 0) {
      // Use the parsed content, which removes all [text]{} patterns.
      const { textWithoutCitations } = parseCitationsFromText(content);
      return textWithoutCitations;
    }

    let processedContent = content;

    // Replace citation patterns: [text]{urls} -> text<anchor>
    citations.forEach((citation) => {
      const anchor = `<span data-citation-anchor="${citation.index}"></span>`;
      processedContent = processedContent.replace(
        citation.originalMatch,
        `${citation.text}${anchor}`,
      );
    });

    // Remove any remaining [text]{} patterns that were not citations (empty URLs).
    processedContent = processedContent.replace(
      /\[([^\]]*)\]\{([^\}]*)\}/g,
      '$1',
    );

    return processedContent;
  }, [citations, content]);

  /**
   * Mount a real Preact subtree into each anchor the markdown pass left behind.
   *
   * The markdown is an HTML STRING, so there is no JSX seam inside it — the same
   * constraint `renderMarkdown` works around for tables. What changed is HOW we fill
   * the seam: the old code hand-built a `<button>` with `document.createElement`,
   * assigned `.className`, `.onclick`, `.onmouseenter` and `.onmouseleave` by hand,
   * and kept the hover card's state in the PARENT — one `hoveredCitation` for the
   * whole message, plus a measured x/y. `render()` puts a component in the seam
   * instead, so every citation owns its own open state and Basecoat's popover owns
   * its own position.
   *
   * `render(null, anchor)` on cleanup unmounts the subtree properly (the effects
   * inside it, including the close timer, get to run their teardown).
   */
  useEffect(() => {
    if (!contentRef.current || citations.length === 0) return;
    const anchors = [];

    citations.forEach((citation) => {
      const anchor = contentRef.current.querySelector(
        `[data-citation-anchor="${citation.index}"]`,
      );
      if (!anchor) return;
      anchor.classList.add('citation-button-wrapper');
      anchors.push(anchor);
      render(<Citation citation={citation} />, anchor);
    });

    return () => {
      anchors.forEach((anchor) => render(null, anchor));
    };
  }, [citations, contentWithAnchors]);

  // No citations: render the cleaned content and nothing else.
  if (citations.length === 0) {
    const { textWithoutCitations } = parseCitationsFromText(content);
    return (
      <div
        className="message-content"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(textWithoutCitations) }}
      />
    );
  }

  return (
    <div className="message-content-with-citations">
      <div
        ref={contentRef}
        className="message-content"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(contentWithAnchors) }}
      />
    </div>
  );
}
