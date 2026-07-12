import { useEffect, useRef, useState } from "preact/hooks";
import { route } from "preact-router";
import { useLibraryFacets, useLibraryList } from "../hooks";
import type {
  LibraryFacetValue,
  LibraryPaper,
  LibraryQuery,
} from "../hooks/useLibrary";
import {
  LIBRARY_DEFAULT_QUERY,
  activeFilterCount,
  deleteLibraryPaper,
  fetchPaperAbstract,
} from "../hooks/useLibrary";
import { ExternalLink } from "../utils/externalLinks";
import { Icon } from "../components/icons";
import { BUTTON_ICON_CLASS } from "../components/ui/Button";
import { Pagination } from "../components/ui/Pagination";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { uploadResearchBrainSource } from "../hooks/useResearchBrain";

interface LibraryPageProps {
  path?: string;
  coralGptMode?: boolean;
}

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/**
 * Derive a human-readable display title from the paper filename. Prefers a
 * real structured title when the server resolved one from
 * research_sources.metadata; otherwise strips the trailing
 * `_YEAR_Publisher-…` metadata segment and the extension, then turns
 * separators into spaces. Best-effort — never throws, falls back to the raw
 * filename.
 *
 * The server computes the same thing (`library_display_title()` in SQL) and
 * SORTS and SEARCHES on it. This stays because the client is the only side that
 * knows to prefer `metaTitle`, and because the raw title is what the row
 * renders when neither is usable.
 */
function displayTitle(paper: LibraryPaper): string {
  if (paper.metaTitle && paper.metaTitle.trim().length > 3) {
    return paper.metaTitle.trim();
  }
  const raw = paper.title || "";
  let s = raw.replace(/\.[a-z0-9]+$/i, "");
  // Drop a trailing metadata tail that starts at a 4-digit year.
  s = s.replace(/[_\-\s]((?:19|20)\d{2})[_\-\s].*$/, "");
  s = s
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || raw;
}

/** Sub-line combining year and publisher, e.g. "2018 · Springer". */
function subline(paper: LibraryPaper): string {
  const parts: string[] = [];
  if (paper.year != null) parts.push(String(paper.year));
  if (paper.publisher) parts.push(paper.publisher);
  return parts.join(" · ");
}

function trustLabel(tier?: string): string {
  if (!tier) return "";
  return tier.replace(/[_-]+/g, " ");
}

/**
 * The trust tier is a SEMANTIC badge color: the two vetted tiers earn the
 * success tone, everything else stays neutral. Basecoat has no `success`
 * variant, so this maps onto the project `data-tone` — see `badges.css`.
 */
function trustTone(tier?: string): "success" | "neutral" {
  return tier === "foundational" || tier === "curated" ? "success" : "neutral";
}

/**
 * Small, subtle destructive action shared by the card and the row. Confirms
 * before deleting, then removes the paper and its evidence server-side and asks
 * the parent to refresh the list on success. Errors are surfaced through the
 * page-level `onError` affordance. The click is stopped from bubbling so it
 * never triggers the card/row navigation.
 */
