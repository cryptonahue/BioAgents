import { useState, useEffect } from "preact/hooks";
import { Icon } from "../icons";
import { ExternalLink, isExternalHref } from "../../utils/externalLinks";
import { ArtifactViewer } from "./ArtifactViewer";
import { ResearchProgressTracker } from "./ResearchProgressTracker";
import { EvidenceCorpusPanel } from "./EvidenceCorpusPanel";
import {
  EvidenceBySourcePanel,
  type LiteratureSource,
} from "./EvidenceBySourcePanel";

interface Dataset {
  id: string;
  filename: string;
  description: string;
  size?: number;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

interface AnalysisArtifact {
  id: string;
  description: string;
  type: "FILE" | "FOLDER";
  content?: string;
  name: string;
  path?: string;
}

interface PlanStep {
  type: string;
  objective: string;
  output?: string;
  /** Per-source provenance for LITERATURE tasks (commit 516440e). When
   *  present we render EvidenceBySourcePanel instead of the flat output. */
  sources?: LiteratureSource[];
  datasets?: Dataset[];
  start?: string;
  end?: string;
  artifacts?: AnalysisArtifact[];
}

interface ResearchEvidenceItem {
  claim: string;
  sourceTitle?: string;
  status?: string;
}

interface ResearchDiscovery {
  title?: string;
  claim?: string;
  summary?: string;
  novelty?: string;
}

interface ResearchState {
  plan?: PlanStep[];
  // Discoveries are Discovery OBJECTS (title/claim/summary/novelty), not strings.
  // The old `string[]` type rendered every discovery as an empty row.
  discoveries?: Array<ResearchDiscovery | string>;
  keyInsights?: string[];
  methodology?: string;
  currentObjective?: string;
  uploadedDatasets?: Dataset[];
  currentHypothesis?: string;
  researchBrainEvidence?: {
    supportedClaims?: ResearchEvidenceItem[];
    partialClaims?: ResearchEvidenceItem[];
    contradictions?: ResearchEvidenceItem[];
    openQuestions?: ResearchEvidenceItem[];
    /** The retrieved passages. Each knows its source paper, which is all the
     *  corpus panel needs to say which papers a search actually matched. */
    passages?: Array<{ sourceTitle?: string | null }>;
  };
}

interface Props {
  state: ResearchState | null;
  isExpanded?: boolean;
  onToggle?: () => void;
  isLoading?: boolean;
  /** True while the server reports the deep-research run as active. Drives the
   *  "🔬 Investigando…" progress card above the accordion. */
  isRunActive?: boolean;
  /** ISO timestamp the active run started (deepResearchRun.startedAt). */
  runStartedAt?: string | null;
  /** Server's live activity (values.currentActivity) — drives the tracker's
   *  real-time subtitle during the slow synthesis tail. */
  currentActivity?: { label?: string; objective?: string } | null;
}

export function ResearchStatePanel({
  state,
  isExpanded = false,
  onToggle,
  isLoading = false,
  isRunActive = false,
  runStartedAt = null,
  currentActivity = null,
}: Props) {
  const [expandedSections, setExpandedSections] = useState<
    Record<string, boolean>
  >({
    hypothesis: true,
    discoveries: false,
    insights: false,
    methodology: false,
    datasets: false,
    plan: false,
    brain: true,
  });

  // Track which step outputs are expanded
  const [expandedStepOutputs, setExpandedStepOutputs] = useState<
    Record<number, boolean>
  >({});

  const toggleStepOutput = (index: number) => {
    setExpandedStepOutputs((prev) => ({
      ...prev,
      [index]: !prev[index],
    }));
  };

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  const formatStepType = (type: string) => {
    // `bg` is a separate token rather than an alpha suffix on `color`. The old
    // code built the chip background as `${color}15` — a hex-alpha concat — and
    // that idiom cannot survive tokenization: you cannot append "15" to
    // `var(--task-literature)`.
    //
    // `icon` is an `Icon` NAME, not an emoji. The five task types used to carry
    // book / chart / bulb / glass / clipboard EMOJI and rendered them as text;
    // they are Phosphor glyphs now, so they take the chip's `currentColor`, scale
    // with `size`, and do not depend on a system emoji font being installed.
    const types: Record<
      string,
      { label: string; icon: string; color: string; bg: string }
    > = {
      LITERATURE: { label: "Literature Search", icon: "bookOpen", color: "var(--task-literature)", bg: "var(--task-literature-subtle)" },
      ANALYSIS: { label: "Data Analysis", icon: "barChart", color: "var(--task-analysis)", bg: "var(--task-analysis-subtle)" },
      HYPOTHESIS: { label: "Hypothesis", icon: "lightbulb", color: "var(--task-hypothesis)", bg: "var(--task-hypothesis-subtle)" },
      REFLECTION: { label: "Reflection", icon: "search", color: "var(--task-reflection)", bg: "var(--task-reflection-subtle)" },
      PLANNING: { label: "Planning", icon: "clipboard", color: "var(--task-planning)", bg: "var(--task-planning-subtle)" },
    };
    return (
      types[type] || {
        label: type,
        icon: "zap",
        color: "var(--task-other)",
        bg: "var(--task-other-subtle)",
      }
    );
  };

  // Format milliseconds as "12.3s" or "1m 23s" or "1h 5m"
  const formatMs = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  };

