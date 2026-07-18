import logger from "../../utils/logger";
import { resolveResearchBrainLLM } from "./llm";
import { formatEvidencePackForPrompt } from "./search";
import {
  INTERNAL_CITATION_RULE,
  resolvePassageTokens,
  rewriteDoiToPaperLink,
  stripAllDois,
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
  // NOTHING TO VERIFY. A factual/review question ("which fish carry the most
  // ciguatoxin?") is not hypothesis-shaped, so the hypothesis agent returns
  // nothing. Running the verifier on an empty hypothesis made the model answer
  // conversationally — "you did not give me a hypothesis, please resend it" —
  // and that reply, INCLUDING the verifier's own prompt wording, landed in the
  // Hypothesis panel. There is no hypothesis to ground; return empty so the
  // panel simply does not render.
  if (!params.hypothesis || !params.hypothesis.trim()) {
    return "";
  }

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
    // No LLM available — fall back to the raw hypothesis, but still strip its
    // DOIs (and convert to internal links when scoped) so the hypothesis panel
    // is never the one place that leaks a doi.org citation.
    return stripAllDois(rewriteDoiToPaperLink(params.hypothesis, scopeDocId));
  }

  const prompt = `You are a hypothesis grounding checker for a strict scientific assistant.

Your job is to REWRITE the candidate hypothesis so that every specific factual claim
is grounded in the evidence pack. When the evidence pack cannot support a claim,
REMOVE the specificity rather than keep it. This is DOMAIN-NEUTRAL: the same rule
applies to molecular biology, ecology, chemistry, physiology, or any field — do NOT
assume the hypothesis is about natural-product bioprospecting.

WHAT COUNTS AS "SPECIFICITY TO STRIP" (examples across domains, non-exhaustive):
- a quantitative figure or endpoint ("1200% increase", "IC₅₀ 1–10 μM", "39 years old", "p < 0.01");
- a named molecule, pathway, or cascade ("IP₃/phospholipase C", "NF-κB", "Rab7 trafficking", "LuxR antagonism");
- a mechanism, subcellular localization, or timepoint ("at the symbiosome membrane", "by day 9 post-offset");
- a compound class, organism strain, or assay system ("macrocyclic dodecalactone", "BB170/BB120").
If a detail like these is NOT in the evidence pack, REMOVE it and rewrite the sentence to be honest.

THREE TIERS OF GROUNDING — apply to every claim, including inside the Rationale:
1. PRIMARY — a loaded passage/fact in the pack directly supports it → keep it, cite the {Pn} token.
2. SECOND-HAND — a loaded paper attributes it to a work NOT in the pack (e.g. "per Santoro et al. 2021")
   → keep ONLY if you attribute it as second-hand AND flag "— second-hand; not independently verified",
   and strip any number, mechanism, or definition the loaded text does not itself contain. NEVER attach
   a specific figure or cascade to a paper the pack does not actually contain.
3. UNSUPPORTED — nothing in the pack supports it → remove it; say the evidence does not establish it.

IF THE PACK IS ONLY BACKGROUND: when the evidence pack holds only reference-list entries, tangential
background, or general review statements — and no mechanistic or quantitative data for the hypothesis —
the hypothesis MUST NOT present a specific mechanism, cascade, or figure as grounded. State plainly that
the mechanism is a proposal the loaded evidence cannot yet support.

Rules:
- Do NOT introduce facts not present in the evidence pack.
- A hypothesis MAY propose an untested mechanism — that is its purpose — but it must be framed clearly
  as a PROPOSAL TO TEST, never as a grounded finding, whenever the pack does not support it.
- Replace invented specifics with phrases like "the loaded evidence does not establish", "no data is
  available in the pack for", or "this remains untested".
- Keep the structure (Hypothesis / Rationale / Novelty Statement / Experimental Design / Follow-Up
  Analyses) but every section must be honest about what the evidence supports and what it does not.
- Do NOT manufacture citations. Cite only sources present in the evidence pack, by their {Pn} token.
- If the candidate is already well-grounded, return it with minimal changes (you may tighten wording).
- Do NOT output anything outside the five required sections.
- Write ENTIRELY in the language of the user's question below — every section, every citation label. If the draft drifted into another language (a Spanish label in an English answer), translate it back. Do not mix languages.

${INTERNAL_CITATION_RULE}

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
  return stripAllDois(rewriteDoiToPaperLink(resolved, scopeDocId));
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
    return stripAllDois(
      appendEvidenceNotice(params.draft, params.evidencePack),
    );
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

SHAPE OF THE ANSWER — a scientist reads top-down and stops early:
- OPEN WITH THE ANSWER, in 2-4 sentences: what is known that bears on the
  question, and — when the evidence cannot settle it — say that in the same
  opening. Never open with a wall of disclaimers; the finding comes first.
- Then the supporting detail, each claim carrying its {Pn} citation.
- If the evidence cannot answer, name the GAP SPECIFICALLY and once: what exactly
  is missing (a definition, a measurement, a resolution). One tight paragraph —
  not an inventory of everything absent, and NOT the same limitation restated in
  three places.
- If, and only if, the evidence itself names a work that would close the gap, end
  by saying which one, BY AUTHOR AND YEAR. Never invent a paper, and never
  promise to fetch it — you cannot retrieve papers.
- Prefer the reader's next action over your own completeness.

OUTPUT ONLY THE CORRECTED ANSWER — the text the reader should see, as if it had
been written correctly the first time. The reader asked a question; they are NOT
reviewing your edit. So:
- NEVER mention "the draft", and never write a section like "What the draft gets
  wrong", "Claims that are NOT supported", or "removed because…". Silently drop
  or fix an unsupported claim — do not narrate the surgery.
- Do NOT explain your own process, corrections, or reasoning about the evidence
  pack as an object.
- You SHOULD still state the limits of the ANSWER ("the loaded papers do not
  characterise X at single-cell resolution") — that is honest scope, and it reads
  as part of the answer. The difference is subject: describe what is KNOWN and
  NOT KNOWN about the topic, never what a draft said or what you edited.

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
  if (!grounded) {
    return stripAllDois(
      appendEvidenceNotice(params.draft, params.evidencePack),
    );
  }
  return stripAllDois(grounded);
}

/**
 * Ground the reflection agent's Key Insights against the evidence pack — the
 * "hard guarantee" behind the reflection prompt's grounding policy. Reflection
 * writes from flat task-output text and can still drift: assert a term the
 * evidence never defines, or attach a reference-list DOI as if the paper were
 * read. This pass judges each insight against the SAME evidence the body was
 * verified against, and returns a corrected list — ungrounded insights removed,
 * second-hand ones flagged, DOIs upgraded to internal links where a passage
 * supports them.
 *
 * Returns the corrected insights. On any failure (no LLM, no evidence, unpar-
 * seable output) it falls back to the input insights with DOI→internal rewrite
 * applied, exactly as the reflection agent already did — the verifier only ever
 * makes the insights MORE grounded, never blanks them.
 */
export async function verifyKeyInsightsAgainstEvidence(params: {
  question: string;
  insights: string[];
  evidencePack: EvidencePack;
}): Promise<string[]> {
  const scopeDocId = params.evidencePack.scope?.docId;
  // Even the fallback must strip DOIs. It used to only rewriteDoiToPaperLink,
  // which is a no-op on a broad (unscoped) query — so whenever the verifier fell
  // back (unparseable rerank JSON, no LLM, no evidence), the reflection agent's
  // raw doi.org citations leaked into the Key Insights while the body stayed
  // clean. A fabricated/misattributed DOI is exactly what stripAllDois exists to
  // remove, on every path.
  const fallback = () =>
    params.insights.map((i) =>
      stripAllDois(rewriteDoiToPaperLink(i, scopeDocId)),
    );

  if (!params.insights || params.insights.length === 0) return [];

  const hasEvidence =
    params.evidencePack.passages?.length > 0 ||
    params.evidencePack.bioprospectingFacts.length > 0 ||
    params.evidencePack.supportedClaims.length > 0 ||
    params.evidencePack.partialClaims.length > 0 ||
    params.evidencePack.contradictions.length > 0;

  // No evidence to judge against, or no model — do not touch the list beyond the
  // DOI rewrite. The prompt-level grounding policy still applied upstream.
  if (!hasEvidence) return fallback();
  const { llm, model } = resolveResearchBrainLLM();
  if (!llm || !model) return fallback();

  const prompt = `You are a grounding checker for the Key Insights of a strict scientific assistant.