function DeletePaperButton({
  paper,
  onDeleted,
  onError,
}: {
  paper: LibraryPaper;
  onDeleted: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const title = displayTitle(paper);

  const doDelete = async () => {
    if (busy) return;
    setBusy(true);
    onError("");
    try {
      await deleteLibraryPaper(paper.docId);
      setConfirmOpen(false);
      onDeleted();
    } catch (err: any) {
      onError(err?.message || "Could not delete the paper");
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="btn paper-action-delete"
        data-variant="outline"
        data-size="icon"
        onClick={(e) => {
          e.stopPropagation();
          setConfirmOpen(true);
        }}
        title={`Delete "${title}"`}
        aria-label={`Delete ${title}`}
      >
        <Icon name="trash" size={15} className={BUTTON_ICON_CLASS} />
      </button>
      <ConfirmDialog
        open={confirmOpen}
        title="Delete paper"
        message={`"${title}" and all its evidence will be permanently removed. This can't be undone.`}
        confirmLabel="Delete"
        busy={busy}
        onConfirm={doDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

/**
 * THE EVIDENCE CHIP — the one signal no other field carries.
 *
 * It answers the only question that decides whether a paper is worth opening:
 * can the agent actually CITE this, or did it ingest and produce nothing? A
 * paper with zero claims is in the library but invisible to the system, and
 * before this there was no way to see that at a glance.
 *
 * A zero is a STATE, NOT A FAILURE, and the styling says so: `.paper-evidence`
 * is accent-tinted when there is evidence and drops to a muted, unemphasised
 * surface when there is none (see `library.css`). It is not red, not a warning,
 * and it carries no icon of alarm — it simply stops advertising.
 *
 * The field is OMITTED by the API when the count could not be computed, which
 * is why this renders nothing at all in that case rather than a misleading "0".
 */
function EvidenceChip({ count }: { count?: number }) {
  if (typeof count !== "number") return null;
  const empty = count === 0;
  return (
    <span
      className={`paper-evidence${empty ? " paper-evidence--empty" : ""}`}
      title={
        empty
          ? "No claims extracted yet — the agent cannot cite this paper"
          : `${count} claim${count === 1 ? "" : "s"} the agent can cite`
      }
    >
      <Icon name="microscope" size={12} />
      {empty ? "No evidence yet" : `${count} evidence`}
    </span>
  );
}

/** Taxa and geography chips, capped so a fact-rich paper cannot flood the row. */
function DomainChips({
  paper,
  max = 2,
}: {
  paper: LibraryPaper;
  max?: number;
}) {
  const taxa = paper.taxa || [];
  const geography = paper.geography || [];
  if (!taxa.length && !geography.length) return null;

  const hiddenTaxa = Math.max(0, taxa.length - max);
  const hiddenGeo = Math.max(0, geography.length - max);

  return (
    <>
      {taxa.slice(0, max).map((t) => (
        <span
          key={`t-${t}`}
          className="badge paper-chip--taxon"
          data-tone="brand"
          title={`Organism: ${t}`}
        >
          {t}
        </span>
      ))}
      {hiddenTaxa > 0 && (
        <span
          className="badge"
          data-tone="brand"
          title={taxa.slice(max).join(", ")}
        >
          +{hiddenTaxa}
        </span>
      )}
      {geography.slice(0, max).map((g) => (
        <span
          key={`g-${g}`}
          className="badge"
          data-tone="info"
          title={`Region: ${g}`}
        >
          <Icon name="mapPin" size={11} />
          {g}
        </span>
      ))}
      {hiddenGeo > 0 && (
        <span
          className="badge"
          data-tone="info"
          title={geography.slice(max).join(", ")}
        >
          +{hiddenGeo}
        </span>
      )}
    </>
  );
}

/**
 * THE ROW. Read left to right, it is the researcher's scan path:
 *
 *   1. TITLE — the anchor. It is the largest thing on the row and it starts at
 *      the row's left edge, because it is the only field that identifies the
 *      paper. The repeated book icon that used to hold this position is GONE:
 *      an identical icon on every row of a list of papers carries zero
 *      information and stole the anchor from the one field that does.
 *   2. YEAR · PUBLISHER · TYPE · FRAGMENTS · SIZE · DOI — the provenance line.
 *      Muted, small, one line, under the title. It answers "how old, from
 *      whom", which matters only once the title has caught the eye.
 *   3. THE SIGNAL RAIL, right-aligned — evidence first, then facts, trust,
 *      organism, region. This is the "can I use this?" column: the eye lands on
 *      the title, then flicks right to decide. Evidence leads it because it is
 *      the only field that says whether the agent can cite the paper at all.
 *   4. ACTIONS — Chat, Evidence, Delete.
 *
 * The frame is Lyra's `.item[data-variant="outline"]`. `> section` is
 * `flex-1 flex-col` and `> section + section` is `flex-none`, which is exactly
 * the main-column / fixed-rail split this needs — no custom flex is declared.
 */
function PaperRow({
  paper,
  onDeleted,
  onError,
}: {
  paper: LibraryPaper;
  onDeleted: () => void;
  onError: (msg: string) => void;
}) {
  const title = displayTitle(paper);
  const sub = subline(paper);

  return (
    <div className="item paper-row" data-variant="outline">
      <section className="paper-row-main">
        <h3 className="paper-row-title" title={title}>
          {title}
        </h3>
        <div className="paper-row-meta">
          {sub && <span>{sub}</span>}
          {paper.type && (
            <span className="paper-tag-plain">{paper.type.toUpperCase()}</span>
          )}
          {paper.chunkCount != null && <span>{paper.chunkCount} fragments</span>}
          {paper.size ? (
            <span title={`${paper.size} bytes`}>{formatSize(paper.size)}</span>
          ) : null}
          {paper.doiUrl && (
            <ExternalLink
              className="paper-doi-link"
              href={paper.doiUrl}
              label={`DOI for ${title}`}
              onClick={(e) => e.stopPropagation()}
            >
              DOI
            </ExternalLink>
          )}
        </div>
      </section>

      <section className="paper-row-signals">
        <EvidenceChip count={paper.evidenceCount} />
        {typeof paper.bioprospectingFactCount === "number" &&
          paper.bioprospectingFactCount > 0 && (
            <span
              className="badge"
              data-tone="violet"
              title={`${paper.bioprospectingFactCount} bioprospecting facts`}
            >
              {paper.bioprospectingFactCount} facts
            </span>
          )}
        {paper.trustTier && (
          <span
            className="badge paper-trust"
            data-tone={trustTone(paper.trustTier)}
            title={`Trust tier: ${trustLabel(paper.trustTier)}`}
          >
            {trustLabel(paper.trustTier)}
          </span>
        )}
        <DomainChips paper={paper} />
      </section>

      <aside className="paper-row-actions">
        <button
          className="btn paper-action"
          data-variant="primary"
          data-size="sm"
          onClick={() => route(`/library/${paper.docId}`)}
          title="Chat with paper"
        >
          <Icon name="messageSquare" size={15} className={BUTTON_ICON_CLASS} />
          <span>Chat</span>
        </button>
        <button
          className="btn paper-action"
          data-variant="outline"
          data-size="sm"
          aria-label={`View evidence for ${title}`}
          onClick={() => route(`/library/${paper.docId}/viewer`)}
        >
          <Icon name="microscope" size={15} className={BUTTON_ICON_CLASS} />
          <span>Evidence</span>
        </button>
        <DeletePaperButton
          paper={paper}
          onDeleted={onDeleted}
          onError={onError}
        />
      </aside>
    </div>
  );
}

/**
 * ONE FILTER CONTROL — a NATIVE select, deliberately.
 *
 * Basecoat ships two selects. Every rule in `select.css` is scoped
 * `.select:not(select)` — that is the JS listbox, and `select.js` rewrites its
 * `innerHTML`, which is unusable in a tree Preact owns. `native-select.css` is
 * `select.select` on a real `<select>` and needs no JS at all.
 *
 * Nothing else in the pack fits. `.combobox` and `.command` would look the part
 * but both are JS components whose keyboard model would have to be rebuilt in
 * Preact before either could honestly claim its ARIA role, and a `.checkbox` or
 * `.switch` per value does not survive a taxa vocabulary of a hundred organisms.
 * A native `<select>` gets type-ahead, the platform picker on touch, and the
 * full a11y contract for free — and it follows the theme, because `theme.css`
 * declares `color-scheme` (that, not a background rule, is what themes an
 * `<option>`).
 *
 * The label is a real `<label>` wrapping the control, so the hit target and the
 * accessible name come together.
 */
function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: LibraryFacetValue[];
  allLabel: string;
}) {
  return (
    <label className="library-filter">
      <span>{label}</span>
      <select
        className="select"
        value={value}
        onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
      >
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {String(option.value)} ({option.count})
          </option>
        ))}
      </select>
    </label>
  );
}

