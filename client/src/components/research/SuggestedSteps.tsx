import { Icon } from "../icons";

interface Dataset {
  id: string;
  filename: string;
  description: string;
}

interface SuggestedStep {
  type: string;
  objective: string;
  datasets?: Dataset[];
}

interface Props {
  steps: SuggestedStep[];
  onSelectStep: (step: SuggestedStep, index: number) => void;
  onCustomInput?: () => void;
  disabled?: boolean;
}

export function SuggestedSteps({ steps, onSelectStep, onCustomInput, disabled }: Props) {
  if (!steps || steps.length === 0) return null;

  const getStepConfig = (type: string) => {
    const configs: Record<string, { icon: string; label: string; color: string; bgColor: string }> = {
      LITERATURE: {
        icon: "📚",
        label: "Literature Search",
        color: "var(--task-literature)",
        bgColor: "var(--task-literature-subtle)",
      },
      ANALYSIS: {
        icon: "📊",
        label: "Data Analysis",
        color: "var(--task-analysis)",
        bgColor: "var(--task-analysis-subtle)",
      },
      HYPOTHESIS: {
        icon: "💡",
        label: "Hypothesis Generation",
        color: "var(--task-hypothesis)",
        bgColor: "var(--task-hypothesis-subtle)",
      },
      REFLECTION: {
        icon: "🔍",
        label: "Reflection",
        color: "var(--task-reflection)",
        bgColor: "var(--task-reflection-subtle)",
      },
      PLANNING: {
        icon: "📋",
        label: "Planning",
        color: "var(--task-planning)",
        bgColor: "var(--task-planning-subtle)",
      },
      CODE_EXEC: {
        icon: "💻",
        label: "Code Execution",
        color: "var(--task-code)",
        bgColor: "var(--task-code-subtle)",
      },
    };
    return (
      configs[type] || {
        icon: "⚡",
        label: type,
        color: "var(--task-other)",
        bgColor: "var(--task-other-subtle)",
      }
    );
  };

  return (
    <div className="suggested-steps-container">
      <div className="suggested-steps-header">
        <span className="suggested-steps-icon">🚀</span>
        <span className="suggested-steps-title">Suggested Next Steps</span>
        <span className="suggested-steps-hint">Click to proceed</span>
      </div>

      <div className="suggested-steps-list">
        {steps.map((step, index) => {
          const config = getStepConfig(step.type);
          return (
            <button
              key={index}
              className="suggested-step-card"
              onClick={() => onSelectStep(step, index)}
              disabled={disabled}
              style={{
                "--step-color": config.color,
                "--step-bg": config.bgColor,
              } as React.CSSProperties}
            >
              <div className="suggested-step-header">
                <span className="suggested-step-type-badge">
                  <span className="suggested-step-emoji">{config.icon}</span>
                  {config.label}
                </span>
                <Icon name="send" size={14} className="suggested-step-arrow" />
              </div>

              <p className="suggested-step-objective">{step.objective}</p>

              {step.datasets && step.datasets.length > 0 && (
                <div className="suggested-step-datasets">
                  <Icon name="file" size={12} />
                  <span>
                    {step.datasets.length} dataset{step.datasets.length !== 1 ? "s" : ""}:{" "}
                    {step.datasets.map((d) => d.filename).join(", ")}
                  </span>
                </div>
              )}
            </button>
          );
        })}
      </div>

      {onCustomInput && (
        <button className="suggested-steps-custom" onClick={onCustomInput} disabled={disabled}>
          <Icon name="plus" size={14} />
          <span>Or type your own instruction...</span>
        </button>
      )}
    </div>
  );
}
