# Delta for research-bioprospecting

> SDD spec phase. Artifact store: openspec. Date: 2026-07-11.
> Implements **Approach E** from `exploration.md`: tighten the extractor
> prompt so the three graph-facing fields (`bioactivity`,
> `applicationArea`, `assayModel`) emit SHORT CATEGORICAL labels, then
> re-extract the corpus and re-run compound canonicalization as one
> atomic backfill.
>
> This delta preserves the entire baseline contract and every prior
> delta (`bioprospecting-pdf-provenance-viewer`,
> `bioprospecting-compound-authority`, `cost-guard-rails`). It touches
> only the LLM prompt text and adds a backfill / eval process contract.
> The fact schema, the `asString` field mapping
> (`bioprospectingExtractor.ts:91-94`), `normalizeFacts`, the inline
> merge, and all status transitions are UNCHANGED.

## MODIFIED Requirements

### Requirement: Categorical Labels For bioactivity, applicationArea, assayModel

The extractor LLM prompt MUST instruct the model to emit a SHORT
CATEGORICAL label for each of the three graph-facing fields —
`bioactivity`, `applicationArea`, and `assayModel` — and to move the
verbose mechanism/description into the existing `resultSummary` field.
This modifies the pre-delta prompt, which placed NO categorical
constraint on these fields and therefore let the model emit
sentence-like, per-paper-unique values that never collapse into shared
entity-graph nodes.

**Definition of a short categorical label (testable):**

- A term or short noun phrase naming the category — NOT a sentence.
- Guideline: at most ~4 words, no sentence-ending punctuation, no
  verb-led clause (e.g. no "activates …", "upregulates …").
- Examples of ACCEPTABLE labels: `antidiabetic`, `antifungal`,
  `anti-inflammatory`, `cosmetic`, `biomaterials`, `thermal resistance`,
  `cytotoxicity assay`, `zebrafish model`.
- Examples of REJECTED (verbose) values that MUST instead land in
  `resultSummary`: `activate AMPK and upregulate IRS-1/PI3K/Akt
  signaling pathway`, `reduces reactive oxygen species in HepG2 cells
  under oxidative stress`.

**Behavior:**

- The prompt MUST add one rule per field to the "Strict rules" section:
  each of `bioactivity`, `applicationArea`, and `assayModel` MUST be a
  short categorical label as defined above.
- The rule MUST instruct the model that when the source describes a
  verbose mechanism, phenotype, or assay detail, the SHORT label goes in
  the categorical field and the FULL sentence-level description goes in
  `resultSummary`.
- The rule MUST provide per-field GUIDING examples (seeded from the
  existing category hint at prompt lines 275-276: anticancer,
  anti-inflammatory, antimicrobial, antioxidant, cosmetic, biomaterials,
  thermal resistance, coral/anemone/cnidarian activities). These are
  EXAMPLES ONLY — the field remains a FREE short label. The prompt MUST
  NOT present them as a closed / controlled / enumerated vocabulary, and
  MUST NOT instruct the model to reject a value that is absent from the
  example list.
- `bioactivity` is the priority field, but all three fields receive the
  same rule.
- The `asString` field mapping (`bioprospectingExtractor.ts:91-94`) is
  UNCHANGED — this is a prompt-only change. The persisted column shapes,
  `normalizeFacts`, and the inline merge are untouched.

#### Scenario: Verbose mechanism becomes a short label plus resultSummary

- GIVEN a paper stating a compound "activates AMPK and upregulates the
  IRS-1/PI3K/Akt signaling pathway to improve insulin sensitivity"
- WHEN the extractor runs with the tightened prompt
- THEN the persisted fact has `bioactivity = "antidiabetic"` (or a
  similarly short categorical label, e.g. `insulin-sensitizing`)