/** The six orderings, flattened into one control (sort key + direction). */
const SORT_OPTIONS: Array<{
  id: string;
  label: string;
  sort: LibraryQuery["sort"];
  dir: LibraryQuery["dir"];
}> = [
  { id: "year:desc", label: "Newest first", sort: "year", dir: "desc" },
  { id: "year:asc", label: "Oldest first", sort: "year", dir: "asc" },
  {
    id: "evidence:desc",
    label: "Most evidence",
    sort: "evidence",
    dir: "desc",
  },
  {
    id: "evidence:asc",
    label: "Least evidence",
    sort: "evidence",
    dir: "asc",
  },
  { id: "title:asc", label: "Title A–Z", sort: "title", dir: "asc" },
  { id: "title:desc", label: "Title Z–A", sort: "title", dir: "desc" },
];

/** Loading placeholder. Lyra's `.skeleton` is `animate-pulse` and NOTHING else
 *  — no box, no fill — so `library.css` supplies both. Rows, not a spinner: the
 *  list keeps its shape while it loads and nothing jumps when it arrives. */
function PaperRowSkeleton() {
  return (
    <div className="item paper-row paper-row--skeleton" aria-hidden="true">
      <section className="paper-row-main">
        <div className="skeleton skeleton-line skeleton-line--title" />
        <div className="skeleton skeleton-line skeleton-line--meta" />
      </section>
      <section className="paper-row-signals">
        <div className="skeleton skeleton-chip" />
        <div className="skeleton skeleton-chip" />
      </section>
    </div>
  );
}

