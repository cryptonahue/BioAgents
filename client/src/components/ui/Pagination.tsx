import { Icon } from "../icons";
import { BUTTON_ICON_CLASS } from "./Button";

/**
 * PAGINATION — BUILT FROM PRIMITIVES, BECAUSE BASECOAT DOES NOT SHIP ONE.
 *
 * Lyra's component list is: accordion alert avatar badge breadcrumb button
 * button-group card chart checkbox collapsible combobox command dialog drawer
 * dropdown-menu empty field form input input-group item kbd label native-select
 * popover progress radio range scrollbar select sidebar skeleton switch table
 * tabs textarea toast tooltip. There is no `.pagination`.
 *
 * So this is `.button-group` + `.btn`, which IS the Basecoat way: the group is
 * `isolate inline-flex items-stretch` and collapses the shared borders itself
 * (`> *:not(:first-child) { border-s-0 }`), and it raises the focused child to
 * `z-10` so the focus ring is never clipped by its neighbour. Nothing is
 * reinvented; nothing new is styled.
 *
 * NO BASECOAT JS (there is none for this anyway) and NO HOOKS — the component
 * is invokable as a plain function, like `ui/Tabs.tsx` and `ui/Menu.tsx`, so it
 * can be unit-tested by walking the returned vnode tree.
 *
 * ARIA is Preact's: a labelled `<nav>`, `aria-current="page"` on the current
 * page (the property assistive tech reads to say "you are here"), and a real
 * `aria-label` on every numbered button, because "3" alone is not a name.
 */

/**
 * The visible page numbers for `current` out of `totalPages`, always exactly
 * `max` entries when there are that many pages — so the control does not
 * change width as you walk through it. `0` is a gap ("…").
 *
 * The window slides: it clamps to the start near page 1, to the end near the
 * last page, and otherwise centres on the current page. First and last are
 * always reachable in one click.
 */
export function pageWindow(
  current: number,
  totalPages: number,
  max = 7,
): number[] {
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);

  if (totalPages <= max) return range(1, totalPages);

  // Near the START: one gap, so `max - 2` real pages lead, then "… last".
  //   max=7, 20 pages, current<=4 -> [1,2,3,4,5, …, 20]
  const headEnd = max - 2;
  if (current <= headEnd - 1) return [...range(1, headEnd), 0, totalPages];

  // Near the END: mirror image — "first …", then the last `max - 2` pages.
  //   max=7, 20 pages, current>=17 -> [1, …, 16,17,18,19,20]
  const tailStart = totalPages - (max - 3);
  if (current >= tailStart + 1) return [1, 0, ...range(tailStart, totalPages)];

  // In the MIDDLE: two gaps, and `max - 4` pages centred on the current one.
  //   max=7, 20 pages, current=10 -> [1, …, 9,10,11, …, 20]
  const inner = max - 4;
  const half = Math.floor((inner - 1) / 2);
  return [
    1,
    0,
    ...range(current - half, current - half + inner - 1),
    0,
    totalPages,
  ];
}

export interface PaginationProps {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
  /** Names the control for assistive tech, e.g. "Library pages". */
  label: string;
  className?: string;
}

export function Pagination({
  page,
  totalPages,
  onPage,
  label,
  className,
}: PaginationProps) {
  if (totalPages <= 1) return null;

  const pages = pageWindow(page, totalPages);

  return (
    <nav
      className={className ? `pagination ${className}` : "pagination"}
      aria-label={label}
    >
      <div className="button-group">
        <button
          type="button"
          className="btn"
          data-variant="outline"
          data-size="sm"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
        >
          <Icon name="chevronLeft" size={15} className={BUTTON_ICON_CLASS} />
          <span>Previous</span>
        </button>

        {pages.map((n, i) =>
          n === 0 ? (
            // A gap is not a control: it is not focusable and is hidden from
            // the accessibility tree, which reads the page numbers around it.
            <span
              key={`gap-${i}`}
              className="pagination-gap"
              aria-hidden="true"
            >
              …
            </span>
          ) : (
            <button
              key={n}
              type="button"
              className="btn pagination-page"
              data-variant="outline"
              data-size="sm"
              data-tone={n === page ? "brand" : undefined}
              aria-current={n === page ? "page" : undefined}
              aria-label={`Page ${n} of ${totalPages}`}
              onClick={() => onPage(n)}
            >
              {n}
            </button>
          ),
        )}

        <button
          type="button"
          className="btn"
          data-variant="outline"
          data-size="sm"
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages}
          aria-label="Next page"
        >
          <span>Next</span>
          <Icon name="chevronRight" size={15} className={BUTTON_ICON_CLASS} />
        </button>
      </div>
    </nav>
  );
}
