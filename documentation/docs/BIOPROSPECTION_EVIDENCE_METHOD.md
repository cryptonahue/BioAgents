# Bioprospection Evidence Method

This document defines the method BioAgents should follow to produce reliable bioprospection answers from private papers and external scientific sources.

## Reliability Principle

BioAgents should not behave like a free-form scientific chatbot.

It should behave like an evidence engine:

1. retrieve sources
2. extract atomic facts
3. verify every fact against evidence fragments
4. store the facts with provenance
5. answer only from retrieved evidence
6. separate direct evidence, indirect evidence, and hypotheses

The desired standard is:

> Zero established scientific claims without traceable evidence.

This is not the same as claiming absolute truth. It means every claim presented as fact must have a source trail.

## Evidence Classes

### Direct Evidence

The source directly supports the exact claim.

Example:

- A paper reports that `Acropora aspera` showed changes in glucose pools under thermal stress.

Allowed wording:

- "This paper reports..."
- "In this species/model..."
- "Direct evidence from the loaded paper shows..."

### Same-Taxon Evidence

The source supports a related species, genus, or family, but not the exact user species.

Allowed wording:

- "I did not find direct evidence for this species, but there is evidence in the same genus..."
- "This is indirect evidence and should be treated as a research lead."

### Ecological Analogy

The source supports a similar ecosystem, geography, stressor, or organism group.

Allowed wording:

- "This is ecological analogy, not direct evidence."
- "This suggests a possible exploration direction, not a confirmed property."

### Hypothesis

The system proposes a possible research direction based on evidence patterns.

Allowed wording:

- "Hypothesis to test..."
- "Candidate exploration..."
- "This would require validation..."

Disallowed wording:

- "This species has anticancer activity" unless direct evidence supports it.

### No Evidence

When no supported or partial evidence is found.

Required wording:

- "I do not find enough evidence in the loaded sources to state this as a scientific fact."

## Extraction Output Schema

Every bioprospecting fact should attempt to fill these fields:

```json
{
  "species": "Acropora aspera",
  "genus": "Acropora",
  "family": "Acroporidae",
  "higherTaxon": "Cnidaria",
  "organismGroup": "coral",
  "geography": "Great Barrier Reef",
  "ecosystem": "coral reef",
  "organismPart": "host tissue / mucus / symbiont / extract",
  "compound": "chiro-inositol",
  "compoundClass": "inositol",
  "moleculeType": "metabolite",
  "bioactivity": "thermal stress response",
  "applicationArea": "thermal resistance research",
  "assayModel": "13C metabolomics under heat stress",
  "resultSummary": "Pools increased by up to 1350% at 9 days under heat stress.",
  "measurementValue": 1350,
  "measurementUnit": "%",
  "measurementDirection": "increase",
  "measurementMin": null,
  "measurementMax": 1350,
  "timepoint": "9 days",
  "condition": "thermal stress",
  "pValue": null,
  "sampleSize": null,
  "statisticalTest": null,
  "evidenceType": "experimental",
  "relationType": "associated_with_resistance",
  "status": "supported",
  "confidence": "medium",
  "quote": "The scale of change was most notable for chiro-inositol...",
  "chunkIndex": 13,
  "entities": ["chiro-inositol", "thermal stress", "coral host"]
}
```

## Relation Types

Use relation types to avoid mixing different meanings:

- `contains_compound`
- `shows_bioactivity`
- `tested_in_assay`
- `associated_with_resistance`
- `proposed_application`
- `related_taxon_evidence`
- `ecological_analogy`
- `contradicts`
- `open_question`

## Confidence Rules

### High

Use when the evidence fragment directly ties together:

- organism/species or clear organism group
- molecule/compound/extract
- activity/application/assay
- result

### Medium

Use when most fields are explicit, but one part is broad or inferred from nearby context.

Example:

- genus is clear but species is not
- compound class is clear but exact molecule is not
- activity is experimental but application is a cautious category

### Low

Use when the fact is a textual mention only.

Example:

- a chapter title mentions "coral bleaching"
- a reference title mentions "bleaching susceptibility"
- a review broadly discusses "bioactive metabolites"

Low-confidence facts should not be used as strong answer evidence unless the answer clearly labels them as weak leads.

## Structured Numerics

When a paper reports quantitative results, do not leave the value only inside
`resultSummary`. Store structured numeric fields when extractable:

- `measurementValue`: primary numeric value.
- `measurementUnit`: unit such as `%`, `mg/L`, `umol`, `fold-change`, or count.
- `measurementDirection`: `increase`, `decrease`, `no_change`, or `mixed`.
- `measurementMin` / `measurementMax`: range when a range is reported.
- `timepoint`: experimental timepoint such as `9 days`.
- `condition`: experimental condition such as `thermal stress`.
- `pValue`: reported p-value when available.
- `sampleSize`: reported n when available.
- `statisticalTest`: named statistical test when available.

Rules:

- Do not infer a numeric field unless the quote supports it.
- Preserve the original quoted wording for auditability.
- If a number is approximate or ambiguous, store it with lower confidence or
  leave it in `resultSummary` until reviewed.
- Quantitative comparisons across papers should only use facts with compatible
  unit, condition, assay, and timepoint.

## Claim Verification

Each extracted fact should be verified after extraction.

Verifier input:

- extracted fact
- source title
- DOI
- evidence chunk
- quote

Verifier output:

```json
{
  "status": "supported",
  "confidence": "medium",
  "reason": "The quote directly reports chiro-inositol increase under heat stress.",
  "unsupportedFields": []
}
```

If a field is not supported, the verifier should either:

- remove the field
- downgrade confidence
- mark the fact as partial
- quarantine the fact as unsupported

## Retrieval Method

For a user query, retrieve in this order:

