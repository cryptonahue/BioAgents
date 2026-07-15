/**
 * ONE home for how this system cites evidence.
 *
 * The rule — "cite the internal link we can OPEN, not the DOI we cannot CHECK"
 * — used to live in three files that disagreed with each other:
 *
 *   agents/reply/prompts.ts        "citations MUST be DOI URLs: (claim)[https://doi.org/…]"
 *   researchBrain/search.ts        "CITE WITH THE INTERNAL LINK, NOT THE DOI"
 *   researchBrain/verifier.ts      "include DOI when available" AND "prefer the internal link"
 *
 * The verifier's prompt literally asked for both at once, so the model did the
 * easier one — it kept the draft's DOIs. Eight passages anchored to the PDF,
 * their internal links sat in the evidence pack, and every citation still
 * pointed at doi.org. A policy with no owner is a policy nobody follows.
 *
 * So the policy lives here now, stated once, and everything that cites reads it
 * from this file. When the rule changes, it changes in one place.
 *
 * WHY INTERNAL OVER DOI. A doi.org link is a promise: "trust me, it is in
 * there." An internal link opens our copy of the PDF, on the anchored page,
 * with the sentence boxed and a verdict beside it. It is the only citation this
 * system can stand behind, because it is the only one it can verify. When a
 * passage did not anchor, we have no such proof, so we fall back to the DOI and
 * say the location could not be verified — we never fabricate a link.
 *
 * WHY THE MODEL NEVER WRITES THE LINK. An internal link is an opaque string:
 * `/library/<base64 title>/viewer#bbox=<four floats>&page=<n>&type=chunk`. We
 * asked the model to reproduce it and it could not — it typed "marinindugs"
 * for "marinedrugs", prepended "https://", and dropped the bbox. TWICE, on two
 * different code paths. A language model cannot reliably transcribe an opaque
 * string; it regenerates one that looks right and corrupts the part that must
 * be exact.
 *
 * So the model never sees the link and never writes it. Each anchored passage
 * is shown with a short TOKEN — {P1}, {P2}, … — and the model cites the token.
 * After generation, `resolvePassageTokens` swaps each token for the real link,
 * deterministically, in code. You cannot corrupt a base64 you were never given.
 */
import type { EvidencePackPassage } from "../types";

/** The token a model uses to cite passage i (1-based): {P1}, {P2}, … */
export function passageToken(index1Based: number): string {
  return `{P${index1Based}}`;
}

/**
 * The canonical citation instruction. Every prompt that asks a model to cite
 * evidence includes this verbatim. The model cites by TOKEN, never by URL.
 */
export const INTERNAL_CITATION_RULE = [
  "CITATION RULE (single source of truth — follow it exactly):",
  "- Cite a passage by its TOKEN, exactly as shown next to it: [short label]{P1}, [short label]{P2}, and so on. The system replaces the token with a link that opens our copy of the PDF on the anchored page with the sentence boxed.",
  "- NEVER write a URL, a /library/ path, a bbox, a page number, or a fragment id yourself. You do not have the link and you cannot reconstruct it — if you type it by hand you WILL corrupt it. Write ONLY the token.",
  "- The [short label] is a few DESCRIPTIVE words in the answer's own language, like a normal inline citation (e.g. [mayor riqueza en agua de cría]). NEVER paste the whole passage into the brackets, and NEVER use the token id itself as the label — do not write [P9]{P9}. The label describes the fact; the token points at the evidence.",
  "- Prefer a passage token over a DOI for every claim a passage supports. Do NOT keep a doi.org link when a passage token for the same fact is available — cite the token instead.",
  "- Only for a source with NO passage token here (it did not anchor): cite its DOI as [short label]{https://doi.org/…} and say the exact location could not be verified.",
  "- Never invent a token, a link, a page, or a section number. Cite only tokens shown below or a real DOI from the pack.",
].join("\n");

/**
 * Render the anchored passages as a prompt block: the paper's own words, each
 * tagged with the token the model must cite it by. The real link is NOT shown —
 * that is the whole point. Shared by `formatEvidencePackForPrompt` and any agent
 * that gets the passages directly, so the two never drift apart.
 */
