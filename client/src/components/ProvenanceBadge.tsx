/**
 * ProvenanceBadge — small focusable pill that signals a fact's
 * provenance type on a fact card. Used in two places:
 *
 *  1. Inline in the lightbox header (handled by EvidenceLightbox)
 *     for `text-only` facts so the user knows the highlight is
 *     missing intentionally.
 *  2. Inline on the evidence pack / library fact cards so the user
 *     can see the badge before clicking, and so the citation card is
 *     keyboard-activatable per the spec's "Citation Click Integration"
 *     requirement.
 *
 * The badge is keyboard-focusable (`tabIndex=0`) and responds to
 * Enter / Space the same as a click. The aria-label follows the
 * spec's "Text-only provenance — click to view source page" wording
 * so screen readers announce the intent.
 *
 * Visual contract:
 *   - Neutral grey background, dark text — informational, not a
 *     warning. The design says it must NOT look alarming.
 *   - Same chip styling for both inline and card-mounted variants;
 *     the parent can opt into the `--card` modifier when rendering
 *     the badge next to the source title.
 */
import { useCallback } from "preact/hooks";

export type ProvenanceBadgeKind = "text-only";

interface ProvenanceBadgeProps {
  kind?: ProvenanceBadgeKind;
  // When provided, clicking / activating the badge opens the
  // provenance lightbox for the given fact id. The component does
  // not know about the ProvenanceContext directly — the parent
  // wires the click handler so the badge can be reused outside the
  // lightbox context.
  onActivate?: () => void;
  // Optional override for the visible label. Defaults to
  // "provenance: text-only" per the spec.
  label?: string;
  // Optional aria-label override. Defaults to the spec's verbatim
  // wording.
  ariaLabel?: string;
  // "inline" = mounted in a toolbar (default); "card" = mounted next
  // to a fact card title. Drives the CSS modifier only.
  variant?: "inline" | "card";
}

const DEFAULT_LABEL = "provenance: text-only";
const DEFAULT_ARIA = "Text-only provenance — click to view source page";

export function ProvenanceBadge({
  kind = "text-only",
  onActivate,
  label,
  ariaLabel,
  variant = "inline",
}: ProvenanceBadgeProps) {
  const handleClick = useCallback(
    (e: MouseEvent) => {
      if (!onActivate) return;
      e.preventDefault();
      e.stopPropagation();
      onActivate();
    },
    [onActivate],
  );

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (!onActivate) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        onActivate();
      }
    },
    [onActivate],
  );

  // Suppress the unused-variable lint without dropping the prop.
  void kind;

  return (
    <span
      className={`provenance-badge provenance-badge--${variant}`}
      role="button"
      tabIndex={onActivate ? 0 : -1}
      aria-label={ariaLabel ?? DEFAULT_ARIA}
      data-provenance-badge
      data-provenance-kind="text-only"
      onClick={handleClick as unknown as JSX.MouseEventHandler<HTMLSpanElement>}
      onKeyDown={handleKey as unknown as JSX.KeyboardEventHandler<HTMLSpanElement>}
    >
      {label ?? DEFAULT_LABEL}
    </span>
  );
}
