import { resolveResearchBrainLLM } from "./llm";
import { formatEvidencePackForPrompt } from "./search";
import {
  INTERNAL_CITATION_RULE,
  resolvePassageTokens,
  rewriteDoiToPaperLink,
} from "./citation/citationPolicy";
import type { EvidencePack } from "./types";

const NO_EVIDENCE_MESSAGE =
  "I cannot find enough evidence in the loaded papers to answer this question as a scientific fact.";

const NO_EVIDENCE_HYPOTHESIS_MESSAGE = `## Hypothesis

Insufficient evidence: the research pack contains no direct, indirect, or hypothesis-grade facts relevant to the user's question. No specific scientific hypothesis can be formulated without inventing compound classes, mechanisms, or quantitative endpoints that are not in the provided evidence.

## Rationale

The Evidence Set returned by the literature and bioprospecting agents contains only tangential or unrelated material. Any hypothesis generated from this evidence would require speculation beyond what the data supports. Per the project's grounding rules, the system refuses to manufacture specificity (e.g., compound class, mechanism, IC50 range, strain selection) when the evidence pack cannot back it up.

## Novelty Statement

Cannot be stated. Novelty requires a contrast between "what is known" and "what is proposed"; without a confirmed starting point in the evidence, the contrast itself is fabricated.

## Experimental Design

Cannot be proposed. A protocol design (e.g., specific strains, dose ranges, reporter systems) is grounded in prior literature on the compound and target organism. When that prior literature is absent from the evidence pack, the design is invented.

## Follow-Up Analyses

Recommended (testable, evidence-agnostic):
- Locate primary isolation papers for the compound via MarinLit / AntiBase / direct citation tracking.
- Search for bioassay reports pairing the compound with the target organism or pathway.
- Cross-check review articles on the source organism's metabolite chemodiversity.

These are search actions, not factual claims.`;