type LibraryView = "list" | "grid";
const LIBRARY_VIEW_KEY = "library_view_mode";
function getInitialView(): LibraryView {
  try {
    const v = localStorage.getItem(LIBRARY_VIEW_KEY);
    if (v === "grid" || v === "list") return v;
  } catch {
    // localStorage unavailable — fall through to default
  }
  return "list";
}

export function LibraryPage({ coralGptMode = false }: LibraryPageProps) {
  const [query, setQuery] = useState<LibraryQuery>(LIBRARY_DEFAULT_QUERY);

  // The search box is UNCONTROLLED BY THE QUERY: it updates on every keystroke,
  // while `query.q` — the thing that hits the server — trails it by a debounce.
  // Binding the input straight to `query.q` would fire a request per character.
  const [searchInput, setSearchInput] = useState("");
  const debounceRef = useRef<any>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      // A new search is a new result set: go back to page 1, or you land on
      // page 7 of a 2-page result and see nothing.
      setQuery((q) =>
        q.q === searchInput.trim() ? q : { ...q, q: searchInput.trim(), page: 1 },
      );
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchInput]);

  const { papers, total, totalPages, isLoading, error, refetch } =
    useLibraryList(query);
  const { facets, refetch: refetchFacets } = useLibraryFacets();

  const [uploadError, setUploadError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [viewMode, setViewMode] = useState<LibraryView>(getInitialView());

  const filtersActive = activeFilterCount(query);
  const isFiltered = filtersActive > 0 || query.q.length > 0;

  /** Every filter change resets to page 1 — see the debounce note above. */
  const patchQuery = (patch: Partial<LibraryQuery>) =>
    setQuery((q) => ({ ...q, ...patch, page: 1 }));

  const clearFilters = () => {
    setSearchInput("");
    setQuery({ ...LIBRARY_DEFAULT_QUERY, sort: query.sort, dir: query.dir });
  };

  const setView = (v: LibraryView) => {
    setViewMode(v);
    try {
      localStorage.setItem(LIBRARY_VIEW_KEY, v);
    } catch {
      // ignore — non-persistent is fine
    }
  };

  const afterMutation = () => {
    refetch();
    // A new or deleted paper can add or remove a taxon/region/year entirely.
    refetchFacets();
  };

  const handleUpload = async (file?: File) => {
    if (!file) return;
    setIsUploading(true);
    setUploadError("");
    try {
      await uploadResearchBrainSource(file);
      afterMutation();
    } catch (err: any) {
      setUploadError(err?.message || "Could not load the paper");
    } finally {
      setIsUploading(false);
    }
  };

  const activeSort =
    SORT_OPTIONS.find((o) => o.sort === query.sort && o.dir === query.dir) ??
    SORT_OPTIONS[0];

  const rangeStart = (query.page - 1) * query.pageSize + 1;
  const rangeEnd = Math.min(query.page * query.pageSize, total);

  return (
    <div className="library-page">
      <main className="library-main">
        <div className="library-heading">
          <h1>Paper library</h1>
          <p>
            Papers ingested into the knowledge base. Open one to read it
            and ask questions answered only from its content.
          </p>
        </div>

        {/*
          THE SEARCH BAR IS BASECOAT'S `.input-group` — the same component the
          sidebar's session search and the Research Brain's evidence search
          already wear: a bordered box, a leading icon, a borderless `flex: 1`
          input, and a trailing button. The focus ring goes on the GROUP via
          `:focus-within` (forms.css), because the input inside it is
          deliberately borderless.

          It searches title, structured title, publisher, TAXA and GEOGRAPHY,
          server-side. Nobody looks a paper up by its exact filename; they look
          for "the Caribbean coral one".
        */}
        <div className="library-toolbar">
          <div className="input-group library-search">
            <Icon name="search" size={17} />
            {/*
              `type="text"`, NOT `type="search"`. Chromium paints its OWN clear
              affordance inside a search input (`::-webkit-search-cancel-button`),
              which rendered a second X right next to the one below — two
              controls, one of them not ours and not wired to the debounce.
              Caught by rendering it. The visible clear button is the app's.
            */}
            <input
              type="text"
              value={searchInput}
              onInput={(e) =>
                setSearchInput((e.target as HTMLInputElement).value)
              }
              placeholder="Search papers, organisms, regions, publishers…"
              aria-label="Search the paper library"
            />
            {searchInput && (
              <button
                type="button"
                className="btn"
                data-variant="ghost"
                onClick={() => setSearchInput("")}
                aria-label="Clear search"
              >
                <Icon name="close" size={16} className={BUTTON_ICON_CLASS} />
              </button>
            )}
          </div>

          <label className="btn library-link-btn brain-upload-btn" data-variant="outline">
            <Icon name="upload" size={16} className={BUTTON_ICON_CLASS} />
            <span>{isUploading ? "Loading…" : "Upload paper"}</span>
            <input
              type="file"
              accept=".pdf,.md,.txt,.docx"
              disabled={isUploading}
              onChange={(e) =>
                handleUpload((e.target as HTMLInputElement).files?.[0])
              }
            />
          </label>

          <div className="library-view-toggle">
            <button
              className="btn library-view-btn"
              data-variant="ghost"
              data-size="icon-sm"
              data-tone={viewMode === "list" ? "brand" : undefined}
              onClick={() => setView("list")}
              title="List view"
              aria-label="List view"
              aria-pressed={viewMode === "list"}
            >
              <Icon name="list" size={16} className={BUTTON_ICON_CLASS} />
            </button>
            <button
              className="btn library-view-btn"
              data-variant="ghost"
              data-size="icon-sm"
              data-tone={viewMode === "grid" ? "brand" : undefined}
              onClick={() => setView("grid")}
              title="Card view"
              aria-label="Card view"
              aria-pressed={viewMode === "grid"}
            >
              <Icon name="grid" size={16} className={BUTTON_ICON_CLASS} />
            </button>
          </div>
        </div>

        {/*
          THE FILTER AXES ARE THE DOMAIN'S, NOT THE FILE SYSTEM'S. A marine
          bioprospecting corpus is navigated by ORGANISM and PLACE — "what did
          anyone find in Porites", "what came out of the Red Sea" — so taxa and
          geography lead. Year and trust tier are the secondary cuts. Sorting by
          filename, which is all the old page could do, answers no question a
          researcher actually has.
        */}
        <div className="library-filters" role="group" aria-label="Filter papers">
          <FilterSelect
            label="Organism"
            allLabel="All organisms"
            value={query.taxon}
            options={facets.taxa}
            onChange={(taxon) => patchQuery({ taxon })}
          />
          <FilterSelect
            label="Region"
            allLabel="All regions"
            value={query.geography}
            options={facets.geography}
            onChange={(geography) => patchQuery({ geography })}
          />
          <FilterSelect
            label="Year"
            allLabel="Any year"
            value={query.year}
            options={facets.years}
            onChange={(year) => patchQuery({ year })}
          />
          <FilterSelect
            label="Trust"
            allLabel="Any tier"
            value={query.trustTier}
            options={facets.trustTiers}
            onChange={(trustTier) => patchQuery({ trustTier })}
          />

          <label className="library-filter">
            <span>Sort</span>
            <select
              className="select"
              value={activeSort.id}
              onChange={(e) => {
                const next = SORT_OPTIONS.find(
                  (o) => o.id === (e.target as HTMLSelectElement).value,
                );
                if (next) patchQuery({ sort: next.sort, dir: next.dir });
              }}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {isFiltered && (
            <button
              type="button"
              className="btn library-clear"
              data-variant="ghost"
              data-size="sm"
              onClick={clearFilters}
            >
              <Icon name="close" size={14} className={BUTTON_ICON_CLASS} />
              <span>Clear filters</span>
            </button>
          )}
        </div>

        {!isLoading && !error && total > 0 && (
          <p className="library-count" role="status">
            {total === 1
              ? "1 paper"
              : `${rangeStart}–${rangeEnd} of ${total} papers`}
            {isFiltered ? " matching your filters" : ""}
          </p>
        )}

        {uploadError && (
          <div className="alert" data-tone="danger" role="alert">
            <strong>{uploadError}</strong>
          </div>
        )}

        {deleteError && (
          <div className="alert" data-tone="danger" role="alert">
            <strong>{deleteError}</strong>
          </div>
        )}

        {error && !isLoading && (
          <div className="alert" data-tone="danger" role="alert">
            <strong>{error}</strong>
            <footer>
              <button
                className="btn"
                data-variant="outline"
                data-size="sm"
                onClick={() => refetch()}
              >
                <Icon name="refresh" size={16} className={BUTTON_ICON_CLASS} />
                <span>Retry</span>
              </button>
            </footer>
          </div>
        )}

        {isLoading && (
          <div className="library-list" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <PaperRowSkeleton key={i} />
            ))}
          </div>
        )}

        {/*
          TWO EMPTY STATES, because they are two different problems. An empty
          CORPUS needs a paper; an empty RESULT needs a different query, and
          offering "add files to KNOWLEDGE_DOCS_PATH" to someone who just typed
          a typo would be nonsense.
        */}
        {!isLoading && !error && papers.length === 0 && (
          <div className="empty library-empty">
            <header>
              <h3>{isFiltered ? "No papers match" : "No papers yet"}</h3>
              <p>
                {isFiltered
                  ? "Nothing in the library matches this search and these filters. Try a broader term, or clear the filters."
                  : "Add files to the documents folder (KNOWLEDGE_DOCS_PATH) and restart the server, or upload a paper above."}
              </p>
            </header>
            {isFiltered && (
              <footer>
                <button
                  type="button"
                  className="btn"
                  data-variant="outline"
                  data-size="sm"
                  onClick={clearFilters}
                >
                  <Icon name="close" size={14} className={BUTTON_ICON_CLASS} />
                  <span>Clear filters</span>
                </button>
              </footer>
            )}
          </div>
        )}

        {!isLoading && !error && papers.length > 0 && (
          <>
            {viewMode === "grid" ? (
              <div className="library-grid">
                {papers.map((paper) => (
                  <PaperCard
                    key={paper.docId}
                    paper={paper}
                    onDeleted={afterMutation}
                    onError={setDeleteError}
                  />
                ))}
              </div>
            ) : (
              <div className="library-list">
                {papers.map((paper) => (
                  <PaperRow
                    key={paper.docId}
                    paper={paper}
                    onDeleted={afterMutation}
                    onError={setDeleteError}
                  />
                ))}
              </div>
            )}

            <Pagination
              className="library-pagination"
              label="Library pages"
              page={query.page}
              totalPages={totalPages}
              onPage={(page) => {
                setQuery((q) => ({ ...q, page }));
                // A page change that leaves the viewport where it was strands
                // the reader mid-list. Put them at the top of the new page.
                window.scrollTo({ top: 0 });
              }}
            />
          </>
        )}
      </main>
    </div>
  );
}

