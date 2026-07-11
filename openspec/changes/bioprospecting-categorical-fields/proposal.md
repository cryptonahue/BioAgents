# Proposal: bioprospecting-categorical-fields

> SDD propose phase. Artifact store: openspec. Date: 2026-07-11.
> Implements **Approach E** from `exploration.md` — fix the extractor so
> `bioactivity` / `applicationArea` / `assayModel` emit SHORT CATEGORICAL
> labels, then re-extract the corpus. Chosen because the entity graph's
> ~1.5 facts/node is an **extraction-quality** problem, not a synonymy one.

## Why

The `bioprospecting-entity-graph` capability averages **~1.5 facts per node**.
The root cause is not latent synonymy — it is that the extractor prompt
(`src/services/researchBrain/bioprospectingExtractor.ts:246-287`) puts **no
categorical constraint** on `bioactivity`, `applicationArea`, or `assayModel`.
The model therefore emits verbose, sentence-like values (e.g. `bioactivity:
"activate AMPK and upregulate IRS-1/PI3K/Akt signaling"`) that are unique per
paper and never collapse into shared nodes.

A synonym registry (Approach A/B/C/D) cannot merge two distinct verbose
sentences — it only helps when the corpus already contains short synonymous
labels. So the real densification lever is **extraction quality**: make the
three graph-facing fields carry short categorical labels, and the existing
read-only graph (which consumes those same columns) densifies automatically —
no graph-side change required.

The fact schema already supports this split: `resultSummary` exists today as an
overflow field, so the verbose mechanism/description has a home and nothing is
lost when the categorical field is tightened.

## What changes

1. **Prompt rule — categorical labels for 3 fields.** Add a one-line rule per
   field to the extractor prompt so `bioactivity`, `applicationArea`, and
   `assayModel` each emit a SHORT CATEGORICAL label (e.g. `bioactivity:
   "antifungal"`, not a sentence), and the verbose mechanism/description goes
   into `resultSummary`. `bioactivity` is the priority, but all three get the
   same rule.

2. **Guiding examples, not a closed vocabulary.** Provide per-field example
   labels (seeded from the existing category hint at prompt lines 275-276:
   anticancer, anti-inflammatory, antimicrobial, antioxidant, cosmetic,
   biomaterials, thermal resistance…). These are GUIDING examples — the field
   stays a free short label so novel marine activities are still captured. We
   deliberately do NOT impose a rigid controlled vocabulary.

3. **Backfill = full re-extraction of the existing corpus.** The prompt change
   only affects new extractions, so the shipped corpus must be re-extracted via
   the existing CLI (`scripts/extract-bioprospecting.ts --all …`). This is now a
   cheap, known process. Re-extraction goes through
   `extractBioprospectingFactsForSource` →
   `replaceBioprospectingFactsForSource`, which **REPLACES** all facts for a
   source (new fact ids).

4. **Re-run compound canonicalization after re-extraction.** Because
   re-extraction replaces facts with new ids, it WIPES the
   `compound_canonical_id` links produced by the
   `compound-canonicalization-recovery` work. The compound backfill must be
   re-run afterward as its known 2-command sequence
   (`scripts/normalize-compounds.ts`): Phase 1 fuzzy
   (`--try-fuzzy-variants`), then Phase 2 accept-local
   (`--accept-local` with `COMPOUND_AUTHORITY_ACCEPT_LOCAL=true`).
   Re-canonicalization now benefits from the hardened variant builder shipped in
   that change.

5. **Eval / guardrail against recall regression.** Re-extraction is
   non-deterministic and regenerates ALL fields, not just the three targeted
   ones. The change must include a sanity check that extraction recall/quality
   is not regressed: compare fact counts before/after and spot-check categorical
   labels on a sample of sources. The verbose text is preserved in
   `resultSummary`, so tightening the categorical field loses no information.

## Impact / risk

- **Write-path change.** Unlike the entity-graph change (deliberately
  additive/read-only), this touches the extractor write path. Blast radius is
  the extractor prompt plus a corpus re-run; the fact schema and `asString`
  mapping (lines 91-94) are unchanged.
- **Re-extraction cost + non-determinism.** A full corpus re-run costs LLM
  calls and can shift unrelated fields run-to-run. Accepted by the user.
  Mitigation: the eval guardrail (fact-count delta + spot check) catches gross
  regressions before/after.
- **Wipes-then-regenerates compound links.** New fact ids drop
  `compound_canonical_id`. Mitigation: mandatory re-run of the 2-command
  compound backfill immediately after re-extraction; treat the two as one
  atomic backfill operation.
- **Recall-regression risk.** A stricter prompt could suppress facts.
  Mitigation: guiding examples (not a closed vocabulary) keep coverage open, and
  `resultSummary` preservation means the verbose content is never discarded.
- **Downstream benefit.** By producing categorical values first, this change
  makes the deferred synonym/ontology/clustering approaches (A/B/C/D) far more
  effective later — they finally have short labels to work on.

## Out of scope

- **Synonym registry (Approach A)**, **ontology backing (B)**, and **LLM /
  embedding clustering (C/D)** — deferred. This change is the prerequisite that
  makes them worthwhile.
- **Any change to the `bioprospecting-entity-graph` capability or its API** — it
  consumes the same three columns and simply gets denser output.
- **A controlled/closed vocabulary** — explicitly rejected in favor of free
  short labels with guiding examples, so novel marine activities are still
  captured.