export async function verifyHypothesisAgainstEvidence(params: {
  question: string;
  hypothesis: string;
  evidencePack: EvidencePack;
}): Promise<string> {
  /*
    THE PAPER'S TEXT IS EVIDENCE. This gate used to say otherwise.

    It counted claims, facts and contradictions — everything we EXTRACTED about
    a paper — and never the paper itself. So when Deep Research read the sea
    urchin study, pulled twenty of its chunks, and answered all six of the
    user's questions correctly (including the trap about siderophores, quoting
    the paper's own limitations section), this gate looked for evidence, found
    none of the kinds it knew how to count, and returned the refusal message —
    deleting every correct answer.

    The system found the truth, verified it against the PDF, and censored
    itself. A product that fabricates loses credibility; one that suppresses its
    own correct answers is useless.

    The verifier must judge against the SAME material the researcher reasoned
    from. That is the whole point of a verifier.
  */
  const hasEvidence =
    params.evidencePack.passages?.length > 0 ||
    params.evidencePack.bioprospectingFacts.length > 0 ||
    params.evidencePack.supportedClaims.length > 0 ||
    params.evidencePack.partialClaims.length > 0 ||
    params.evidencePack.contradictions.length > 0;

  if (!hasEvidence) {
    return NO_EVIDENCE_HYPOTHESIS_MESSAGE;
  }

  const scopeDocId = params.evidencePack.scope?.docId;
  const { llm, model } = resolveResearchBrainLLM();
  if (!llm || !model) {
    // No LLM available — fall back to the raw hypothesis, but still convert its
    // DOI citations to internal paper links when scoped, so the hypothesis panel
    // matches the body and the insights instead of being the one place that
    // still points at doi.org.
    return rewriteDoiToPaperLink(params.hypothesis, scopeDocId);
  }

  const prompt = `You are a hypothesis grounding checker for a strict scientific assistant.

Your job is to REWRITE the candidate hypothesis so that every specific factual claim
(compound class, mechanism, quantitative endpoint, organism strain, assay system)
is grounded in the evidence pack. When the evidence pack cannot support a claim,
REMOVE the specificity rather than keep it.

Rules:
- Do NOT introduce facts not present in the evidence pack.
- If the candidate hypothesis names a compound class (e.g. "macrocyclic dodecalactone"),
  a mechanism (e.g. "LuxR-type receptor antagonism"), a strain (e.g. "BB170/BB120"),
  a quantitative endpoint (e.g. "IC₅₀ in the 1–10 μM range"), or any other specific
  detail NOT present in the evidence pack, REMOVE that detail and rewrite the
  surrounding sentence to be honest about the gap.
- Replace invented specifics with phrases like "the literature does not directly
  establish", "no prior data is available for", or "this remains untested".
- Keep the structure (Hypothesis / Rationale / Novelty Statement / Experimental
  Design / Follow-Up Analyses) but every section must be honest about what the
  evidence supports and what it does not.
- Do NOT manufacture citations. Only cite sources present in the evidence pack.
- If the candidate hypothesis is already well-grounded, return it with minimal
  changes (you may tighten the wording).
- Do NOT output anything outside the five required sections.
- Answer in the same language as the candidate hypothesis (Spanish if Spanish).

${formatEvidencePackForPrompt(params.evidencePack)}

Original research question:
${params.question}

Candidate hypothesis (may contain invented specifics — your job is to rewrite it):
${params.hypothesis}`;

  const response = await llm.createChatCompletion({
    model,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 2200,
    temperature: 0,
  });

  const grounded = response.content.trim();

  // Some models occasionally duplicate the entire response when the
  // prompt is long. Detect that pattern and fall back to the safe
  // refusal template.
  if (isDuplicatedOutput(grounded)) {
    return NO_EVIDENCE_HYPOTHESIS_MESSAGE;
  }

  // Swap the {Pn} tokens the model cited for the real internal links. The model
  // never saw the links, so it could not corrupt them; the code fills them in.
  // Then convert any DOI the model kept anyway to an internal paper link when
  // scoped — belt and suspenders so the hypothesis never shows a bare DOI while
  // the rest of the answer is internal.
  const resolved =
    resolvePassageTokens(grounded, params.evidencePack.passages) ||
    params.hypothesis;
  return rewriteDoiToPaperLink(resolved, scopeDocId);
}

/**
 * Heuristic: if the first half and the second half of the output are
 * byte-identical, the model duplicated itself. Cheap O(n) check that
 * catches the bug we observed with long prompts.
 */
function isDuplicatedOutput(text: string): boolean {
  if (text.length < 100) return false;
  const mid = Math.floor(text.length / 2);
  // Try a few offsets near the midpoint in case there is whitespace
  // padding between the two halves.
  for (const offset of [-2, -1, 0, 1, 2]) {
    const half = text.slice(0, mid + offset);
    const secondHalf = text.slice(mid + offset);
    if (secondHalf.startsWith(half)) return true;
  }
  return false;
}