  // Compute the duration of a step in human-readable form.
  // For the current step, ticks every render (live counter).
  const computeDuration = (
    start?: string,
    end?: string,
    isCurrent = false,
  ): string | null => {
    if (!start) return null;
    const startMs = new Date(start).getTime();
    const endMs = end ? new Date(end).getTime() : Date.now();
    if (isNaN(startMs) || isNaN(endMs)) return null;
    return formatMs(endMs - startMs);
  };

  // Live counter for the current step: re-renders every second while a
  // step is in progress, showing "Running for 12s...".
  const ElapsedSince = ({ start }: { start?: string }) => {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
      if (!start) return;
      const t = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(t);
    }, [start]);
    if (!start) return null;
    const ms = now - new Date(start).getTime();
    return (
      <span className="research-step-elapsed">({formatMs(ms)})</span>
    );
  };

  const parseCitationText = (text: string) => {
    // Parse citations like [text](url) into clickable links
    const parts = [];
    const regex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({
          type: "text",
          content: text.slice(lastIndex, match.index),
        });
      }
      parts.push({ type: "link", text: match[1], url: match[2] });
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      parts.push({ type: "text", content: text.slice(lastIndex) });
    }

    return parts;
  };

  const renderCitationText = (text: string) => {
    const parts = parseCitationText(text);
    return parts.map((part, i) => {
      if (part.type !== "link") return <span key={i}>{part.content}</span>;
      // NOT every citation in a discovery or an insight is external. The agent emits
      // in-app URLs (`/library/…`) alongside DOIs, and this used to open BOTH in a
      // new tab — a second copy of the SPA for an internal route. `isExternalHref`
      // is the whole test: absolute http(s) AND a different origin.
      return isExternalHref(part.url!) ? (
        <ExternalLink
          key={i}
          href={part.url!}
          className="research-citation-link"
          label={part.text!}
        >
          {part.text}
        </ExternalLink>
      ) : (
        <a key={i} href={part.url} className="research-citation-link">
          {part.text}
        </a>
      );
    });
  };

  const completedSteps = state?.plan?.filter((step) => step.end) || [];
  const currentStep = state?.plan?.find((step) => step.start && !step.end);

  // Flatten the Research Brain claim buckets once, so the section can hide itself
  // when there is nothing to show (all buckets empty — e.g. after the relevance
  // filter drops off-topic claims) instead of rendering an empty header.
  const brainClaims = state?.researchBrainEvidence
    ? [
        ...(state.researchBrainEvidence.supportedClaims || []),
        ...(state.researchBrainEvidence.partialClaims || []),
        ...(state.researchBrainEvidence.contradictions || []),
        ...(state.researchBrainEvidence.openQuestions || []),
      ]
    : [];

  // Papers the literature searches actually retrieved (KNOWLEDGE source). The
  // reply is built on these as well as the evidence-pack passages, so the corpus
  // panel unions both — see EvidenceCorpusPanel.
  const literaturePapers = (state?.plan ?? [])
    .flatMap((step) => step.sources ?? [])
    .flatMap((source) => source.papers ?? []);

  // Show loading state when deep research is starting but no state yet
  const showLoadingState = isLoading && (!state || !state.currentObjective);

  /**
   * A controlled `<summary>`.
   *
   * `preventDefault()` cancels the browser's own toggle so the `open` attribute
   * stays a function of Preact state, which is the only way a parent-owned
   * `isExpanded` prop and a multi-open `expandedSections` record can survive a
   * re-render. Activating a `<summary>` with Enter or Space dispatches a click, so
   * this one handler covers pointer AND keyboard — there is no keydown handler and
   * no `aria-expanded` to keep honest.
   */
  const toggleOnSummary = (fn: () => void) => (e: Event) => {
    e.preventDefault();
    fn();
  };

  return (
    /*
     * Basecoat's `.accordion`, which is written against native <details> /
     * <summary>: every selector in `basecoat-css/dist/components/accordion.css` is
     * `.accordion > details > summary`, so the markup IS the semantics. The panel
     * itself qualifies — it is a card whose ENTIRE body collapses behind one header
     * row, which is a disclosure by definition, and `<details>` fits it exactly the
     * way it fits the sections inside it. The wrapper exists only to be the
     * `.accordion` root the child selectors require.
     *
     * `accordion.js` is not loaded (no Basecoat JS is). The one thing it adds is
     * single-open exclusivity, which is deliberately NOT wanted here — see the long
     * note in research.css.
     */
    <div className="accordion research-state-panel-shell">
      {/* The live progress card lives OUTSIDE the <details>: a closed <details>
          natively hides everything but its <summary>, and this must stay visible
          whether the accordion is open or not while a run is in flight. It
          unmounts on its own when the run finishes (isRunActive -> false). */}
      {isRunActive && (
        <ResearchProgressTracker
          state={state}
          startedAt={runStartedAt}
          activity={currentActivity}
        />
      )}
      {/* What the answer was actually built from. Sits above the accordion, next
          to the tracker, because it reframes everything below it: "2 of 47
          matched" is the difference between "the agent failed" and "my library
          is missing those papers". */}
      <EvidenceCorpusPanel
        passages={state?.researchBrainEvidence?.passages}
        literaturePapers={literaturePapers}
      />
      <details className="card research-state-panel" open={isExpanded}>
        <summary
          className="research-state-header"
          onClick={toggleOnSummary(() => onToggle?.())}
        >
          <div className="research-state-header-left">
            <Icon name="dna" size={18} className="research-state-icon" />
            <span className="research-state-title">Research State</span>
          </div>
          {/* The chevron must be the LAST child of the <summary>: Lyra selects it as
              `summary > svg:last-child` and rotates it on `details[open]`. */}
          <Icon name="chevronDown" size={16} />
        </summary>

        {/* Still mounted conditionally, exactly as before: the panel's body holds a
            live `setInterval` (ElapsedSince) and a slide-down animation, and a
            closed <details> keeps its children mounted. */}
        {isExpanded && (
        <div className="research-state-content accordion">
          {/* Loading State */}
          {showLoadingState && (
            <div className="research-section research-loading-state">
              <div className="research-loading-indicator">
                <span className="research-step-spinner" />
                <span className="research-loading-text">Initializing deep research...</span>
              </div>
            </div>
          )}

          {/* Objective. This field is written by the reflection/planning agents as
              the NEXT research direction — it is a proposal, not a live action. So
              once the run is over it must not read as "what I am doing now": it is
              a suggestion sitting there waiting for the user to approve or steer. */}
          {state?.currentObjective && (
            <div className="research-section research-current-objective">
              <div className="research-section-label">
                <Icon name="target" size={14} className="research-section-icon" />
                {isRunActive ? "Current Objective" : "Next planned objective"}
              </div>
              <p className="research-objective-text">
                {state?.currentObjective}
              </p>
              {!isRunActive && (
                <p className="research-objective-hint">
                  Proposed for the next cycle — not run yet.
                </p>
              )}
            </div>
          )}

          {brainClaims.length > 0 && (
            <details
              className="research-section"
              open={expandedSections.brain}
            >
              <summary
                className="research-section-toggle"
                onClick={toggleOnSummary(() => toggleSection("brain"))}
              >
                <div className="research-section-toggle-left">
                  <Icon name="brainCircuit" size={14} />
                  <span>Research Brain Evidence</span>
                </div>
                <Icon name="chevronDown" size={14} />
              </summary>
              {expandedSections.brain && (
                <div className="research-section-body">
                  <ul className="research-insights-list">
                    {brainClaims.slice(0, 6).map((claim, i) => (
                      <li
                        key={i}
                        className="item research-insight-item"
                        data-variant="outline"
                        data-size="sm"
                      >
                        <section>
                          <span>
                            <strong>{claim.status || "evidence"}:</strong>{" "}
                            {claim.claim}
                            {claim.sourceTitle ? ` (${claim.sourceTitle})` : ""}
                          </span>
                        </section>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </details>
          )}

          {/* Hypothesis */}
          {state?.currentHypothesis && (
            <details
              className="research-section"
              open={expandedSections.hypothesis}
            >
              <summary
                className="research-section-toggle"
                onClick={toggleOnSummary(() => toggleSection("hypothesis"))}
              >
                <div className="research-section-toggle-left">
                  <Icon name="lightbulb" size={14} className="research-section-icon" />
                  <span>Hypothesis</span>
                </div>
                <Icon name="chevronDown" size={14} />
              </summary>
              {expandedSections.hypothesis && (
                <div className="research-section-body research-hypothesis">
                  <div className="research-hypothesis-content">
                    {state?.currentHypothesis?.split("\n").map((line, i) => {
                      if (line.startsWith("## ")) {
                        return (
                          <h4 key={i} className="research-hypothesis-heading">
                            {line.replace("## ", "")}
                          </h4>
                        );
                      }
                      if (line.trim()) {
                        return (
                          <p key={i} className="research-hypothesis-paragraph">
                            {renderCitationText(line)}
                          </p>
                        );
                      }
                      return null;
                    })}
                  </div>
                </div>
              )}
            </details>
          )}

          {/* Discoveries */}
          {state?.discoveries && state.discoveries.length > 0 && (
            <details
              className="research-section"
              open={expandedSections.discoveries}
            >
              <summary
                className="research-section-toggle"
                onClick={toggleOnSummary(() => toggleSection("discoveries"))}
              >
                <div className="research-section-toggle-left">
                  <Icon name="microscope" size={14} className="research-section-icon" />
                  <span>Discoveries ({state.discoveries.length})</span>
                </div>
                <Icon name="chevronDown" size={14} />
              </summary>
              {expandedSections.discoveries && (
                <div className="research-section-body">
                  <ul className="research-discoveries-list">
                    {state.discoveries.map((discovery, i) => {
                      // A discovery is a Discovery object; tolerate a legacy
                      // string too. Rendering the object as a string is what
                      // produced empty rows.
                      const d =
                        typeof discovery === "string"
                          ? { summary: discovery }
                          : discovery;
                      return (
                        <li
                          key={i}
                          className="item research-discovery-item"
                          data-variant="outline"
                          data-size="sm"
                        >
                          <section>
                            {d.title && (
                              <span className="research-discovery-title">
                                <strong>{d.title}</strong>
                              </span>
                            )}
                            {d.claim && (
                              <span>{renderCitationText(d.claim)}</span>
                            )}
                            {d.summary && d.summary !== d.claim && (
                              <span className="research-discovery-summary">
                                {renderCitationText(d.summary)}
                              </span>
                            )}
                            {d.novelty && (
                              <span className="research-discovery-novelty">
                                {renderCitationText(d.novelty)}
                              </span>
                            )}
                          </section>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </details>
          )}

          {/* Key Insights */}
          {state?.keyInsights && state.keyInsights.length > 0 && (
            <details
              className="research-section"
              open={expandedSections.insights}
            >
              <summary
                className="research-section-toggle"
                onClick={toggleOnSummary(() => toggleSection("insights"))}
              >
                <div className="research-section-toggle-left">
                  <Icon name="sparkles" size={14} className="research-section-icon" />
                  <span>Key Insights ({state.keyInsights.length})</span>
                </div>
                <Icon name="chevronDown" size={14} />
              </summary>
              {expandedSections.insights && (
                <div className="research-section-body">
                  <ul className="research-insights-list">
                    {state.keyInsights.map((insight, i) => (
                      <li
                        key={i}
                        className="item research-insight-item"
                        data-variant="outline"
                        data-size="sm"
                      >
                        <section>
                          <span>{renderCitationText(insight)}</span>
                        </section>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </details>
          )}

          {/* Methodology */}
          {state?.methodology && (
            <details
              className="research-section"
              open={expandedSections.methodology}
            >
              <summary
                className="research-section-toggle"
                onClick={toggleOnSummary(() => toggleSection("methodology"))}
              >
                <div className="research-section-toggle-left">
                  <Icon name="microscope" size={14} className="research-section-icon" />
                  <span>Methodology</span>
                </div>
                <Icon name="chevronDown" size={14} />
              </summary>
              {expandedSections.methodology && (
                <div className="research-section-body">
                  <p className="research-methodology-text">
                    {state?.methodology}
                  </p>
                </div>
              )}
            </details>
          )}

          {/* Uploaded Datasets */}
          {state?.uploadedDatasets && state.uploadedDatasets.length > 0 && (
            <details
              className="research-section"
              open={expandedSections.datasets}
            >
              <summary
                className="research-section-toggle"
                onClick={toggleOnSummary(() => toggleSection("datasets"))}
              >
                <div className="research-section-toggle-left">
                  <Icon name="folder" size={14} className="research-section-icon" />
                  <span>Datasets ({state.uploadedDatasets.length})</span>
                </div>
                <Icon name="chevronDown" size={14} />
              </summary>
              {expandedSections.datasets && (
                <div className="research-section-body">
                  <div className="research-datasets-list">
                    {state.uploadedDatasets.map((dataset) => (
                      <div
                        key={dataset.id}
                        className="item research-dataset-item"
                        data-variant="outline"
                        data-size="sm"
                      >
                        <figure>
                          <Icon name="file" size={14} />
                        </figure>
                        <section>
                          <span className="research-dataset-name">
                            {dataset.filename}
                          </span>
                          <span className="research-dataset-description">
                            {dataset.description}
                          </span>
                        </section>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </details>
          )}

          {/* Completed Steps */}
          {completedSteps.length > 0 && (
            <details
              className="research-section"
              open={expandedSections.plan}
            >
              <summary
                className="research-section-toggle"
                onClick={toggleOnSummary(() => toggleSection("plan"))}
              >
                <div className="research-section-toggle-left">
                  <Icon name="checkCircle" size={14} className="research-section-icon" />
                  <span>Completed Steps ({completedSteps.length})</span>
                </div>
                <Icon name="chevronDown" size={14} />
              </summary>
              {expandedSections.plan && (
                <div className="research-section-body">
                  <div className="research-steps-list">
                    {completedSteps.map((step, i) => {
                      const stepInfo = formatStepType(step.type);
                      const isOutputExpanded = expandedStepOutputs[i] || false;
                      const outputPreviewLength = 300;
                      const needsTruncation =
                        step.output && step.output.length > outputPreviewLength;

                      return (
                        <div key={i} className="research-step-item completed">
                          <div className="research-step-header">
                            <div
                              className="badge"
                              data-tone="task"
                              style={{
                                "--step-bg": stepInfo.bg,
                                "--step-color": stepInfo.color,
                              } as React.CSSProperties}
                            >
                              <Icon
                                name={stepInfo.icon}
                                size={12}
                                className="research-step-emoji"
                              />
                              {stepInfo.label}
                            </div>
                          </div>
                          <p className="research-step-objective">
                            {step.objective}
                          </p>

                          {/* Step datasets */}
                          {step.datasets && step.datasets.length > 0 && (
                            <div className="research-step-datasets">
                              {step.datasets.map((ds, di) => (
                                <span
                                  key={di}
                                  className="badge"
                                  data-tone="brand"
                                >
                                  <Icon name="file" size={12} />
                                  {ds.filename}
                                </span>
                              ))}
                            </div>
                          )}

                          {/* Step artifacts */}
                          {step.artifacts && step.artifacts.length > 0 && (
                            <div
                              className="research-step-artifacts"
                              style={{ marginTop: "8px" }}
                            >
                              <ArtifactViewer
                                results={[
                                  {
                                    success: true,
                                    artifacts: step.artifacts.map((a) => ({
                                      id: a.id,
                                      filename: a.name,
                                      content: a.content || "",
                                      description: a.description,
                                      path: a.path,
                                    })),
                                  },
                                ]}
                                defaultExpanded={false}
                              />
                            </div>
                          )}

                          {/* Per-source evidence panel (preferred for LITERATURE tasks) */}
                          {step.sources && step.sources.length > 0 && (
                            <EvidenceBySourcePanel
                              sources={step.sources}
                              defaultExpanded={false}
                            />
                          )}

                          {/* Step output with expand/collapse (fallback for legacy
                              tasks without sources[] or for ANALYSIS tasks) */}
                          {step.output && (!step.sources || step.sources.length === 0) && (
                            <div className="research-step-output">
                              <pre className="research-step-output-content">
                                {isOutputExpanded
                                  ? step.output
                                  : needsTruncation
                                    ? step.output.slice(
                                        0,
                                        outputPreviewLength,
                                      ) + "..."
                                    : step.output}
                              </pre>
                              {needsTruncation && (
                                <button
                                  className="btn research-step-output-toggle"
                                  data-variant="ghost"
                                  data-size="sm"
                                  aria-expanded={isOutputExpanded}
                                  onClick={() => toggleStepOutput(i)}
                                >
                                  {isOutputExpanded ? (
                                    <>
                                      <Icon name="chevronUp" size={12} />
                                      Show less
                                    </>
                                  ) : (
                                    <>
                                      <Icon name="chevronDown" size={12} />
                                      Show full output (
                                      {Math.round(step.output.length / 1000)}k
                                      chars)
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </details>
          )}

          {/* Current Step (if running) */}
          {currentStep && (
            <div className="research-section research-current-step">
              <div className="research-section-label">
                <span className="research-step-spinner" />
                Running: {formatStepType(currentStep.type).label}
                <ElapsedSince start={currentStep.start} />
              </div>
              <p className="research-step-objective">{currentStep.objective}</p>
            </div>
          )}

          {/* Activity Log (completed + current steps with timing) */}
          {state?.plan && state.plan.length > 0 && (
            <details
              className="research-section research-activity-log"
              open={!!expandedSections.activityLog}
            >
              <summary
                className="research-activity-log-header"
                onClick={toggleOnSummary(() => toggleSection("activityLog"))}
              >
                <span className="research-section-label">
                  <Icon name="clipboard" size={14} className="research-activity-log-icon" />
                  Activity Log ({state.plan.filter(s => s.end).length}/{state.plan.length} done)
                </span>
                <Icon name="chevronDown" size={14} />
              </summary>
              {expandedSections.activityLog && (
                <div className="research-activity-log-list">
                  {state.plan.map((step, idx) => {
                    const stepInfo = formatStepType(step.type);
                    const isCurrent = currentStep === step;
                    const isDone = !!step.end;
                    const duration = computeDuration(step.start, step.end, isCurrent);
                    // Basecoat's `.item` — the same row component the Library's
                    // list and the sidebar's chat history wear, in its full
                    // `figure` / `section` / `aside` shape. The step type is the
                    // row's heading and the objective is its description, which is
                    // what Lyra's `<h4>` (`line-clamp-1`) and `<p>`
                    // (`text-muted-foreground line-clamp-2`) already mean.
                    //
                    // The objective is no longer sliced to 80 characters in JS: the
                    // `<p>` clamps it to two lines in CSS, which is the component's
                    // job and does not hard-code a guess at the column width.
                    return (
                      <div
                        key={idx}
                        className={`item research-activity-log-item ${isCurrent ? "current" : ""} ${isDone ? "done" : ""}`}
                        data-variant="outline"
                        data-size="xs"
                      >
                        <figure
                          className="research-activity-log-icon"
                          aria-label={
                            isCurrent ? "Running" : isDone ? "Done" : "Queued"
                          }
                          role="img"
                        >
                          <Icon
                            name={
                              isCurrent
                                ? "spinner"
                                : isDone
                                  ? "check"
                                  : stepInfo.icon
                            }
                            size={12}
                          />
                        </figure>
                        <section>
                          <h4 className="research-activity-log-type">
                            {stepInfo.label}
                          </h4>
                          <p className="research-activity-log-objective">
                            {step.objective}
                          </p>
                        </section>
                        {duration && (
                          <aside className="research-activity-log-duration">
                            {duration}
                          </aside>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </details>
          )}
        </div>
        )}
      </details>
    </div>
  );
}
