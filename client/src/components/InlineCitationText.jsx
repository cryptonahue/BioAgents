import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { parseCitationsFromText, extractDomainName } from '../utils/parseCitations';
import { openProvenanceLightbox, openProvenanceInTab } from '../utils/provenanceTrigger';

/**
 * Component that renders text with inline citations
 * Citations format: [text]{url1,url2}
 * Renders as: text[1] with hover preview
 */
export function InlineCitationText({ content }) {
  const [hoveredCitation, setHoveredCitation] = useState(null);
  const [hoverPosition, setHoverPosition] = useState(null);
  const [currentSourceIndex, setCurrentSourceIndex] = useState(0);
  const contentRef = useRef(null);
  const hoverTimeoutRef = useRef(null);

  const { citations } = useMemo(() =>
    parseCitationsFromText(content),
    [content]
  );

  const contentWithAnchors = useMemo(() => {
    if (citations.length === 0) {
      // Use the parsed content which removes all [text]{} patterns
      const { textWithoutCitations } = parseCitationsFromText(content);
      return textWithoutCitations;
    }

    let processedContent = content;

    // Replace citation patterns: [text]{urls} -> text<anchor>
    // This also handles [text]{} -> text (no anchor, just text)
    citations.forEach((citation) => {
      const anchor = `<span data-citation-anchor="${citation.index}"></span>`;
      processedContent = processedContent.replace(
        citation.originalMatch,
        `${citation.text}${anchor}`,
      );
    });

    // Now remove any remaining [text]{} patterns that weren't in citations (empty URLs)
    // Use the same regex to clean up
    processedContent = processedContent.replace(/\[([^\]]*)\]\{([^\}]*)\}/g, '$1');

    return processedContent;
  }, [citations, content]);

  /**
   * Extract a fact id from a citation URL. The chat agent emits
   * citation URLs as `/library/<docId>?fact=<factId>` when the
   * answer is anchored to a specific bioprospecting fact. The
   * lightbox and the dedicated viewer both key on `factId`, so
   * we surface it via `data-fact-id` and the helper functions.
   *
   * Returns `null` for non-fact URLs (e.g., a DOI link or a
   * library link without a fact anchor). The button is still
   * annotated as a provenance trigger so screen readers
   * announce the affordance consistently, but the click handler
   * falls back to the legacy open-in-new-tab behavior.
   */
  const factIdFromUrl = (url) => {
    if (!url || typeof url !== 'string') return null;
    try {
      // Tolerate absolute and relative URLs.
      const isAbsolute = /^https?:\/\//i.test(url);
      const parsed = isAbsolute
        ? new URL(url)
        : new URL(url, 'http://placeholder.local');
      // /library/<docId>?fact=<factId>
      if (parsed.pathname.startsWith('/library/') || parsed.pathname.startsWith('/library')) {
        const fact = parsed.searchParams.get('fact');
        if (fact && /^[A-Za-z0-9-]{6,}$/.test(fact)) return fact;
      }
      // /viewer/<sourceId>?fact=<factId>
      if (parsed.pathname.startsWith('/viewer/')) {
        const fact = parsed.searchParams.get('fact');
        if (fact && /^[A-Za-z0-9-]{6,}$/.test(fact)) return fact;
      }
    } catch {
      // Fall through: not a parseable URL.
    }
    // Direct fact id (UUID-shaped) — the chat agent may emit a
    // raw fact id as the URL. Match common UUID shape and trust
    // it; the lightbox will 404 cleanly if the id is bad.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url)) {
      return url;
    }
    return null;
  };

  // If no citations found, render normally with cleaned content
  if (citations.length === 0) {
    const { textWithoutCitations } = parseCitationsFromText(content);
    const rawHtml = marked(textWithoutCitations);
    const sanitizedHtml = DOMPurify.sanitize(rawHtml);
    return (
      <div
        className="message-content"
        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      />
    );
  }

  const handleCitationHover = (citation, e) => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const contentContainer = contentRef.current?.getBoundingClientRect();

    if (!contentContainer) return;

    // Calculate position relative to content container
    // This keeps the hover card within the message content width
    const position = {
      x: rect.left - contentContainer.left + rect.width / 2,  // Relative to content container
      y: rect.top - contentContainer.top - 10,                // 10px above button, relative to container
    };

    setHoverPosition(position);
    setHoveredCitation(citation);
    setCurrentSourceIndex(0); // Reset to first source when hovering new citation
  };

  const handlePrevSource = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (currentSourceIndex > 0) {
      setCurrentSourceIndex(prev => prev - 1);
    }
  };

  const handleNextSource = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (hoveredCitation && currentSourceIndex < hoveredCitation.urls.length - 1) {
      setCurrentSourceIndex(prev => prev + 1);
    }
  };

  const handleCitationLeave = () => {
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredCitation(null);
      setHoverPosition(null);
    }, 200);
  };

  const handleCitationClick = (citation, e) => {
    e.preventDefault();
    // Provenance-aware routing per the PR #3 spec:
    //   - Plain click          → open lightbox for the fact id
    //                            (default affordance for fact
    //                            citations on the evidence pack /
    //                            library pages)
    //   - Ctrl / Cmd / Shift   → open the dedicated /viewer route
    //                            in a new tab (per spec: "Modifier
    //                            -click opens the dedicated
    //                            route")
    //   - URLs without a fact  → preserve the legacy behavior
    //                            (route to the library page, or
    //                            open the external URL in a new
    //                            tab) so chat messages without
    //                            fact anchors keep working.
    const isModifierClick =
      e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1;

    if (citation.urls.length === 1) {
      const url = citation.urls[0];
      const factId = factIdFromUrl(url);
      if (factId) {
        if (isModifierClick) {
          openProvenanceInTab(factId, '', {});
          return;
        }
        openProvenanceLightbox(factId, null, e.currentTarget);
        return;
      }
      if (url.startsWith('/')) {
        window.location.assign(url);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      return;
    }
    if (citation.urls.length > 1) {
      citation.urls.forEach(url => {
        if (url.startsWith('/')) {
          window.location.assign(url);
        } else {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
      });
    }
  };

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  // After markdown rendering, inject citation buttons inline
  useEffect(() => {
    if (!contentRef.current || citations.length === 0) return;

    citations.forEach((citation) => {
      const anchor = contentRef.current.querySelector(`[data-citation-anchor="${citation.index}"]`);
      if (!anchor) return;

      anchor.classList.add('citation-button-wrapper');
      anchor.innerHTML = '';

      const button = document.createElement('button');
      button.className = 'citation-button';
      button.textContent = `[${citation.index}]`;

      const firstUrl = citation.urls[0];
      let domainName = String(citation.index);
      if (firstUrl.startsWith('/library/')) {
        domainName = 'Library';
      } else {
        try {
          domainName = extractDomainName(new URL(firstUrl).hostname);
        } catch {
          // Use index if URL parsing fails
        }
      }

      button.title = `View source: ${domainName}${citation.urls.length > 1 ? ` (+${citation.urls.length - 1})` : ''}`;

      // PR #3 provenance wiring: surface the trigger attributes
      // so the global ProvenanceProvider can identify the
      // element and restore focus on close. `data-fact-id` is
      // only set when the URL carries a fact reference; the
      // lightbox click handler falls back to the legacy
      // open-in-new-tab behavior for URLs without one.
      button.setAttribute('role', 'button');
      button.setAttribute('data-provenance-trigger', 'true');
      const factId = factIdFromUrl(firstUrl);
      if (factId) {
        button.setAttribute('data-fact-id', factId);
        // The button is a real <button> (role is implicit), but
        // aria-pressed signals to assistive tech that the click
        // toggles the lightbox (open ↔ close). The provider
        // manages the actual open state; the attribute is a
        // hint, not a source of truth.
        button.setAttribute('aria-haspopup', 'dialog');
      }

      button.onclick = (e) => handleCitationClick(citation, e);
      button.onmouseenter = (e) => handleCitationHover(citation, e);
      button.onmouseleave = handleCitationLeave;
      // Enter / Space activation: keep this in addition to the
      // native <button> activation so the keyboard flow is
      // consistent even if the button is later swapped for a
      // span in some skin. The native <button> already fires
      // click on Enter/Space; the extra handler is defensive
      // and stops the event from bubbling to the markdown
      // container.
      button.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          // Native activation will dispatch the click; we just
          // need to make sure the modifier-aware branch in
          // handleCitationClick sees the event.
          if (e.ctrlKey || e.metaKey || e.shiftKey) {
            e.preventDefault();
            handleCitationClick(citation, e);
          }
        }
      };

      anchor.appendChild(button);
    });
  }, [citations, contentWithAnchors]);


  // Render markdown with citations removed, then inject buttons via DOM manipulation
  const rawHtml = marked(contentWithAnchors);
  const sanitizedHtml = DOMPurify.sanitize(rawHtml);

  return (
    <div className="message-content-with-citations">
      {/* Render content - citations will be injected as buttons */}
      <div
        ref={contentRef}
        className="message-content"
        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      />

      {/* Hover preview card - positioned above button */}
      {hoveredCitation && hoverPosition && (
        <div
          className="citation-hover-preview"
          style={{
            left: `${hoverPosition.x}px`,
            top: `${hoverPosition.y}px`,
          }}
          onMouseEnter={() => {
            if (hoverTimeoutRef.current) {
              clearTimeout(hoverTimeoutRef.current);
            }
          }}
          onMouseLeave={handleCitationLeave}
        >
          <a
            href={hoveredCitation.urls[currentSourceIndex]}
            target="_blank"
            rel="noopener noreferrer"
            className="citation-preview-card"
          >
            <div className="citation-preview-header">
              <div className="citation-preview-icon">
                {(() => {
                  try {
                    const currentUrl = hoveredCitation.urls[currentSourceIndex];
                    if (currentUrl.startsWith('/library/')) return 'B';
                    const hostname = new URL(currentUrl).hostname;
                    const domainName = extractDomainName(hostname);
                    return domainName.charAt(0).toUpperCase();
                  } catch {
                    return hoveredCitation.index;
                  }
                })()}
              </div>
              <div className="citation-preview-title">
                <p className="citation-preview-domain">
                  {(() => {
                    try {
                      const currentUrl = hoveredCitation.urls[currentSourceIndex];
                      if (currentUrl.startsWith('/library/')) return 'Library';
                      const hostname = new URL(currentUrl).hostname;
                      return extractDomainName(hostname);
                    } catch {
                      return 'Source';
                    }
                  })()}
                </p>
                <p className="citation-preview-url">
                  {(() => {
                    try {
                      const currentUrl = hoveredCitation.urls[currentSourceIndex];
                      if (currentUrl.startsWith('/library/')) return currentUrl;
                      return new URL(currentUrl).hostname;
                    } catch {
                      return hoveredCitation.urls[currentSourceIndex];
                    }
                  })()}
                </p>
              </div>
            </div>

            {hoveredCitation.text && (
              <p className="citation-preview-text">
                {hoveredCitation.text}
              </p>
            )}

            {hoveredCitation.urls.length > 1 && (
              <div className="citation-navigation">
                <button
                  className="citation-nav-button"
                  onClick={handlePrevSource}
                  disabled={currentSourceIndex === 0}
                  aria-label="Previous source"
                >
                  ←
                </button>
                <span className="citation-nav-counter">
                  {currentSourceIndex + 1} / {hoveredCitation.urls.length}
                </span>
                <button
                  className="citation-nav-button"
                  onClick={handleNextSource}
                  disabled={currentSourceIndex === hoveredCitation.urls.length - 1}
                  aria-label="Next source"
                >
                  →
                </button>
              </div>
            )}
          </a>
        </div>
      )}
    </div>
  );
}
