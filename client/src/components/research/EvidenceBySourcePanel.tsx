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
};

interface Props {
  /** Per-source results from a LITERATURE task. When undefined/empty,
   *  the panel renders nothing (caller can fall back to legacy output). */
  sources?: LiteratureSource[];
  /** Whether to start expanded (true for the most recent task). */
  defaultExpanded?: boolean;
}

const SOURCE_META: Record<
  LiteratureSource["sourceName"],
  { label: string; icon: string; description: string }
> = {
  OPENSCHOLAR: {
    label: "OpenScholar",
    icon: "🎓",
    description: "Academic papers via OpenScholar API",
  },
  KNOWLEDGE: {
    label: "Knowledge base",
    icon: "📚",
    description: "Locally ingested PDFs (vector search)",
  },
  EDISON: {
    label: "Edison",
    icon: "🔬",
    description: "External Edison research agent",
  },
  BIOLIT: {
    label: "BioLit",
    icon: "🧬",
    description: "External BioLit fast literature",
  },
  BIOLITDEEP: {
    label: "BioLit Deep",
    icon: "🧬",
    description: "External BioLit deep literature",
  },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function statusGlyph(status: LiteratureSource["status"]): {
  icon: string;
  color: string;
  label: string;
} {
  if (status === "ok") return { icon: "✓", color: "#10b981", label: "OK" };
  if (status === "empty")
    return { icon: "○", color: "#6b7280", label: "No matches" };
  return { icon: "✗", color: "#ef4444", label: "Failed" };
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
    <div className="evidence-by-source">
      <button
        className="evidence-by-source-header"
        onClick={() => setIsPanelOpen((prev) => !prev)}
      >
        <span className="evidence-by-source-icon">🔬</span>
        <span className="evidence-by-source-title">
          Evidence ({okCount}/{sources.length} sources, {totalCount} chunks)
        </span>
        {failedCount > 0 && (
          <span className="evidence-by-source-badge evidence-by-source-badge-failed">
            {failedCount} failed
          </span>
        )}
        <Icon
          name="chevronDown"
          size={14}
          className={`research-section-chevron ${isPanelOpen ? "expanded" : ""}`}
        />
      </button>

      {isPanelOpen && (
        <div className="evidence-by-source-list">
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
              <div
                key={`${source.sourceName}-${idx}`}
                className={`evidence-by-source-row evidence-by-source-${source.status}`}
              >
                <button
                  className="evidence-by-source-row-header"
                  onClick={toggleSource}
                >
                  <span
                    className="evidence-by-source-row-icon"
                    style={{ color: glyph.color }}
                  >
                    {glyph.icon}
                  </span>
                  <span className="evidence-by-source-row-label">
                    <span className="evidence-by-source-row-icon-name">
                      {meta.icon}
                    </span>{" "}
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
                  <Icon
                    name="chevronDown"
                    size={12}
                    className={`research-section-chevron ${isSourceOpen ? "expanded" : ""}`}
                  />
                </button>

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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}