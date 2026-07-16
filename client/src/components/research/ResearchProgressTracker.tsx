import { useState, useEffect } from "preact/hooks";
import { Icon } from "../icons";
import {
  SOURCE_META,
  statusGlyph,
  type LiteratureSource,
} from "./EvidenceBySourcePanel";

/**
 * The in-progress research card shown at the top of the research panel WHILE a
 * deep-research run is active. It is deliberately NOT the raw `plan` array —
 * that array holds one row per real task (often several literature fan-outs)
 * and reads like a log. This card presents the run as a fixed, human-legible
 * PIPELINE of canonical phases, so the reader sees "where are we" at a glance:
 * the first unfinished phase is running, earlier ones are done, later ones pend.
 *
 * Everything here is derived from state the client already polls every 2s
 * (conversationState) and from `startedAt`, both of which live on the server —
 * so it updates live AND survives a page reload mid-run.
 *
 * It is built from Basecoat's `.item` row (figure / section / aside), the same
 * component the Activity Log wears, and every glyph is a Phosphor `Icon` — no
 * emoji, so nothing depends on a system emoji font being installed.
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
  /** ISO timestamp the run started (deepResearchRun.startedAt). Drives the timer. */
  startedAt?: string | null;
  /** The server's live activity (values.currentActivity). Its label is the real-
   *  time "what is happening now" — especially during the slow synthesis tail
   *  (Synthesizing findings → Drafting response) where the derived phase alone
   *  sits on one step. When present it drives the header subtitle. */
  activity?: { label?: string; objective?: string } | null;
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
  /** Right-aligned meta for a finished phase (e.g. "20 chunks"). */
  meta?: string;
  substeps?: Substep[];
}

// mm:ss — a compact elapsed clock ("0:03", "1:12").
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function substepMeta(source: LiteratureSource): string {
  if (source.status === "ok") return `${source.count} chunks`;
  if (source.status === "empty") return "no matches";
  return source.error ? "failed" : "unavailable";
}

/** The icon + color for a phase glyph, mirroring the Activity Log's state hues. */
function phaseGlyph(status: PhaseStatus): { icon: string; color: string } {
  if (status === "done")
    return { icon: "checkCircle", color: "var(--success)" };
  if (status === "running") return { icon: "spinner", color: "var(--info)" };
  return { icon: "circle", color: "var(--text-tertiary)" };
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
    label: SOURCE_META[s.sourceName]?.label ?? s.sourceName,
    meta: substepMeta(s),
  }));

  const conclusionsCount =
    (state?.keyInsights?.length ?? 0) + (state?.discoveries?.length ?? 0);

  const raw: Array<Omit<Phase, "status"> & { done: boolean }> = [];

  raw.push({
    key: "plan",
    label: "Planning",
    runningLabel: "Working on your question",
    done: plan.length > 0,
  });

  raw.push({
    key: "lit",
    label: "Literature search",
    runningLabel: "Searching the internal library",
    done: endedOfType("LITERATURE").length > 0,
    meta: totalChunks ? `${totalChunks} chunks` : undefined,
    substeps: substeps.length ? substeps : undefined,
  });

  if (hasType("ANALYSIS")) {
    raw.push({
      key: "analysis",
      label: "Data analysis",
      runningLabel: "Analyzing the data",
      done: endedOfType("ANALYSIS").length > 0,
    });
  }

  raw.push({
    key: "hyp",
    label: "Hypothesis",
    runningLabel: "Formulating a hypothesis",
    done: !!state?.currentHypothesis,
  });

  raw.push({
    key: "concl",
    label: "Conclusions",
    runningLabel: "Drawing conclusions",
    done: conclusionsCount > 0,
  });

  raw.push({
    key: "reply",
    label: "Answer",
    runningLabel: "Writing the answer",
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

export function ResearchProgressTracker({ state, startedAt, activity }: Props) {
  // Live timer — re-renders every second while mounted (the card only mounts
  // while the run is active, so the interval is naturally short-lived).
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
    <div className="card research-progress">
      <div className="research-progress-head">
        <figure className="research-progress-head-icon">
          <Icon name="flask" size={16} />
        </figure>
        <section className="research-progress-head-text">
          <h4 className="research-progress-title">Researching…</h4>
          <p className="research-progress-subtitle">
            {activity?.label || running?.runningLabel || "Working on your question"}
          </p>
        </section>
        {clock && (
          <aside
            className="research-progress-timer"
            aria-label="Elapsed time"
          >
            {clock}
          </aside>
        )}
      </div>

      <div className="item-group research-progress-steps">
        {phases.map((p) => {
          const glyph = phaseGlyph(p.status);
          return [
            <div
              key={p.key}
              className={`item research-progress-step ${p.status}`}
              data-variant="outline"
              data-size="xs"
            >
              <figure
                className="research-progress-glyph"
                style={{ color: glyph.color }}
              >
                <Icon
                  name={glyph.icon}
                  size={13}
                  className={
                    p.status === "running"
                      ? "research-progress-spin"
                      : undefined
                  }
                />
              </figure>
              <section>
                <h4 className="research-progress-step-label">{p.label}</h4>
              </section>
              {p.meta && (
                <aside className="research-progress-meta">{p.meta}</aside>
              )}
            </div>,
            ...(p.substeps ?? []).map((sub, i) => {
              const sg = statusGlyph(sub.status);
              return (
                <div
                  key={`${p.key}-sub-${i}`}
                  className="item research-progress-substep"
                  data-variant="outline"
                  data-size="xs"
                >
                  <figure
                    className="research-progress-glyph"
                    style={{ color: sg.color }}
                  >
                    <Icon name={sg.icon} size={12} />
                  </figure>
                  <section>
                    <h4 className="research-progress-step-label">
                      {sub.label}
                    </h4>
                  </section>
                  <aside className="research-progress-meta">{sub.meta}</aside>
                </div>
              );
            }),
          ];
        })}
      </div>
    </div>
  );
}