You are given a list of candidate insights and the evidence pack they must stand on.
Return a corrected list. Judge every insight against the THREE tiers of grounding:

1. PRIMARY — a loaded paper in the evidence pack directly supports it. Keep it, and
   cite the supporting passage by its {Pn} token (see the citation rule below).
2. SECOND-HAND — a loaded paper attributes it to a work NOT in the pack (e.g. a review
   says "Santoro et al. 2021 found X"). Keep it ONLY if you rewrite it to: attribute it
   as second-hand, end it with "— second-hand; not independently verified", and strip any
   specificity (mechanism, numbers, definitions) the loaded text does not contain.
3. UNSUPPORTED — nothing in the pack supports it. REMOVE it from the list entirely.

Hard rules:
- Do NOT introduce facts, citations, DOIs, numbers, or definitions not in the pack.
- Do NOT let an insight be more specific or more confident than the evidence it rests on.
- Do NOT keep a reference-list DOI as if that paper were read — that is tier 2 at best.
- An insight must not assert that a term/mechanism is defined or established when the
  evidence pack does not define or establish it.
- Prefer fewer, well-grounded insights. Returning fewer items than you were given is
  correct when some were unsupported.
- Keep each insight to 1–2 sentences. Write every insight and every citation label in the language of the user's question; if an insight drifted into another language, translate it back — do not mix languages.

${INTERNAL_CITATION_RULE}

${formatEvidencePackForPrompt(params.evidencePack)}

Original research question:
${params.question}

Candidate insights (JSON array of strings):
${JSON.stringify(params.insights, null, 2)}

Return ONLY a JSON array of strings (the corrected insights), no prose, no markdown.`;

  let response;
  try {
    response = await llm.createChatCompletion({
      model,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 2500,
      temperature: 0,
    });
  } catch {
    return fallback();
  }

  // Parse the JSON array; tolerate the model wrapping it in ```json fences.
  const raw = response.content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback();
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((x): x is string => typeof x === "string")
  ) {
    return fallback();
  }

  // Log how many insights survived — the way to tell "correctly empty because
  // the pack was background-only" from "over-filtering". Pairs with the claim
  // and fact relevance logs.
  if (parsed.length !== params.insights.length) {
    logger.info(
      { before: params.insights.length, after: parsed.length },
      "key_insights_grounding_filtered",
    );
  }

  // Resolve the {Pn} tokens to internal links, convert scoped DOIs to internal
  // paper links, and strip every raw DOI the model wrote — same as the body and
  // hypothesis verifiers.
  return parsed.map((insight) =>
    stripAllDois(
      rewriteDoiToPaperLink(
        resolvePassageTokens(insight, params.evidencePack.passages),
        scopeDocId,
      ),
    ),
  );
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