export function renderPassageBlock(
  passages: EvidencePackPassage[] | undefined,
): string[] {
  if (!passages || passages.length === 0) return [];

  const lines: string[] = [];
  lines.push("");
  lines.push(
    `Passages from the loaded papers (${passages.length}) — the source text itself, quote from these:`,
  );
  lines.push(INTERNAL_CITATION_RULE);

  passages.forEach((p, i) => {
    const sim =
      p.similarity != null ? ` (relevance ${p.similarity.toFixed(2)})` : "";
    const where = p.page != null ? `, p.${p.page}` : "";
    const tag = p.citation
      ? `cite as ${passageToken(i + 1)}`
      : "no token — did not anchor, cite the DOI and say so";
    lines.push(
      `[passage ${i + 1} · ${tag}] ${p.sourceTitle ?? "unknown source"}${where}${sim}`,
    );
    lines.push(`"${p.content.replace(/\s+/g, " ").trim()}"`);
  });

  return lines;
}

/**
 * Swap each {Pn} token in a model's output for the real internal link of
 * passage n. Deterministic and total: the model supplies the token and the
 * label, the code supplies the opaque string it could never type correctly.
 *
 * Tolerant of the shapes a model actually emits — {P1}, { p1 }, {P 1} — and
 * leaves anything it cannot resolve (a token past the end, a passage with no
 * link) untouched rather than inventing a target.
 */
export function resolvePassageTokens(
  text: string,
  passages: EvidencePackPassage[] | undefined,
): string {
  if (!text || !passages || passages.length === 0) return text;
  const resolved = text.replace(/\{\s*[Pp]\s*(\d+)\s*\}/g, (whole, digits) => {
    const idx = Number(digits) - 1;
    const link = passages[idx]?.citation;
    return link ? `{${link}}` : whole;
  });
  return collapseDuplicateCitations(cleanTokenIdLabels(resolved));
}

/**
 * Repair citations whose visible label is just the token id — [P9]{link}. The
 * model is told to write a descriptive label and usually does, but sometimes it
 * echoes the token as the label instead, which reaches the reader as a bare
 * "[P9]". Replace that label with a page reference pulled from the link, so a
 * slip degrades to "[fuente, p.2]" instead of a meaningless id.
 */
/**
 * Rewrite DOI citations to an internal paper-level link, for output that is
 * SYNTHESIS rather than quotation — the reflection agent's Key Insights. Those
 * are paper-level summaries, so they get a paper-level link ( /library/<docId>/
 * viewer, no bbox ) that opens our copy of the paper, keeping them consistent
 * with the rest of the answer instead of pointing out to doi.org.
 *
 * Only safe to call when the whole answer is scoped to one paper (docId), since
 * every DOI citation then refers to that same paper. Handles both the
 * "(label)[doi]" and bare "[doi]" shapes the reflection agent emits.
 */
export function rewriteDoiToPaperLink(
  text: string,
  docId: string | null | undefined,
): string {
  if (!text || !docId) return text;
  const link = `/library/${docId}/viewer`;
  return (
    text
      // (label)[doi] → keep the label
      .replace(
        /\(([^)]+)\)\s*\[\s*https?:\/\/doi\.org\/[^\]]+\]/gi,
        (_whole, label) => `[${label}]{${link}}`,
      )
      // (https://doi.org/…) — the DOI wrapped in plain parentheses, the shape the
      // reflection agent emits for Key Insights. Without this the insights stayed
      // on doi.org while everything else went internal.
      .replace(/\(\s*https?:\/\/doi\.org\/[^)\s]+\s*\)/gi, `[fuente]{${link}}`)
      // bare [doi]
      .replace(/\[\s*https?:\/\/doi\.org\/[^\]]+\]/gi, `[fuente]{${link}}`)
  );
}

export function cleanTokenIdLabels(text: string): string {
  if (!text) return text;
  return text.replace(
    /\[[Pp]\d+\](\{\/library\/[^}]+\})/g,
    (_whole, link) => {
      const page = /[?&#]page=(\d+)/.exec(link)?.[1];
      return `[fuente${page ? `, p.${page}` : ""}]${link}`;
    },
  );
}

/**
 * Collapse a citation link immediately repeated after itself — {link}{link} —
 * down to one. The model cites the same token twice ({P1}{P1}); once resolved
 * that is two identical clickable links back to back, which is noise, not two
 * pieces of evidence. Matches an optional space between the pair.
 */
export function collapseDuplicateCitations(text: string): string {
  if (!text) return text;
  // A citation unit is an optional [label] plus a {link}. The model cites the
  // same passage token twice, which reaches here as either {link}{link} or the
  // whole unit repeated — [x]{link} [x]{link}. Collapse a unit immediately
  // repeated after itself (runs of any length, whitespace between) to one.
  const unit =
    /((?:\[[^\]]*\])?\{(?:\/library\/|https?:\/\/)[^}]+\})(\s*\1)+/g;
  return text.replace(unit, "$1");
}
