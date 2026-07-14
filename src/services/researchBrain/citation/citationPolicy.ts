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
 */
import type { EvidencePackPassage } from "../types";

/**
 * The canonical citation instruction. Every prompt that asks a model to cite
 * evidence includes this verbatim. It is deliberately unambiguous: internal
 * link when we have one, DOI only when we do not, and never an invented link.
 */
export const INTERNAL_CITATION_RULE = [
  "CITATION RULE (single source of truth — follow it exactly):",
  "- When a passage carries an internal link, cite it with that link: [cited text]{<internal link>}. This is the ONLY citation the system can verify, because it opens our copy of the PDF on the anchored page with the sentence boxed.",
  "- Prefer the internal link over the DOI for every claim that a passage supports. Do NOT keep a doi.org link when an internal link for the same source is available — replace it.",
  "- A passage with NO internal link did not anchor to the PDF: cite its DOI with [cited text]{https://doi.org/…} and say the exact location could not be verified.",
  "- Never invent, guess, or fabricate a link, a page, a section number, or a fragment id. Cite only what the evidence pack gives you.",
].join("\n");

/**
 * Render the anchored passages as a prompt block: the paper's own words, each
 * with the link (or the honest absence of one) the model must cite. Shared by
 * `formatEvidencePackForPrompt` and any agent that gets the passages directly,
 * so the two never drift apart.
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
    lines.push(
      `[passage ${i + 1}] ${p.sourceTitle ?? "unknown source"}${where}${sim}`,
    );
    lines.push(`"${p.content.replace(/\s+/g, " ").trim()}"`);
    lines.push(
      p.citation
        ? `link: ${p.citation}`
        : "link: none (this passage could not be located in the PDF — cite the DOI and say so)",
    );
  });

  return lines;
}
