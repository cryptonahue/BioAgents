#!/usr/bin/env bun
/**
 * TEMP diagnostic — is the hypothesis LLM call the ~40min stall?
 * Times generateHypothesis (the Gemini call) in three configs to triangulate
 * whether the cost is thinking, prompt size, or the model itself. Read-only
 * (one LLM call each — costs a few tokens). Delete after use.
 *
 *   bun run scripts/diag-hypothesis-timing.ts
 */
import { generateHypothesis, type HypothesisDoc } from "../src/agents/hypothesis/utils";

const filler =
  "Structure elucidation by 1D and 2D NMR and HRESIMS established the planar structure and relative configuration. ";
const passageText = (i: number) =>
  (`Anthoteibinene ${i} is a cadinene-like sesquiterpene isolated from a deep-sea coral; ` +
    `it was screened at 50 µg/mL against six Candida albicans strains and one C. auris strain. ` +
    filler.repeat(20)).slice(0, 1500);

const bigDocs: HypothesisDoc[] = [];
for (let i = 1; i <= 10; i++) {
  bigDocs.push({
    title: "Evidence Passage — marinedrugs-23-00044.pdf",
    text: passageText(i),
    context: "Paper text retrieved for this question — treat as evidence",
  });
}
bigDocs.push({
  title: "Research Context",
  text: "Main Objective: antifungal compounds in the library.\nCurrent Objective: same.",
  context: "Overall research context",
});

const smallDocs: HypothesisDoc[] = [bigDocs[0], bigDocs[bigDocs.length - 1]];

const Q =
  "What antifungal compounds does my library describe, from which marine source organisms, and what potency was reported?";

const provider = process.env.HYP_LLM_PROVIDER || "google";
const model = process.env.HYP_LLM_MODEL || "gemini-2.5-pro";
console.log(`\nprovider=${provider}  model=${model}\n`);

const run = async (label: string, docs: HypothesisDoc[], thinking: boolean) => {
  const chars = docs.reduce((s, d) => s + d.text.length, 0);
  const t0 = performance.now();
  try {
    const r = await generateHypothesis(Q, docs, {
      maxTokens: 4000,
      thinking,
      thinkingBudget: 2048,
      mode: "create",
      usageType: "deep-research",
    });
    const ms = Math.round(performance.now() - t0);
    console.log(
      `${label.padEnd(30)} ${ms.toString().padStart(7)} ms   out=${r.text?.length ?? 0} chars   in≈${chars} chars`,
    );
  } catch (e: any) {
    const ms = Math.round(performance.now() - t0);
    console.log(`${label.padEnd(30)} ${ms.toString().padStart(7)} ms   ERROR ${e?.message ?? e}`);
  }
};

// Production config first — this is the one the user experiences.
await run("PROD (10 docs, thinking ON)", bigDocs, true);
await run("no-thinking (10 docs)", bigDocs, false);
await run("small prompt (2 docs, think)", smallDocs, true);

console.log(
  "\n>>> If PROD is minutes but no-thinking/small are seconds → thinking or prompt size is the stall.",
);
console.log(">>> If ALL are minutes → the Gemini call/adapter itself is slow (retries?).\n");

process.exit(0);
