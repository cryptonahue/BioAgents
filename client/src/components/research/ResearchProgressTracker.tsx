import { useState, useEffect } from "preact/hooks";
import type { LiteratureSource } from "./EvidenceBySourcePanel";

/**
 * The "🔬 Investigando…" progress card shown at the top of the research panel
 * WHILE a deep-research run is active. It is deliberately NOT the raw `plan`
 * array — that array holds one row per real task (often several literature
 * fan-outs) and reads like a log. This card presents the run as a fixed,
 * human-legible PIPELINE of canonical phases, so the reader sees "where are we"
 * at a glance: the first unfinished phase is running (●), earlier ones are done
 * (✓), later ones are pending (○).
 *
 * Everything here is derived from state the client already polls every 2s
 * (conversationState), so it updates live and — because `startedAt` and the
 * plan live on the server — it survives a page reload mid-run.
 */

interface TrackerPlanStep {
  type: string;
  start?: string;
  end?: string;
  sources?: LiteratureSource[];
}

interface TrackerState {
  plan?: TrackerPlanStep[];
  currentHypothesis?: string;
  keyInsights?: string[];
  discoveries?: string[];
}

interface Props {
  state: TrackerState | null;
  /** ISO timestamp the run started (deepResearchRun.startedAt). Drives the ⏱. */
  startedAt?: string | null;
}

type PhaseStatus = "done" | "running" | "pending";

interface Substep {
  status: LiteratureSource["status"];
  label: string;
  meta: string;
}

interface Phase {
  key: string;
  label: string;
  /** Header subtitle shown while THIS phase is the running one. */
  runningLabel: string;
  status: PhaseStatus;
  /** Right-aligned meta for a finished phase (e.g. "20 fragmentos"). */
  meta?: string;
  substeps?: Substep[];
}

const SOURCE_LABELS: Record<LiteratureSource["sourceName"], string> = {
  KNOWLEDGE: "Base de conocimiento",
  EDISON: "Edison",
  OPENSCHOLAR: "OpenScholar",
  BIOLIT: "BioAgents",
  BIOLITDEEP: "BioAgents Deep",
};

// mm:ss — matches the "0:03" / "1:12" shape of the approved design.
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function substepMeta(source: LiteratureSource): string {
  if (source.status === "ok") return `${source.count} fragmentos`;
  if (source.status === "empty") return "sin resultados";
  return source.error ? "falló" : "no disponible";
}

/**
 * Turn the live research state into the ordered pipeline. Each phase carries a
 * boolean "is it done"; the FIRST phase that is not done becomes the running
 * one and everything after it is pending. `reply` is intentionally never "done"
 * here — this card only renders while the run is active, so the answer has not
 * landed yet, which makes `reply` the natural terminal running phase.
 */
function buildPhases(state: TrackerState | null): Phase[] {
  const plan = state?.plan ?? [];
  const hasType = (t: string) => plan.some((s) => s.type === t);
  const endedOfType = (t: string) => plan.filter((s) => s.type === t && s.end);

  const litSteps = plan.filter((s) => s.type === "LITERATURE");
  const sources = litSteps.flatMap((s) => s.sources ?? []);
  const totalChunks = sources.reduce((acc, s) => acc + (s.count || 0), 0);
  const substeps: Substep[] = sources.map((s) => ({
    status: s.status,
    label: SOURCE_LABELS[s.sourceName] ?? s.sourceName,
    meta: substepMeta(s),
  }));

  const conclusionsCount =
    (state?.keyInsights?.length ?? 0) + (state?.discoveries?.length ?? 0);

  const raw: Array<Omit<Phase, "status"> & { done: boolean }> = [];

  raw.push({
    key: "plan",
    label: "Planificación",
    runningLabel: "El asistente está trabajando en tu pregunta",
    done: plan.length > 0,
  });

  raw.push({
    key: "lit",
    label: "Búsqueda de literatura",
    runningLabel: "Buscando en la biblioteca interna",
    done: endedOfType("LITERATURE").length > 0,
    meta: totalChunks ? `${totalChunks} fragmentos` : undefined,
    substeps: substeps.length ? substeps : undefined,
  });

  if (hasType("ANALYSIS")) {
    raw.push({
      key: "analysis",
      label: "Análisis de datos",
      runningLabel: "Analizando los datos…",
      done: endedOfType("ANALYSIS").length > 0,
    });
  }

  raw.push({
    key: "hyp",
    label: "Formular hipótesis",
    runningLabel: "Formulando hipótesis…",
    done: !!state?.currentHypothesis,
  });

  raw.push({
    key: "concl",
    label: "Extraer conclusiones",
    runningLabel: "Extrayendo conclusiones…",
    done: conclusionsCount > 0,
  });

  raw.push({
    key: "reply",
    label: "Redactar respuesta",
    runningLabel: "Redactando la respuesta…",
    done: false,
  });

  // Assign statuses: done stays done; the first not-done is running; the rest pend.
  let runningTaken = false;
  return raw.map(({ done, ...rest }) => {
    let status: PhaseStatus;
    if (done) status = "done";
    else if (!runningTaken) {
      status = "running";
      runningTaken = true;
    } else status = "pending";
    return { ...rest, status };
  });
}

function glyphFor(status: PhaseStatus): string {
  if (status === "done") return "✓";
  if (status === "running") return "●";
  return "○";
}

function substepGlyph(status: LiteratureSource["status"]): string {
  if (status === "ok") return "✓";
  if (status === "failed") return "⚠";
  return "○";
}

export function ResearchProgressTracker({ state, startedAt }: Props) {
  // Live ⏱ — re-renders every second while mounted (the card only mounts while
  // the run is active, so the interval is naturally short-lived).
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const phases = buildPhases(state);
  const running = phases.find((p) => p.status === "running");

  const startMs = startedAt ? new Date(startedAt).getTime() : NaN;
  const clock = !isNaN(startMs) ? formatClock(now - startMs) : null;

  return (
    <div className="research-progress">
      <div className="research-progress-head">
        <span className="research-progress-emoji" aria-hidden="true">
          🔬
        </span>
        <div className="research-progress-head-text">
          <div className="research-progress-title">Investigando…</div>
          <div className="research-progress-subtitle">
            {running?.runningLabel ??
              "El asistente está trabajando en tu pregunta"}
          </div>
        </div>
        {clock && (
          <span className="research-progress-timer" aria-label="Tiempo transcurrido">
            <span aria-hidden="true">⏱</span> {clock}
          </span>
        )}
      </div>

      <ol className="research-progress-steps">
        {phases.map((p) => (
          <li key={p.key} className={`research-progress-step is-${p.status}`}>
            <div className="research-progress-row">
              <span
                className="research-progress-glyph"
                data-status={p.status}
                aria-hidden="true"
              >
                {glyphFor(p.status)}
              </span>
              <span className="research-progress-label">
                {p.label}
                {p.status === "running" ? "…" : ""}
              </span>
              {p.meta && (
                <span className="research-progress-meta">{p.meta}</span>
              )}
            </div>

            {p.substeps && p.substeps.length > 0 && (
              <ul className="research-progress-substeps">
                {p.substeps.map((sub, i) => (
                  <li
                    key={i}
                    className="research-progress-substep"
                    data-status={sub.status}
                  >
                    <span
                      className="research-progress-glyph"
                      data-substatus={sub.status}
                      aria-hidden="true"
                    >
                      {substepGlyph(sub.status)}
                    </span>
                    <span className="research-progress-label">{sub.label}</span>
                    <span className="research-progress-meta">{sub.meta}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
