# Exploration: entity-field-canonicalization (Approach-B synonym canonicalization)

> SDD explore phase. Artifact store: openspec. Date: 2026-07-11.
> Goal: add synonym-level canonical identity to the entity graph so synonymous
> values (`cytotoxic` ≈ `anti-tumoral`) collapse into one node, densifying the
> graph (nodes currently average ~1.5 facts each).

## Key finding (changes the plan)

The graph's ~1.5 facts/node is driven by **verbose non-categorical extractor
output, NOT latent synonymy**. The extractor LLM prompt
(`bioprospectingExtractor.ts:246-287`) applies NO categorical constraint to
`bioactivity` / `application_area` / `assay_model` — they are free-text, so the
model emits full sentences (e.g. "activate AMPK and upregulate IRS-1/PI3K/Akt
signaling pathway"). A synonym registry **cannot** merge two distinct verbose
sentences; it only helps where the corpus contains short synonymous labels
(`antifungal` ≈ `antimycotic`). So synonym-canonicalization on `bioactivity`
yields **little densification** against the current extractor output. The real
lever for `bioactivity` is extraction quality (Approach E), not a synonym registry.

## Current state (what we shipped)

`bioprospecting-entity-graph`: read-only, LLM-free view over the 3 free-text
columns, with `graph_normalize_entity` (deterministic: lowercase, strip hyphens,
collapse ws, conservative singularization). Collapses SURFACE variants
(`antifungal`=`anti-fungal`) but NOT synonyms. Designed with a STABLE
`{kind, value, display}` API and a reserved additive `entity_id` (spec "API
Stability for a Future Approach-B Canonical Backing"; `EntityNode` reserves
`entity_id?`), so a canonical id slots in without breaking consumers.

## Canonicalization precedent (mirror this)

- **Compounds**: `research_compounds` (`normalized_name UNIQUE`, `status`
  provenance) + `research_compound_aliases` + `compound_authority_audit` + FK
  `compound_canonical_id` on facts + accept-as-canonical `status='local'` upsert.
- **Taxa**: `research_taxa` (`UNIQUE(rank, normalized_name)`) + `research_taxon_aliases`
  + FK columns on facts; source-agnostic (external IDs attach later).
- Both are WRITE-PATH registries (canonical id stamped on the fact). An entity-term
  registry would copy: normalized_name UNIQUE, alias table, status/provenance, and
  an accept-as-canonical upsert.

## Per-kind reality

- **`bioactivity`** — verbose, sentence-like, low true-synonymy-per-node. Registry
  yield low until extraction is fixed.
- **`application_area`** — most categorical/enumerable (cosmetics, biomaterials,
  anticancer, agriculture, nutraceuticals). Highest registry yield, lowest false-merge risk.
- **`assay_model`** — semi-categorical (cell lines, animal models, assay types);
  maps to BAO but messy long tail.

## Approaches

| # | Approach | Yield | Cost | False-merge risk | Effort |
|---|----------|-------|------|------------------|--------|
| A | Curated seed synonym registry (deterministic, LLM-free), mirrors compounds/taxa | Covers curated set; low on messy tail; useless on verbose phrases | free | Low (controllable) | Low-Med |
| B | Ontology-backed (MeSH / BAO / ChEBI roles) | High for application/assay; external IDs | integration | Med | High |
| C | LLM synonym clustering (feature-flagged, cost-gated) | Highest for messy phrases | LLM $ | HIGH (hallucinated merges) — worst failure mode | High |
| D | Embedding clustering (reuse src/embeddings) | Near-duplicates | med | High (semantic-near ≠ synonym) | Med-High |
| E | Fix the extractor to emit categorical labels (short term in field, verbose in result_summary) | Attacks the actual root cause of ~1.5 avg | cheap prompt + backfill | needs eval | Low prompt + Med backfill |

## Recommendation — sequencing

**Do NOT lead with a synonym registry on `bioactivity`** — the ~1.5 avg is a
data-quality problem, not a synonymy problem.

1. **First slice — Approach A scoped to `application_area` ONLY** (the categorical
   kind), mirroring compounds/taxa 1:1: `research_entity_terms` +
   `research_entity_term_aliases` (per-kind, `normalized_name UNIQUE`, status/
   provenance, accept-as-canonical `status='local'`), resolved at **read-time**
   first (a `canonical_id` on the live view via LEFT JOIN on the alias table),
   exposing the reserved additive `entity_id` on `EntityNode`. Read-time keeps it
   additive/reversible/fresh (matches the shipped graph philosophy) and lets you
   measure densification before committing to a write-path FK.
2. **Sibling change — Approach E** (extractor prompt: emit a short categorical
   label + keep the verbose text in `result_summary`). The real densification
   lever for `bioactivity`. Separate change — it touches the write path the graph
   change deliberately avoided.
3. **Defer** B (ontology — right long-term backing for application/assay external
   IDs), C/D (LLM/embedding clustering — only earn their wrong-merge risk once
   values are short categorical labels, and must ship behind a human-review gate).

**Read-time vs write-time**: start read-time (view LEFT JOIN alias → canonical;
additive, reversible, always fresh). Promote to write-time (`*_entity_term_id` FK
on the fact) only if the join cost is measured hot. `entity_id` is additive either way.

**Per-kind scoping**: start `application_area`, then `assay_model`; treat
`bioactivity` as blocked-on-extraction-quality (Approach E), not blocked-on-registry.

## Risks

- **False-merge is the dominant, asymmetric risk**: merging two genuinely-distinct
  bioactivities is worse than leaving them split. Non-deterministic approaches (C/D)
  need a human-review gate.
- **Low-yield trap**: a `bioactivity` synonym registry could burn effort for near-zero
  densification (verbose values).
- **Write-path scope creep**: Approach E and a write-time FK cross the additive/read-only
  boundary the graph change kept — separate change(s).
- **Backfill gap**: Approach E only helps new extractions unless paired with re-extraction.
- **Embeddings mismatch**: `src/embeddings` has no clustering primitives; D is net-new.

## Open product questions (decide before proposal)

1. Goal = **densification metrics** (raise avg facts/node) or **answer quality**
   (better "list the bioactivities we know")? Different approaches.
2. Willing to **touch the extractor/write path** (Approach E), or must this stay
   additive/read-only like the shipped graph?
3. Which kind is the actual priority — the brief implies `bioactivity`, but the data
   says `application_area` is where a registry pays off. Confirm scope.
4. Is a **manual curation surface** (admin accept/merge, like compound-authority) in
   scope, or a one-shot seed?
5. Reserve **external ontology IDs** (MeSH/BAO/ChEBI) now (like taxa's WoRMS/GBIF) even
   if unused in v1?
6. Acceptable **false-merge tolerance** — zero (deterministic only) or "some, with a
   review gate" (unlocks C/D)?
