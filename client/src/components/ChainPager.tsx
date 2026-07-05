/**
 * `ChainPager` — "Part X of N" badge + prev/next navigation for
 * multi-page table chains. PR #2 of
 * `bioprospecting-multipage-table-merge`.
 *
 * Used inside the `EvidenceLightbox` header when the current fact's
 * provenance points to a table that is part of a multi-page chain.
 *
 * UX contract (design §"Auto-scroll opt-in via badge button, default
 * OFF"):
 *   - Always shows the "Part X of N" badge so the user knows the
 *     chain exists.
 *   - Prev/Next buttons navigate to the adjacent chain fragment.
 *   - A "Follow" toggle controls whether prev/next also auto-scrolls
 *     the PDF viewer to the fragment's page. Default is OFF. When
 *     OFF, the badge updates but the user keeps their current page.
 *   - The pager is hidden when the chain has fewer than 2 fragments
 *     (a single-page table needs no pager).
 */
import { useState } from "preact/hooks";

import { useTableChain, type TableChainFragment } from "../hooks/useTableChain";
import type { SourceEvidenceTable } from "../hooks/useSourceEvidence";

interface ChainPagerProps {
  /** All tables for the source (the cached `evidence.tables`). */
  tables: SourceEvidenceTable[] | null | undefined;
  /** The id of the table the current fact points to. */
  currentTableId: string | null | undefined;
  /** Called when the user clicks prev/next AND `Follow` is ON.
   * The pager does not own the PDF viewer; it just asks the
   * parent to scroll to the fragment's page. */
  onNavigatePage?: (page: number) => void;
}

export function ChainPager({
  tables,
  currentTableId,
  onNavigatePage,
}: ChainPagerProps) {
  const chain = useTableChain(tables, currentTableId);
  const [follow, setFollow] = useState(false);

  if (!chain || chain.length < 2) return null;

  const currentIndex = chain.findIndex((f) => f.id === currentTableId);
  if (currentIndex < 0) return null;
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === chain.length - 1;
  const prev = isFirst ? null : chain[currentIndex - 1];
  const next = isLast ? null : chain[currentIndex + 1];

  const goTo = (fragment: TableChainFragment) => {
    if (follow && onNavigatePage) onNavigatePage(fragment.page);
  };

  return (
    <div
      className="chain-pager"
      role="group"
      aria-label="Multi-page table chain navigation"
    >
      <span
        className="chain-pager__badge"
        data-testid="chain-pager-badge"
      >
        Part {currentIndex + 1} of {chain.length}
      </span>
      <button
        type="button"
        className="chain-pager__btn"
        onClick={() => prev && goTo(prev)}
        disabled={!prev}
        aria-label="Previous chain fragment"
      >
        ‹ Prev
      </button>
      <button
        type="button"
        className="chain-pager__btn"
        onClick={() => next && goTo(next)}
        disabled={!next}
        aria-label="Next chain fragment"
      >
        Next ›
      </button>
      <button
        type="button"
        className={`chain-pager__follow ${follow ? "is-on" : ""}`}
        onClick={() => setFollow((f) => !f)}
        aria-pressed={follow}
        title={
          follow
            ? "Auto-scroll to next fragment is ON"
            : "Auto-scroll to next fragment is OFF (default)"
        }
        data-testid="chain-pager-follow"
      >
        Follow: {follow ? "ON" : "OFF"}
      </button>
    </div>
  );
}
