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

export type TrustLevel =
  | "verbatim"
  | "approximate"
  | "not-found"
  | "not-verified";

/**
 * `bbox`     — where the quote was found in the PDF, or null if it was not.
 * `verbatim` — whether it was found word for word.
 */
export function trustOf(
  bbox: BBox | null | undefined,
  verbatim: boolean | null | undefined,
  /**
   * When the source was last anchored. REQUIRED to tell the two failures
   * apart, because both look like a NULL bbox:
   *
   *   anchored, no bbox  ->  the quote is NOT IN THE PAPER. A fabrication.
   *   never anchored     ->  we have not looked. We do not know.
   *
   * This shipped conflating them, and every claim of a freshly uploaded paper
   * was accused of being invented — a confident verdict about something never
   * checked, which is the exact failure this feature exists to prevent.
   *
   * Absent this timestamp we say "not verified". Never "not found".
   */
  anchoredAt?: string | null,
): TrustLevel {
  if (bbox) return verbatim ? "verbatim" : "approximate";
  return anchoredAt ? "not-found" : "not-verified";
}

const COPY: Record<
  TrustLevel,
  { icon: string; label: string; detail: string }
> = {
  "not-verified": {
    icon: "?",
    label: "Not verified",
    detail:
      "We have not yet checked this quote against the PDF. That is our gap, not a judgement on the citation.",
  },
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
  anchoredAt?: string | null,
): Record<TrustLevel, number> {
  const out: Record<TrustLevel, number> = {
    verbatim: 0,
    approximate: 0,
    "not-found": 0,
    "not-verified": 0,
  };
  for (const item of items)
    out[trustOf(item.bbox, item.verbatim, anchoredAt)]++;
  return out;
}

/**
 * The one-line explanation for a whole panel.
 *
 * The per-card note was repeated on every claim, and on an unverified paper
 * that meant eight identical four-line warnings stacked in a 225px column — a
 * wall of red that buries the very thing it is trying to say. Say it ONCE,
 * above the list, and let the badges carry the rest.
 */
export function TrustSummary({
  counts,
}: {
  counts: Record<TrustLevel, number>;
}) {
  const levels: TrustLevel[] = [
    "verbatim",
    "approximate",
    "not-found",
    "not-verified",
  ];
  const present = levels.filter((l) => counts[l] > 0);
  if (present.length === 0) return null;

  // Lead with the worst news. A user scanning this panel needs the problem
  // before the reassurance.
  const worst =
    (counts["not-found"] > 0 && "not-found") ||
    (counts["not-verified"] > 0 && "not-verified") ||
    (counts.approximate > 0 && "approximate") ||
    null;

  return (
    <div className="viewer-page__trust-summary">
      <div className="viewer-page__trust-counts">
        {present.map((level) => (
          <span key={level} className="viewer-page__trust-count">
            <TrustBadge level={level} />
            <span className="viewer-page__trust-n">{counts[level]}</span>
          </span>
        ))}
      </div>
      {worst ? <TrustNote level={worst as TrustLevel} /> : null}
    </div>
  );
}