- AND the persisted fact's `resultSummary` contains the full verbose
  description ("activates AMPK and upregulates IRS-1/PI3K/Akt signaling
  … insulin sensitivity")
- AND `bioactivity` is NOT the verbose sentence

#### Scenario: applicationArea and assayModel are also short labels

- GIVEN a paper describing "a cosmetic anti-aging serum evaluated in a
  human 3D reconstructed-skin model over 28 days"
- WHEN the extractor runs
- THEN `applicationArea = "cosmetic"` (short label, not the sentence)
- AND `assayModel = "reconstructed-skin model"` (short label)
- AND the 28-day protocol detail is preserved in `resultSummary`

#### Scenario: Guiding examples are not a closed vocabulary

- GIVEN the tightened prompt with per-field example labels
- WHEN the prompt is built
- THEN the "Strict rules" section presents the labels as EXAMPLES /
  guidance
- AND the prompt does NOT contain an enumerated allowed-values list, a
  "must be one of" constraint, or an instruction to discard values
  outside the examples for these three fields

## ADDED Requirements

### Requirement: Novel Activity Is Emitted As A Short Label, Never Dropped Or Miscategorized

Because the three fields remain FREE short labels (guided by examples,
not constrained to them), a genuinely novel marine activity with no
common category name MUST still be emitted as a short categorical label.
It MUST NOT be dropped, and MUST NOT be forced into a wrong existing
bucket. This proves the change is free-label extraction, not a closed
vocabulary.

**Behavior:**

- When the source describes an activity that does not match any guiding
  example, the model MUST coin a short label that names the novel
  activity (a term or short phrase) rather than reusing a semantically
  wrong example label.
- The verbose description of the novel activity MUST still be preserved
  in `resultSummary`.
- The fact MUST survive `normalizeFacts` and be persisted (the existing
  filter at `bioprospectingExtractor.ts:116-126` already keeps a fact
  when `bioactivity`, `applicationArea`, `resultSummary`, or `quote` is
  present).

#### Scenario: Novel activity with no common label survives

- GIVEN a paper reporting a previously uncatalogued marine activity
  (e.g. "inhibits coral-symbiont photobleaching under thermal stress")
  with no matching example label
- WHEN the extractor runs
- THEN `bioactivity` holds a SHORT novel label (e.g.
  `anti-photobleaching`) coined for the activity
- AND the fact is NOT dropped
- AND `bioactivity` is NOT forced into an unrelated example bucket such
  as `antioxidant` or `cosmetic`
- AND the full description is preserved in `resultSummary`

### Requirement: resultSummary Preserves All Verbose Detail (No Information Loss)

Tightening the categorical fields MUST NOT discard information. Whenever
the source carries mechanism, phenotype, protocol, or narrative detail
that no longer fits in the short categorical field, that detail MUST be
preserved in `resultSummary`. The change is lossless: the categorical
field gains structure, `resultSummary` retains the prose.

**Behavior:**

- For any fact whose categorical field was tightened from a verbose
  value to a short label, the verbose content MUST appear in
  `resultSummary`.
- `resultSummary` remains a free-text field with no length or format
  constraint added by this change.
- No requirement in this delta permits deleting source-supported detail
  rather than relocating it to `resultSummary`.

#### Scenario: Detail removed from a categorical field lands in resultSummary

- GIVEN a fact whose pre-change `bioactivity` was the full sentence
  "reduces reactive oxygen species in HepG2 cells under oxidative
  stress"
- WHEN the extractor runs with the tightened prompt
- THEN `bioactivity = "antioxidant"` (short label)
- AND `resultSummary` contains the removed detail ("reduces reactive
  oxygen species in HepG2 cells under oxidative stress")
- AND no source-supported detail present before the change is absent
  after it

### Requirement: Corpus Backfill Is Full Re-Extraction Plus Compound Re-Canonicalization As One Atomic Operation

The prompt change only affects NEW extractions. To realize the benefit
on the shipped corpus, the corpus MUST be re-extracted, and because
re-extraction replaces facts with new ids (wiping
`compound_canonical_id`), the compound canonicalization backfill MUST be
re-run immediately afterward. The two steps form ONE atomic backfill
operation — the corpus is not considered backfilled until BOTH have run.

**Behavior:**

- Re-extraction MUST run through the existing path
  (`scripts/extract-bioprospecting.ts --all …` →
  `extractBioprospectingFactsForSource` →
  `replaceBioprospectingFactsForSource`), which REPLACES all facts for
  each source with new fact ids. No new re-extraction code path is
  introduced by this change.
- Immediately after re-extraction, facts have new ids and
  `compound_canonical_id` is `NULL` (the prior canonicalization links
  are wiped by the replace).
- The compound canonicalization backfill MUST then be re-run as its
  known two-command sequence via `scripts/normalize-compounds.ts`:
  1. Phase 1 fuzzy: `--try-fuzzy-variants`
  2. Phase 2 accept-local: `--accept-local` with
     `COMPOUND_AUTHORITY_ACCEPT_LOCAL=true`
- The process contract requires treating "re-extraction did NOT re-run
  compound canonicalization" as an INCOMPLETE backfill, not a done
  state.
- No schema change and no change to `normalize-compounds.ts` behavior is
  introduced; the re-canonicalization reuses the hardened variant
  builder already shipped by `compound-canonicalization-recovery`.

#### Scenario: Compound links are null after re-extraction, restored after backfill

- GIVEN a corpus where facts previously had non-null
  `compound_canonical_id`
- WHEN re-extraction runs and replaces all facts for each source
- THEN every re-extracted fact has a new id
- AND `compound_canonical_id` is `NULL` on the re-extracted facts
- AND the backfill is INCOMPLETE until compound canonicalization re-runs
- WHEN the two-command `normalize-compounds.ts` sequence (Phase 1 fuzzy,
  then Phase 2 accept-local) is executed
- THEN facts eligible for canonicalization regain a non-null
  `compound_canonical_id`
- AND the backfill operation is considered complete

#### Scenario: Re-extraction without re-canonicalization is treated as incomplete

- GIVEN re-extraction has completed for the corpus
- AND the `normalize-compounds.ts` sequence has NOT been re-run
- WHEN the backfill state is evaluated
- THEN the corpus is reported as NOT fully backfilled
- AND the required next action is running the two-command compound
  canonicalization sequence

### Requirement: Extraction-Quality Guardrail Against Recall Regression

Re-extraction is non-deterministic and regenerates ALL fields, not only
the three targeted ones. The backfill MUST include an acceptance check
that extraction recall/quality did not regress before the re-extracted
corpus is accepted.

**Acceptance check (concrete default):**

- **Fact-count delta:** the total post-re-extraction fact count across
  the re-extracted corpus MUST be within ±15% of the prior total fact
  count. A drop greater than 15% MUST be treated as a suspected recall
  regression and investigated before the backfill is accepted.
- **Label-quality spot-check:** a random sample of at least 20 sources
  (or 10% of the corpus, whichever is larger) MUST be inspected to
  confirm, for each of `bioactivity`, `applicationArea`, and
  `assayModel`, that the value is a short categorical label (per the
  "Categorical Labels" definition) and that any verbose detail is
  present in `resultSummary`.
- The guardrail passes only when BOTH the fact-count delta is within
  tolerance AND the sampled labels are short with no observed
  information loss in `resultSummary`.

**Behavior:**

- The guardrail MUST compare fact counts captured before re-extraction
  against counts after re-extraction.
- The label-quality spot-check MUST verify short-label shape on the
  three fields and confirm `resultSummary` retains the verbose text for
  the sampled facts.
- A guardrail failure (count out of tolerance, or sampled fields still
  verbose, or observed information loss) MUST block acceptance of the
  backfill pending investigation.

#### Scenario: Guardrail passes when counts hold and labels are short

- GIVEN the prior corpus had 1000 facts
- WHEN re-extraction produces 940 facts (a 6% drop, within ±15%)
- AND a sample of 20+ sources shows `bioactivity`, `applicationArea`,
  and `assayModel` as short labels with verbose detail in
  `resultSummary`
- THEN the guardrail passes
- AND the re-extracted corpus is accepted

#### Scenario: Guardrail blocks on a recall regression

- GIVEN the prior corpus had 1000 facts
- WHEN re-extraction produces 700 facts (a 30% drop, beyond ±15%)
- THEN the guardrail fails
- AND the backfill is NOT accepted
- AND the regression is investigated before proceeding

#### Scenario: Guardrail blocks when labels are still verbose

- GIVEN the fact count is within tolerance
- WHEN the label-quality spot-check finds sampled facts whose
  `bioactivity` is still a full sentence
- THEN the guardrail fails
- AND the prompt / extraction is corrected before the backfill is
  accepted

### Requirement: Entity Graph Densifies Additively With No Graph Or API Change

The `bioprospecting-entity-graph` capability consumes the same three
columns (`bioactivity`, `applicationArea`, `assayModel`) that this
change tightens. Producing short categorical values MUST densify the
graph automatically, with NO change to the entity-graph capability, its
`graph_normalize_entity` behavior, its `{kind, value, display}` node
shape, or its API. This change is additive to the graph from the graph's
perspective — it only sees higher-quality input.

**Behavior:**

- This change MUST NOT modify the `bioprospecting-entity-graph`
  capability, its normalization, or its API surface.
- After the backfill, more facts share identical short labels, so
  deterministic `graph_normalize_entity` collapses them into shared
  nodes, raising the average facts-per-node WITHOUT any read-side change.
- No closed/controlled vocabulary is introduced; densification comes
  from short labels, not from an enumerated value set.

#### Scenario: Graph densifies from short labels with no code change

- GIVEN two papers that previously produced distinct verbose
  `bioactivity` sentences (two separate 1-fact nodes)
- WHEN both are re-extracted and both yield the short label
  `antifungal`
- THEN the entity graph groups both facts under the single
  `{kind: "bioactivity", value: "antifungal"}` node
- AND no change was made to the `bioprospecting-entity-graph` capability
  or its API
- AND the average facts-per-node increases

#### Scenario: Entity-graph API surface is untouched

- GIVEN the entity-graph `{kind, value, display}` node contract and the
  reserved additive `entity_id`
- WHEN this change ships
- THEN the entity-graph capability, its `graph_normalize_entity` logic,
  and its API are byte-for-byte unchanged
- AND the only difference the graph observes is denser input columns

## REMOVED Requirements

None.
