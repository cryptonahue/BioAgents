/**
 * CompoundAuthorityBadge — small inline pill that signals a fact's
 * compound authority state on a fact card and inside the evidence
 * lightbox. Introduced in PR #3 of
 * `bioprospecting-compound-authority`.
 *
 * Display rules (mirrors the spec's "Compound Display and Edit Reset"
 * section):
 *
 *   - `compound_authority_status === "skipped"`  → HIDDEN entirely
 *     (extract / mixture — no canonical claim to communicate)
 *   - `compound_authority_status === "failed"`   → small red dot with
 *     `title` showing the last error
 *   - `compound_authority_status === "pending"`  → inline spinner
 *     glyph with `title` "pending PubChem resolution"
 *   - `compound_authority_status === "verified"`
 *     + canonical differs from raw `compound` (case-insensitive
 *     normalized) → render
 *     `"{compound} → {canonical_name}"` badge with `title` showing
 *     InChIKey + PubChem CID
 *   - `verified` but canonical matches raw text → no badge (no diff
 *     to show; the canonical name is the same as the raw text)
 *
 * The component is a leaf in the visual tree — it has no click
 * handler because the editor flow opens the dedicated viewer for
 * full provenance. The InChIKey + PubChem CID details appear in the
 * `title` attribute (browser native tooltip) so the spec's "show
 * InChIKey + PubChem CID" requirement is satisfied without inventing
 * a custom tooltip mechanism.
 */
export type CompoundAuthorityStatus =
  | "pending"
  | "verified"
  | "failed"
  | "skipped";

interface CompoundAuthorityBadgeProps {
  // Raw text from the fact (the editor's authoritative string).
  compound: string | null | undefined;
  // Canonical id; null when the value is unresolved.
  compoundCanonicalId: string | null | undefined;
  // Authority state from the fact row.
  compoundAuthorityStatus:
    | CompoundAuthorityStatus
    | string
    | null
    | undefined;
  // Last error message (e.g. "pubchem 404 not found"). Only used
  // when status is "failed" — surfaces in the native tooltip.
  compoundAuthorityError?: string | null;
  // Canonical display name (e.g. "Curcumin"). Required to render
  // the "→ canonical" badge on verified rows.
  canonicalName?: string | null;
  // InChIKey — surfaced in the title attribute on verified rows.
  inchiKey?: string | null;
  // PubChem CID — surfaced in the title attribute on verified rows.
  pubchemCid?: number | null;
  // Visual variant. "card" = next to fact card title;
  // "inline" = inside a toolbar.
  variant?: "inline" | "card";
  // Optional override for the title attribute (the native tooltip).
  title?: string;
}

/**
 * Lower-cased, NFKD-normalized comparison used to decide whether the
 * canonical name differs from the raw compound text. The function is
 * intentionally lightweight — it's only used to decide whether to
 * render the badge at all.
 */
function normalizeForBadge(value: string | null | undefined): string {
  if (!value || typeof value !== "string") return "";
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function computeTitle(args: {
  explicit?: string;
  status: CompoundAuthorityStatus;
  error?: string | null;
  inchiKey?: string | null;
  pubchemCid?: number | null;
  canonicalName?: string | null;
}): string {
  if (args.explicit) return args.explicit;
  if (args.status === "failed") {
    return args.error
      ? `Authority failed: ${args.error}`
      : "Authority resolution failed";
  }
  if (args.status === "pending") {
    return "Pending PubChem resolution";
  }
  // verified
  const parts: string[] = [];
  if (args.inchiKey) parts.push(`InChIKey: ${args.inchiKey}`);
  if (args.pubchemCid != null) parts.push(`PubChem CID: ${args.pubchemCid}`);
  if (parts.length === 0)
    return `Resolved to ${args.canonicalName ?? "canonical"}`;
  return parts.join(" · ");
}

export function CompoundAuthorityBadge({
  compound,
  compoundCanonicalId,
  compoundAuthorityStatus,
  compoundAuthorityError,
  canonicalName,
  inchiKey,
  pubchemCid,
  variant = "inline",
  title,
}: CompoundAuthorityBadgeProps) {
  const status = (compoundAuthorityStatus ?? "pending") as CompoundAuthorityStatus;

  // Extracts (skipped) get no badge — the spec's design rule.
  if (status === "skipped") return null;

  // Verified rows with no canonical id are degenerate; hide.
  if (status === "verified" && !compoundCanonicalId && !canonicalName) {
    return null;
  }

  // Verified rows where the canonical matches the raw text verbatim
  // (after normalization) don't communicate a diff — hide the badge
  // to reduce visual noise.
  if (status === "verified" && canonicalName) {
    const sameText =
      normalizeForBadge(compound) === normalizeForBadge(canonicalName);
    if (sameText) return null;
  }

  const computedTitle = computeTitle({
    explicit: title,
    status,
    error: compoundAuthorityError,
    inchiKey,
    pubchemCid,
    canonicalName,
  });

  if (status === "failed") {
    return (
      <span
        className={`compound-authority-badge compound-authority-badge--failed compound-authority-badge--${variant}`}
        data-compound-authority-status="failed"
        data-compound-authority-error={compoundAuthorityError ?? ""}
        title={computedTitle}
        aria-label={`Compound authority failed${compoundAuthorityError ? `: ${compoundAuthorityError}` : ""}`}
      >
        <span className="compound-authority-badge__dot" aria-hidden="true" />
        <span className="compound-authority-badge__label">authority failed</span>
      </span>
    );
  }

  if (status === "pending") {
    return (
      <span
        className={`compound-authority-badge compound-authority-badge--pending compound-authority-badge--${variant}`}
        data-compound-authority-status="pending"
        title={computedTitle}
        aria-label="Compound authority pending"
      >
        <span className="compound-authority-badge__spinner" aria-hidden="true" />
        <span className="compound-authority-badge__label">resolving…</span>
      </span>
    );
  }

  // verified
  const rawText = (compound ?? "").trim();
  return (
    <span
      className={`compound-authority-badge compound-authority-badge--verified compound-authority-badge--${variant}`}
      data-compound-authority-status="verified"
      data-compound-canonical-id={compoundCanonicalId ?? ""}
      data-compound-canonical-name={canonicalName ?? ""}
      title={computedTitle}
      aria-label={`Compound authority verified${canonicalName ? `: resolved to ${canonicalName}` : ""}`}
    >
      {rawText ? <span className="compound-authority-badge__raw">{rawText}</span> : null}
      {rawText ? <span className="compound-authority-badge__arrow" aria-hidden="true">→</span> : null}
      <span className="compound-authority-badge__canonical">
        {canonicalName ?? "(canonical)"}
      </span>
    </span>
  );
}