1. exact species facts
2. genus facts
3. family/higher taxon facts
4. compound/activity matches
5. ecosystem/geography analogies
6. external literature if internal evidence is insufficient

The answer should show these groups separately.

At answer time, Research Brain builds an evidence pack that includes:

- structured bioprospecting facts
- general supported, partial, contradicted, and open-question claims
- source title, DOI, internal paper link, fragment index, page when available, and quote/snippet
- a conservative evidence relationship label for each bioprospecting fact
- normalized taxon IDs when local taxonomy normalization has run
- a lightweight query plan with the detected question type, response strategy, suggested sections, external-literature fallback policy, and cautions

The chat agent and verifier should treat this evidence pack as the first source
of truth. If the pack contains no general claims and no bioprospecting facts, the
agent must say that the loaded papers do not provide enough evidence.

The query plan is not evidence by itself. It is only an answer-shaping guide so
species exploration, molecule exploration, bioactivity searches, comparisons,
application questions, evidence audits, quantitative searches, and reef-context
questions are handled with the right caution level.

Human review status is stored on each bioprospecting fact. Facts marked
`verified` should be preferred when otherwise relevant. Facts marked `incorrect`
or `quarantined` are excluded from normal evidence retrieval so the agent does
not continue using bad extractions. Reviewer notes are included in the evidence
pack and should be treated as human curation context, not as a replacement for
the quoted paper evidence.

Reviewer entity edits are allowed for extracted fields such as species, genus,
compound, bioactivity, application, assay/model, geography, ecosystem, and
condition. These edits correct the structured representation of the extracted
fact; they do not create new scientific evidence. Taxonomy-related edits should
trigger taxonomy re-normalization before the fact is treated as fully curated.

Current evidence relationship labels:

- `direct_species`: the fact species appears in the user query.
- `same_genus`: the user asks about a species in the same genus, but the fact is for another species.
- `genus_level`: the query asks at genus level or the fact is only genus-level.
- `same_family`: the query matches the family but not species/genus.
- `compound_or_activity`: the match is by compound, molecule class, bioactivity, or application.
- `ecological_analogy`: the match is by geography or ecosystem.
- `keyword_match`: weak retrieval hit; verify before using as a strong claim.

Only `direct_species` and explicit `genus_level` matches should be worded as
direct evidence. Same-genus, same-family, compound/activity, and ecological
matches should be introduced as research leads or indirect evidence.

Local taxonomy normalization creates canonical taxa and aliases from the
extracted fact fields. WoRMS enrichment can optionally attach Aphia identifiers,
accepted-name metadata, authority, status, LSID, URL, and aliases to the same
taxa. This external metadata must not replace existing fact provenance. GBIF and
NCBI Taxonomy can be added later using the same `external_ids` pattern.

When normalized taxa are available, retrieval should use them before plain text
matching:

1. exact species taxon ID
2. genus taxon ID
3. family taxon ID
4. text matches for compound, activity, application, ecosystem, and quote
5. structured measurement filters when the query specifies thresholds, units,
   direction, or condition

This allows a query for an unobserved species, such as another `Acropora`
species, to retrieve same-genus evidence while still labeling it as indirect.

For quantitative queries, the search layer may infer conservative filters from
phrases such as `over 500%`, `less than 100%`, `increase`, `decrease`, and
`thermal stress`. If a query names a compound and matching compound facts exist,
compound-specific results should be preferred over unrelated measurements.

## Answer Format

Recommended structure:

```text
Short answer

Direct evidence
- Claim + source + DOI + fragment + quote

Indirect evidence
- Same genus / same family / similar ecosystem

Hypotheses to test
- Clear experimental ideas, labeled as hypotheses

Limitations
- Missing species-level evidence, weak assays, review-only evidence, contradictions

Sources used
- Compact list of source titles and DOI links
```

## Examples

### Species Exploration

User:

> I have this anemone species in my region. What can I explore?

Agent behavior:

- identify exact species evidence
- if none, search genus/family
- search compounds and activities reported in related anemones/cnidarians
- search similar ecosystems
- answer with direct/indirect/hypothesis labels

### Activity Search

User:

> What anticancer precursors are reported in coral reefs?

Agent behavior:

- retrieve facts where `bioactivity` includes cytotoxic, anticancer, antiproliferative, apoptosis, cell line, tumor model
- require assay/model if making strong claims
- distinguish extract-level evidence from purified-compound evidence

### Cosmetic Application

User:

> Could this species be useful for facial cleansing or cosmetics?

Agent behavior:

- search antioxidant, anti-inflammatory, antimicrobial, barrier repair, collagen, wound healing, mucus, polysaccharides, peptides
- answer cautiously
- avoid "cosmetic use" unless the source explicitly supports cosmetic application
- otherwise label as "application hypothesis"

## Anti-Hallucination Rules

- Never invent DOI, page, species, molecule, assay, or activity.
- Never upgrade same-genus evidence into species-level evidence.
- Never call a compound anticancer unless the evidence says cytotoxic/anticancer/antiproliferative or equivalent.
- Never treat a review citation as primary experimental evidence unless labeled as review evidence.
- Never use the model's memory as source evidence.
- Always abstain when evidence is missing.

## Operational Lessons From The First Test

The initial two-paper run showed:

- extraction works and stores structured facts
- metabolomics papers can produce useful molecule/stress-response facts
- broad book/chapter papers produce more low-confidence textual mentions
- LLM extraction latency is high and must be moved to background jobs for large corpora
- corpus hygiene matters; internal project documents should not be in the ingestion folder

Immediate next engineering improvements:

- add ingestion dry-run
- add ignore patterns
- add per-source bioprospecting status
- add extraction timeout/retry per batch
- add queue-based extraction workers
- improve page/table/caption parsing