export async function verifyEvidenceGroundedResponse(params: {
  question: string;
  draft: string;
  evidencePack: EvidencePack;
}): Promise<string> {
  /*
    THE PAPER'S TEXT IS EVIDENCE. This gate used to say otherwise.

    It counted claims, facts and contradictions — everything we EXTRACTED about
    a paper — and never the paper itself. So when Deep Research read the sea
    urchin study, pulled twenty of its chunks, and answered all six of the
    user's questions correctly (including the trap about siderophores, quoting
    the paper's own limitations section), this gate looked for evidence, found
    none of the kinds it knew how to count, and returned the refusal message —
    deleting every correct answer.

    The system found the truth, verified it against the PDF, and censored
    itself. A product that fabricates loses credibility; one that suppresses its
    own correct answers is useless.

    The verifier must judge against the SAME material the researcher reasoned
    from. That is the whole point of a verifier.
  */
  const hasEvidence =
    params.evidencePack.passages?.length > 0 ||
    params.evidencePack.bioprospectingFacts.length > 0 ||
    params.evidencePack.supportedClaims.length > 0 ||
    params.evidencePack.partialClaims.length > 0 ||
    params.evidencePack.contradictions.length > 0;

  if (!hasEvidence) {
    return NO_EVIDENCE_MESSAGE;
  }

  const { llm, model } = resolveResearchBrainLLM();
  if (!llm || !model) {
    return appendEvidenceNotice(params.draft, params.evidencePack);
  }

  const prompt = `You are an evidence verifier for a strict scientific assistant.

Rewrite the draft so every scientific factual claim is grounded in the evidence pack.

YOUR PRIMARY JOB, alongside grounding, is to FIX THE CITATIONS. The draft was
written by upstream agents that only knew how to cite DOIs. The evidence pack
below carries internal links that open our copy of the PDF on the anchored page.
Wherever the draft cites a doi.org link for a source that has an anchored passage
here, REPLACE that DOI with the passage's internal link. This is not optional and
it is not a preference to weigh against keeping the DOI — it is the point of this
pass. Keep the DOI only for a source that has no internal link in the pack.

${INTERNAL_CITATION_RULE}

Rules:
- Do not introduce facts not present in the evidence pack.
- CORRECT THE DRAFT TOWARD THE EVIDENCE, not just away from it. If the pack DIRECTLY states a fact that the draft omits or hedges, state that fact with its {Pn} citation. Example: if a passage says the tool was "PICRUSt2 (version 2.5.2)" and the draft says "the exact tool is not specified", replace the hedge with the supported fact and cite it. Do NOT tell the reader a fact "cannot be confirmed" when a passage in this pack confirms it. This is as important as removing unsupported claims — grounding cuts both ways.
- If evidence is partial, use cautious wording.
- If evidence is external, explicitly say it is external.
- For bioprospection questions, prefer the structured Bioprospecting facts section and distinguish direct evidence, indirect evidence, hypotheses, and open questions.
- Follow the evidence pack query plan when present: use its strategy, answer sections, and cautions to decide the response structure.
- If contradictions exist, state them without resolving them as consensus.
- If a claim in the draft is unsupported, remove it.
- Use "fragment" in user-facing answers, not "chunk".
- Answer in the same language as the user's question.

${formatEvidencePackForPrompt(params.evidencePack)}

User question:
${params.question}

Draft response:
${params.draft}`;

  const response = await llm.createChatCompletion({
    model,
    // A verified six-question answer is long, and the primary fix for that is
    // richer evidence (see the scoped passage budget in search.ts) so the model
    // confirms facts instead of hedging them at length. This ceiling is the
    // backstop: enough headroom that a legitimately long grounded answer is
    // never cut at the tail, without masking the verbosity the evidence fix
    // targets.
    maxTokens: 5000,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });

  // Swap the {Pn} tokens the model cited for the real internal links. The model
  // never saw the links, so it could not corrupt them; the code fills them in.
  const grounded = resolvePassageTokens(
    response.content.trim(),
    params.evidencePack.passages,
  );
  return grounded || appendEvidenceNotice(params.draft, params.evidencePack);
}

function appendEvidenceNotice(draft: string, pack: EvidencePack): string {
  if (pack.contradictions.length > 0) {
    return `${draft}\n\nEvidence note: Research Brain holds contradictory claims; treat this answer as a provisional synthesis.`;
  }
  const hasSupportedEvidence =
    pack.supportedClaims.length > 0 ||
    pack.bioprospectingFacts.some((fact) => fact.status === "supported");
  const hasPartialEvidence =
    pack.partialClaims.length > 0 ||
    pack.bioprospectingFacts.some(
      (fact) => fact.status === "partial" || fact.status === "hypothesis",
    );

  if (hasPartialEvidence && !hasSupportedEvidence) {
    return `${draft}\n\nEvidence note: the support found is partial or hypothetical, not conclusive.`;
  }
  return draft;
}