/**
 * Single Library card (grid view). Manages its own hover state so the FULL
 * abstract is fetched lazily (once, cached) from the detail endpoint on first
 * hover/focus and revealed via a CSS expand — keeping the list payload light.
 */
function PaperCard({
  paper,
  onDeleted,
  onError,
}: {
  paper: LibraryPaper;
  onDeleted: () => void;
  onError: (msg: string) => void;
}) {
  const [abstract, setAbstract] = useState<string>("");
  const [loadedAbstract, setLoadedAbstract] = useState(false);
  const title = displayTitle(paper);
  const sub = subline(paper);

  const loadAbstract = () => {
    if (loadedAbstract) return;
    setLoadedAbstract(true);
    fetchPaperAbstract(paper.docId).then((text) => {
      if (text) setAbstract(text);
    });
  };

  return (
    <div
      className="card paper-card"
      data-hover="brand"
      onMouseEnter={loadAbstract}
      onFocusCapture={loadAbstract}
    >
      <header className="paper-card-top">
        <div className="paper-card-icon">
          <Icon name="bookOpen" size={22} />
        </div>
        <div className="paper-card-body">
          <h3 className="paper-card-title" title={title}>
            {title}
          </h3>
          {sub && <div className="paper-card-subtitle">{sub}</div>}
          <div className="paper-card-meta">
            <EvidenceChip count={paper.evidenceCount} />
            {typeof paper.bioprospectingFactCount === "number" &&
              paper.bioprospectingFactCount > 0 && (
                <span className="badge" data-tone="violet">
                  {paper.bioprospectingFactCount} facts
                </span>
              )}
            {paper.trustTier && (
              <span
                className="badge paper-trust"
                data-tone={trustTone(paper.trustTier)}
                title={`Trust tier: ${trustLabel(paper.trustTier)}`}
              >
                {trustLabel(paper.trustTier)}
              </span>
            )}
            {paper.type && (
              <span className="badge paper-tag" data-tone="neutral">
                {paper.type.toUpperCase()}
              </span>
            )}
            {paper.chunkCount != null && (
              <span>{paper.chunkCount} fragments</span>
            )}
            {paper.size ? (
              <span title={`${paper.size} bytes`}>{formatSize(paper.size)}</span>
            ) : null}
            {paper.doiUrl && (
              <ExternalLink
                className="paper-doi-link"
                href={paper.doiUrl}
                label={`DOI for ${title}`}
                onClick={(e) => e.stopPropagation()}
              >
                DOI
              </ExternalLink>
            )}
          </div>
        </div>
      </header>

      {(paper.taxa?.length || paper.geography?.length) ? (
        <section className="paper-chips">
          <DomainChips paper={paper} max={4} />
        </section>
      ) : null}

      {abstract && (
        <section>
          <p className="paper-card-abstract" title={abstract}>
            {abstract}
          </p>
        </section>
      )}

      <footer className="paper-card-actions">
        <button
          className="btn paper-action"
          data-variant="primary"
          onClick={() => route(`/library/${paper.docId}`)}
        >
          <Icon name="messageSquare" size={15} className={BUTTON_ICON_CLASS} />
          <span>Chat with paper</span>
        </button>
        <button
          className="btn paper-action"
          data-variant="outline"
          aria-label={`View evidence for ${title}`}
          onClick={() => route(`/library/${paper.docId}/viewer`)}
        >
          <Icon name="microscope" size={15} className={BUTTON_ICON_CLASS} />
          <span>View evidence</span>
        </button>
        <DeletePaperButton
          paper={paper}
          onDeleted={onDeleted}
          onError={onError}
        />
      </footer>
    </div>
  );
}
