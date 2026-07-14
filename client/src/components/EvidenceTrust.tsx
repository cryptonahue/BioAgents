/**
 * How much can the user trust this citation? Three states, one place.
 *
 * The viewer and the lightbox both answer this question, and they must never
 * answer it differently — so they answer it here.
 *
 * WHY THIS EXISTS
 *
 * Anchoring every extracted quote against the PDF's text layer at ingestion
 * turned out to do more than locate it. A quote that is NOT IN THE PAPER is a
 * fabricated citation, and it is indistinguishable from a real one at every
 * other layer of this system: the extractor produced it, the database stored
 * it, the chat cited it, and nothing anywhere could tell. On the test corpus
 * the assistant invented one fact's quote in twenty-five, and paraphrased one
 * claim in twelve.
 *
 * We can see that now. The only question left was whether to say it.
 *
 * A product whose business is evidence has to be able to tell a user "my own
 * assistant made this up" — before they find out on their own, and while they
 * still trust the rest. Hiding it does not make the citation better; it makes
 * every OTHER citation worse, because the user has no way to know which is
 * which.
 *
 * So we say it. Plainly, on the citation, in the moment they are deciding
 * whether to believe us.
 */
import { BBox } from "../lib/bbox";

export type TrustLevel = "verbatim" | "approximate" | "not-found";

/**
 * `bbox`     — where the quote was found in the PDF, or null if it was not.
 * `verbatim` — whether it was found word for word.
 */
export function trustOf(
  bbox: BBox | null | undefined,
  verbatim: boolean | null | undefined,
): TrustLevel {
  if (!bbox) return "not-found";
  return verbatim ? "verbatim" : "approximate";
}

const COPY: Record<
  TrustLevel,
  { icon: string; label: string; detail: string }
> = {
  verbatim: {
    icon: "✓",
    label: "Verbatim",
    detail: "This sentence appears in the paper exactly as quoted.",
  },
  approximate: {
    icon: "~",
    label: "Approximate",
    detail:
      "The highlighted passage is the right one, but the assistant reworded it. Read the paper's own wording below.",
  },
  "not-found": {
    icon: "!",
    label: "Not found in this paper",
    detail:
      "This quote does not appear in the PDF. The assistant may have paraphrased or invented it — treat the citation with caution. No highlight is shown, because there is nothing we can honestly point at.",
  },
};

interface TrustBadgeProps {
  level: TrustLevel;
  /** Shown alongside the label when we know it. */
  page?: number | null;
  className?: string;
}

/** The compact badge: the verdict, and the page when there is one. */
export function TrustBadge({ level, page, className }: TrustBadgeProps) {
  const { icon, label } = COPY[level];
  return (
    <span
      className={`evidence-trust evidence-trust--${level} ${className ?? ""}`.trim()}
      data-trust={level}
      title={COPY[level].detail}
    >
      <span className="evidence-trust__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="evidence-trust__label">{label}</span>
      {level !== "not-found" && page ? (
        <span className="evidence-trust__page">· p.{page}</span>
      ) : null}
    </span>
  );
}

/**
 * The full explanation. Shown where the user is actually deciding whether to
 * believe the citation — never hidden behind a tooltip when the answer is
 * "not-found", because that is the one they most need to read.
 */
export function TrustNote({ level }: { level: TrustLevel }) {
  if (level === "verbatim") return null; // nothing to explain; get out of the way
  return (
    <p className={`evidence-trust-note evidence-trust-note--${level}`}>
      {COPY[level].detail}
    </p>
  );
}

/** Counts for the "11 verbatim · 1 approximate · 0 not found" summary. */
export function trustSummary(
  items: Array<{ bbox?: BBox | null; verbatim?: boolean | null }>,
): Record<TrustLevel, number> {
  const out: Record<TrustLevel, number> = {
    verbatim: 0,
    approximate: 0,
    "not-found": 0,
  };
  for (const item of items) out[trustOf(item.bbox, item.verbatim)]++;
  return out;
}
