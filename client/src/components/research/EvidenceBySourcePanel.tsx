import { useState } from "preact/hooks";
import { Icon } from "../icons";

/**
 * Per-source result for a single LITERATURE task. Mirrors the backend
 * LiteratureSourceResult type (src/types/core.ts).
 */
export type LiteratureSource = {
  sourceName: "OPENSCHOLAR" | "KNOWLEDGE" | "EDISON" | "BIOLIT" | "BIOLITDEEP";
  status: "ok" | "empty" | "failed";
  count: number;
  durationMs: number;
  finishedAt?: string;
  output?: string;
  error?: string;
  jobId?: string;
  /** KNOWLEDGE source: the distinct library papers this search retrieved. */
  papers?: { title: string; chunks: number }[];
};

interface Props {
  /** Per-source results from a LITERATURE task. When undefined/empty,
   *  the panel renders nothing (caller can fall back to legacy output). */
  sources?: LiteratureSource[];
  /** Whether to start expanded (true for the most recent task). */
  defaultExpanded?: boolean;
}

export const SOURCE_META: Record<
  LiteratureSource["sourceName"],
  { label: string; icon: string; description: string }
> = {
  OPENSCHOLAR: {
    label: "OpenScholar",
    icon: "graduationCap",
    description: "Academic papers via OpenScholar API",
  },
  KNOWLEDGE: {
    label: "Knowledge base",
    icon: "bookOpen",
    description: "Locally ingested PDFs (vector search)",
  },
  EDISON: {
    label: "Edison",
    icon: "microscope",
    description: "External Edison research agent",
  },
  BIOLIT: {
    label: "BioLit",
    icon: "dna",
    description: "External BioLit fast literature",
  },
  BIOLITDEEP: {
    label: "BioLit Deep",
    icon: "dna",
    description: "External BioLit deep literature",
  },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

export function statusGlyph(status: LiteratureSource["status"]): {
  icon: string;
  color: string;
  label: string;
} {
  // These three ARE statuses (a source resolved, returned nothing, or failed),
  // so they take the status family rather than a data palette. "No matches" is
  // not a failure — it is an absence — so it reads as dimmed text, not a hue.
  if (status === "ok")
    return { icon: "check", color: "var(--success)", label: "OK" };
  if (status === "empty")
    return { icon: "circle", color: "var(--text-tertiary)", label: "No matches" };
  return { icon: "close", color: "var(--destructive)", label: "Failed" };
}

/**
 * Render per-source provenance for a LITERATURE task.
 *
 * - Shows each source (OpenScholar, Knowledge, Edison, ...) with its own
 *   status, count, duration, and (when failed) error message.
 * - Collapsed by default; tap to expand and see raw output.
 *
 * Used inside ResearchStatePanel as a drop-in replacement for the flat
 * `step.output` preview when the new per-source shape is available.
 */
export function EvidenceBySourcePanel({
  sources,
  defaultExpanded = false,
}: Props) {
  const [expandedSources, setExpandedSources] = useState<
    Record<string, boolean>
  >({});
  const [isPanelOpen, setIsPanelOpen] = useState(defaultExpanded);

  if (!sources || sources.length === 0) {
    return null;
  }

  const okCount = sources.filter((s) => s.status === "ok").length;
  const failedCount = sources.filter((s) => s.status === "failed").length;
  const totalCount = sources.reduce((acc, s) => acc + s.count, 0);

  return (
    /* Basecoat's `.accordion`, like every other disclosure in the research panel:
       native <details> / <summary>, so the role, the expanded state, Enter/Space and
       the chevron rotation are the browser's, not ours. See the note in research.css.

       Two skins ago this toggle wore NO class and NO rule — `.evidence-by-source-*`
       has no CSS anywhere in the client — so without Tailwind's Preflight it rendered
       as a raw UA button: `background: buttonface`, `font-family: Arial`, and a 2px
       OUTSET bevel. */
    <div className="accordion evidence-by-source">
      <details open={isPanelOpen}>
        <summary
          className="evidence-by-source-header"
          onClick={(e) => {
            e.preventDefault();
            setIsPanelOpen((prev) => !prev);
          }}
        >
          <Icon name="microscope" size={14} className="evidence-by-source-icon" />
          <span className="evidence-by-source-title">
            Evidence ({okCount}/{sources.length} sources, {totalCount} chunks)
          </span>
          {failedCount > 0 && (
            <span className="badge" data-tone="danger">
              {failedCount} failed
            </span>
          )}
          <Icon name="chevronDown" size={14} />
        </summary>

        {isPanelOpen && (
        <div className="accordion evidence-by-source-list">
          {sources.map((source, idx) => {
            const meta = SOURCE_META[source.sourceName];
            const glyph = statusGlyph(source.status);
            const isSourceOpen = !!expandedSources[`${source.sourceName}-${idx}`];
            const toggleSource = () =>
              setExpandedSources((prev) => ({
                ...prev,
                [`${source.sourceName}-${idx}`]: !prev[`${source.sourceName}-${idx}`],
              }));

            return (
              <details
                key={`${source.sourceName}-${idx}`}
                className={`evidence-by-source-row evidence-by-source-${source.status}`}
                open={isSourceOpen}
              >
                <summary
                  className="evidence-by-source-row-header"
                  onClick={(e) => {
                    e.preventDefault();
                    toggleSource();
                  }}
                >
                  <span
                    className="evidence-by-source-row-icon"
                    style={{ color: glyph.color }}
                    role="img"
                    aria-label={glyph.label}
                  >
                    <Icon name={glyph.icon} size={12} />
                  </span>
                  <span className="evidence-by-source-row-label">
                    <Icon
                      name={meta.icon}
                      size={12}
                      className="evidence-by-source-row-icon-name"
                    />{" "}
                    {meta.label}
                  </span>
                  <span className="evidence-by-source-row-meta">
                    {source.status === "ok" && `${source.count} chunks`}
                    {source.status === "empty" && "0 chunks"}
                    {source.status === "failed" && (source.error || "Failed")}
                  </span>
                  <span className="evidence-by-source-row-duration">
                    {formatDuration(source.durationMs)}
                  </span>
                  <Icon name="chevronDown" size={12} />
                </summary>

                {isSourceOpen && (
                  <div className="evidence-by-source-row-body">
                    <p className="evidence-by-source-row-description">
                      {meta.description}
                      {source.jobId && (
                        <>
                          {" "}
                          <span className="evidence-by-source-row-jobid">
                            job: <code>{source.jobId}</code>
                          </span>
                        </>
                      )}
                    </p>
                    {source.status === "failed" && source.error && (
                      <pre className="evidence-by-source-row-error">
                        {source.error}
                      </pre>
                    )}
                    {source.output && (
                      <pre className="evidence-by-source-row-output">
                        {source.output.length > 2000
                          ? source.output.slice(0, 2000) + "\n\n[…truncated]"
                          : source.output}
                      </pre>
                    )}
                  </div>
                )}
              </details>
            );
          })}
        </div>
        )}
      </details>
    </div>
  );
}