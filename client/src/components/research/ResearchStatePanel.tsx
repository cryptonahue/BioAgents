import { useState, useEffect } from "preact/hooks";
import { Icon } from "../icons";
import { ArtifactViewer } from "./ArtifactViewer";
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

interface ResearchState {
  plan?: PlanStep[];
  discoveries?: string[];
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
  };
}

interface Props {
  state: ResearchState | null;
  isExpanded?: boolean;
  onToggle?: () => void;
  isLoading?: boolean;
}

export function ResearchStatePanel({
  state,
  isExpanded = false,
  onToggle,
  isLoading = false,
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
    const types: Record<
      string,
      { label: string; icon: string; color: string }
    > = {
      LITERATURE: { label: "Literature Search", icon: "📚", color: "#8b5cf6" },
      ANALYSIS: { label: "Data Analysis", icon: "📊", color: "#06b6d4" },
      HYPOTHESIS: { label: "Hypothesis", icon: "💡", color: "#f59e0b" },
      REFLECTION: { label: "Reflection", icon: "🔍", color: "#10b981" },
      PLANNING: { label: "Planning", icon: "📋", color: "#3b82f6" },
    };
    return types[type] || { label: type, icon: "⚡", color: "#6b7280" };
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
    return parts.map((part, i) =>
      part.type === "link" ? (
        <a
          key={i}
          href={part.url}
          target="_blank"
          rel="noopener noreferrer"
          className="research-citation-link"
        >
          {part.text}
        </a>
      ) : (
        <span key={i}>{part.content}</span>
      ),
    );
  };

  const completedSteps = state?.plan?.filter((step) => step.end) || [];
  const currentStep = state?.plan?.find((step) => step.start && !step.end);

  // Show loading state when deep research is starting but no state yet
  const showLoadingState = isLoading && (!state || !state.currentObjective);

  return (
    <div className={`research-state-panel ${isExpanded ? "expanded" : ""}`}>
      <button className="research-state-header" onClick={onToggle}>
        <div className="research-state-header-left">
          <span className="research-state-icon">🧬</span>
          <span className="research-state-title">Research State</span>
        </div>
        <div className="research-state-header-right">
          <Icon
            name="chevronDown"
            size={16}
            className={`research-state-chevron ${isExpanded ? "expanded" : ""}`}
          />
        </div>
      </button>

      {isExpanded && (
        <div className="research-state-content">
          {/* Loading State */}
          {showLoadingState && (
            <div className="research-section research-loading-state">
              <div className="research-loading-indicator">
                <span className="research-step-spinner" />
                <span className="research-loading-text">Initializing deep research...</span>
              </div>
            </div>
          )}

          {/* Current Objective */}
          {state?.currentObjective && (
            <div className="research-section research-current-objective">
              <div className="research-section-label">
                <span className="research-section-icon">🎯</span>
                Current Objective
              </div>
              <p className="research-objective-text">
                {state?.currentObjective}
              </p>
            </div>
          )}

          {state?.researchBrainEvidence && (
            <div className="research-section">
              <button
                className="research-section-toggle"
                onClick={() => toggleSection("brain")}
              >
                <div className="research-section-toggle-left">
                  <Icon name="brainCircuit" size={14} />
                  <span>Research Brain Evidence</span>
                </div>
                <Icon
                  name="chevronDown"
                  size={14}
                  className={`research-section-chevron ${expandedSections.brain ? "expanded" : ""}`}
                />
              </button>
              {expandedSections.brain && (
                <div className="research-section-body">
                  <ul className="research-insights-list">
                    {[
                      ...(state.researchBrainEvidence.supportedClaims || []),
                      ...(state.researchBrainEvidence.partialClaims || []),
                      ...(state.researchBrainEvidence.contradictions || []),
                      ...(state.researchBrainEvidence.openQuestions || []),
                    ].slice(0, 6).map((claim, i) => (
                      <li key={i} className="research-insight-item">
                        <strong>{claim.status || "evidence"}:</strong>{" "}
                        {claim.claim}
                        {claim.sourceTitle ? ` (${claim.sourceTitle})` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Hypothesis */}
          {state?.currentHypothesis && (
            <div className="research-section">
              <button
                className="research-section-toggle"
                onClick={() => toggleSection("hypothesis")}
              >
                <div className="research-section-toggle-left">
                  <span className="research-section-icon">💡</span>
                  <span>Hypothesis</span>
                </div>
                <Icon
                  name="chevronDown"
                  size={14}
                  className={`research-section-chevron ${expandedSections.hypothesis ? "expanded" : ""}`}
                />
              </button>
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
            </div>
          )}

          {/* Discoveries */}
          {state?.discoveries && state.discoveries.length > 0 && (
            <div className="research-section">
              <button
                className="research-section-toggle"
                onClick={() => toggleSection("discoveries")}
              >
                <div className="research-section-toggle-left">
                  <span className="research-section-icon">🔬</span>
                  <span>Discoveries ({state.discoveries.length})</span>
                </div>
                <Icon
                  name="chevronDown"
                  size={14}
                  className={`research-section-chevron ${expandedSections.discoveries ? "expanded" : ""}`}
                />
              </button>
              {expandedSections.discoveries && (
                <div className="research-section-body">
                  <ul className="research-discoveries-list">
                    {state.discoveries.map((discovery, i) => (
                      <li key={i} className="research-discovery-item">
                        {renderCitationText(discovery)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Key Insights */}
          {state?.keyInsights && state.keyInsights.length > 0 && (
            <div className="research-section">
              <button
                className="research-section-toggle"
                onClick={() => toggleSection("insights")}
              >
                <div className="research-section-toggle-left">
                  <span className="research-section-icon">✨</span>
                  <span>Key Insights ({state.keyInsights.length})</span>
                </div>
                <Icon
                  name="chevronDown"
                  size={14}
                  className={`research-section-chevron ${expandedSections.insights ? "expanded" : ""}`}
                />
              </button>
              {expandedSections.insights && (
                <div className="research-section-body">
                  <ul className="research-insights-list">
                    {state.keyInsights.map((insight, i) => (
                      <li key={i} className="research-insight-item">
                        {renderCitationText(insight)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Methodology */}
          {state?.methodology && (
            <div className="research-section">
              <button
                className="research-section-toggle"
                onClick={() => toggleSection("methodology")}
              >
                <div className="research-section-toggle-left">
                  <span className="research-section-icon">🔬</span>
                  <span>Methodology</span>
                </div>
                <Icon
                  name="chevronDown"
                  size={14}
                  className={`research-section-chevron ${expandedSections.methodology ? "expanded" : ""}`}
                />
              </button>
              {expandedSections.methodology && (
                <div className="research-section-body">
                  <p className="research-methodology-text">
                    {state?.methodology}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Uploaded Datasets */}
          {state?.uploadedDatasets && state.uploadedDatasets.length > 0 && (
            <div className="research-section">
              <button
                className="research-section-toggle"
                onClick={() => toggleSection("datasets")}
              >
                <div className="research-section-toggle-left">
                  <span className="research-section-icon">📁</span>
                  <span>Datasets ({state.uploadedDatasets.length})</span>
                </div>
                <Icon
                  name="chevronDown"
                  size={14}
                  className={`research-section-chevron ${expandedSections.datasets ? "expanded" : ""}`}
                />
              </button>
              {expandedSections.datasets && (
                <div className="research-section-body">
                  <div className="research-datasets-list">
                    {state.uploadedDatasets.map((dataset) => (
                      <div key={dataset.id} className="research-dataset-item">
                        <Icon name="file" size={14} />
                        <div className="research-dataset-info">
                          <span className="research-dataset-name">
                            {dataset.filename}
                          </span>
                          <span className="research-dataset-description">
                            {dataset.description}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Completed Steps */}
          {completedSteps.length > 0 && (
            <div className="research-section">
              <button
                className="research-section-toggle"
                onClick={() => toggleSection("plan")}
              >
                <div className="research-section-toggle-left">
                  <span className="research-section-icon">✅</span>
                  <span>Completed Steps ({completedSteps.length})</span>
                </div>
                <Icon
                  name="chevronDown"
                  size={14}
                  className={`research-section-chevron ${expandedSections.plan ? "expanded" : ""}`}
                />
              </button>
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
                              className="research-step-type"
                              style={{
                                background: `${stepInfo.color}15`,
                                color: stepInfo.color,
                              }}
                            >
                              <span className="research-step-emoji">
                                {stepInfo.icon}
                              </span>
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
                                  className="research-step-dataset-badge"
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
                                  className="research-step-output-toggle"
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
            </div>
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
            <div className="research-section research-activity-log">
              <button
                className="research-activity-log-header"
                onClick={() => toggleSection("activityLog")}
              >
                <span className="research-section-label">
                  <span className="research-activity-log-icon">📋</span>
                  Activity Log ({state.plan.filter(s => s.end).length}/{state.plan.length} done)
                </span>
                <Icon
                  name="chevronDown"
                  size={14}
                  className={`research-section-chevron ${expandedSections.activityLog ? "expanded" : ""}`}
                />
              </button>
              {expandedSections.activityLog && (
                <div className="research-activity-log-list">
                  {state.plan.map((step, idx) => {
                    const stepInfo = formatStepType(step.type);
                    const isCurrent = currentStep === step;
                    const isDone = !!step.end;
                    const duration = computeDuration(step.start, step.end, isCurrent);
                    return (
                      <div
                        key={idx}
                        className={`research-activity-log-item ${isCurrent ? "current" : ""} ${isDone ? "done" : ""}`}
                      >
                        <span className="research-activity-log-icon">
                          {isCurrent ? "⏳" : isDone ? "✓" : stepInfo.icon}
                        </span>
                        <span className="research-activity-log-type">
                          {stepInfo.label}
                        </span>
                        {duration && (
                          <span className="research-activity-log-duration">
                            {duration}
                          </span>
                        )}
                        <span className="research-activity-log-objective">
                          {step.objective?.slice(0, 80)}
                          {step.objective && step.objective.length > 80 ? "…" : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
