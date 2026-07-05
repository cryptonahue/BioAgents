import { resolveResearchBrainLLM } from "./llm";
import { formatEvidencePackForPrompt } from "./search";
import type { EvidencePack } from "./types";

const NO_EVIDENCE_MESSAGE =
  "No encuentro evidencia suficiente en los papers cargados para responder esta pregunta como hecho científico.";

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
  const hasEvidence =
    params.evidencePack.bioprospectingFacts.length > 0 ||
    params.evidencePack.supportedClaims.length > 0 ||
    params.evidencePack.partialClaims.length > 0 ||
    params.evidencePack.contradictions.length > 0;

  if (!hasEvidence) {
    return NO_EVIDENCE_HYPOTHESIS_MESSAGE;
  }

  const { llm, model } = resolveResearchBrainLLM();
  if (!llm || !model) {
    // No LLM available — fall back to the raw hypothesis. The caller
    // decides what to do; we don't second-guess here.
    return params.hypothesis;
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

  return grounded || params.hypothesis;
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
  const hasEvidence =
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

Rules:
- Do not introduce facts not present in the evidence pack.
- If evidence is partial, use cautious wording.
- If evidence is external, explicitly say it is external.
- For bioprospection questions, prefer the structured Bioprospecting facts section and distinguish direct evidence, indirect evidence, hypotheses, and open questions.
- Follow the evidence pack query plan when present: use its strategy, answer sections, and cautions to decide the response structure.
- If contradictions exist, state them without resolving them as consensus.
- If a claim in the draft is unsupported, remove it.
- Include compact inline provenance using source title and DOI when available.
- Always include a final short section titled "Evidencia usada" when evidence exists. For each key claim, list source title, DOI as a clickable inline citation using [DOI]{https://doi.org/...}, internal fragment link using citation format [fragmento N]{/library/...?...}, fragment/page when available, and a short quoted snippet from the evidence pack.
- Use "fragmento" in Spanish user-facing answers, not "chunk". Prefer the internal fragment link for claim-level citations and the DOI link for the public paper reference.
- Do not invent snippets, chunks, pages, paper links, DOI links, or citations; use only the evidence pack.
- Answer in the same language as the user's question.

${formatEvidencePackForPrompt(params.evidencePack)}

User question:
${params.question}

Draft response:
${params.draft}`;

  const response = await llm.createChatCompletion({
    model,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 2200,
    temperature: 0,
  });

  return (
    response.content.trim() ||
    appendEvidenceNotice(params.draft, params.evidencePack)
  );
}

function appendEvidenceNotice(draft: string, pack: EvidencePack): string {
  if (pack.contradictions.length > 0) {
    return `${draft}\n\nNota de evidencia: hay claims contradictorios en Research Brain; tratá esta respuesta como síntesis provisional.`;
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
    return `${draft}\n\nNota de evidencia: el soporte encontrado es parcial o hipotético, no concluyente.`;
  }
  return draft;
}
