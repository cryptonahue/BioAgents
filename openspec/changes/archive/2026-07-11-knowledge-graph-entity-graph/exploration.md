# Exploration: knowledge-graph-entity-graph (KG v2 — entity mention graph + co-occurrence)

> SDD explore phase. Artifact store: openspec. Change: `knowledge-graph-entity-graph`.
> Date: 2026-07-10. Scope target: PR2 of the KG roadmap (entity mention graph + co-occurrence).

## v1 foundation recap (verified in code)

The shipped Knowledge Graph v1 is a **compound-centric read layer**, purely additive:
- **`research_graph_compound_aggregates`** materialized view
  (`20260615030000_graph_compound_aggregates.sql`): one row per canonical compound with
  `fact_count / source_count / claim_count / first_seen_at / last_seen_at`. `LEFT JOIN`
  keeps zero-fact compounds.
- **`refresh_compound_aggregates()`** soft-fail SQL fn (`EXCEPTION WHEN OTHERS → RAISE
  WARNING`), called post-extraction from `bioprospectingExtractor.ts`.
- Two on-the-fly RPCs: `graph_top_co_occurring` (compound↔compound by shared `source_id`)
  and `graph_top_string_field` (top `geography`/`bioactivity` per compound via allowlisted
  `format('%I')` dynamic SQL).
- Read service `src/services/researchBrain/graphService.ts`; route
  `src/routes/research-brain-graph.ts` — `GET /api/research-brain/graph/compounds/search`,
  admin-gated via `authResolver({ required:true, role:"admin" })`.

**Two pre-existing assets the roadmap docs under-emphasized:**
1. **`research_edges` already exists and is generic** (`from_id, from_type, relation_type,
   to_id, to_type, metadata`, indexed both directions) — used ONLY for `claim → source`
   edges via `createClaimEdges` (`db.ts:354`). Ready substrate for fact↔fact / claim↔claim
   (PR3), though typing is free-text.
2. **`citationGraph.ts`** is an existing LLM-free paper↔paper graph (shared compound /
   species / DOI, weighted, computed on-the-fly, no precompute table). Exact precedent for
   the co-occurrence approach: the team already chose "on-the-fly SQL, defer materialization."

## Gap analysis — what exists vs what's missing

Entity **canonicalization** exists for exactly two entity types:
- **Compounds** → `research_compounds` + `research_compound_aliases` (PubChem/ChEBI).
- **Taxa** → `research_taxa` + `research_taxon_aliases`, with `species/genus/family_taxon_id`
  FKs on facts.

Everything else the roadmap calls an "entity" is still **free text** on
`research_bioprospecting_facts`: `bioactivity`, `application_area`, `assay_model`,
`geography`, `ecosystem`, `organism_part`, `compound_class`, `molecule_type`,
`evidence_type`. No canonical node identity → synonyms split, no typed edges, no "expand
this bioactivity" path. **That is the gap the entity mention graph fills.**

## Recommended slicing: TWO changes, thin first slice

- **This change (`knowledge-graph-entity-graph`) = PR2 only**: structural, LLM-free entity
  mention graph + (optional) co-occurrence. Additive, cheap, reviewable.
- **PR3 (LLM-driven fact↔fact / claim↔claim linker, `graphLinkerAgent`) = a separate future
  change**, feature-flagged and cost-guarded (mirror `BIOPROSPECTING_CONTRADICTION_DETECTION`
  + cost guard rails).

**First shippable slice (thin, additive, LLM-free):** read-only entity graph over existing
free-text columns — no write-path change, no new extractor pass, no backfill (a matview
backfills automatically). Mirrors v1's matview + refresh-hook + read-endpoint shape.

Co-occurrence materialization is **low urgency** — `graph_top_co_occurring` already answers
it on the fly, and the v1 spec labels a `compound_co_occurrences` table a v3 perf
optimization. Recommend keeping co-occurrence on-the-fly; spend the slice budget on the
**entity** graph (the actual missing capability).

## Approaches compared

| # | Approach | Pros | Cons | Effort |
|---|----------|------|------|--------|
| **A** | Read-only matviews / on-the-fly SQL over existing free-text columns (entity aggregates + entity co-occurrence). No new edge table, no write-path change. | Purely additive; auto-backfills existing corpus; zero extractor risk; mirrors v1 + `citationGraph` precedent; LLM-free; correct on re-extraction. | No canonical identity — synonyms stay split; no cross-type typed edges; free-text grouping only. | Low |
| **B** | Typed `research_graph_entity_mentions` table + curated `target_terms`/`application_terms` registries + deterministic post-extraction resolution pass (LLM-free). | Real canonical nodes → synonym collapse; typed 1-hop expand across kinds; extends the compounds/taxa pattern. | Touches write path (`replaceBioprospectingFactsForSource`); needs idempotent soft-fail hook + backfill script; registry seeding is an open question. | Medium |
| **C** | Reuse generic `research_edges` for entity mentions. | No new schema; indexes exist. | `to_id` must be UUID but bioactivity/application are free text → needs registry rows anyway; untyped relation; pollutes claim→source table. | Low-Med |

## Recommended approach

**Ship Approach A as slice 1, then Approach B as slice 2 of the same change**, with a stable
JSON API shape so B is a transparent backing swap (as v1 promised for the co-occurrence
CTE→table swap). Reject C (needs B's registry anyway, degrades an existing table). Reuse the
admin-only `authResolver` gate and the `/api/research-brain/graph/*` prefix; new endpoints
like `/graph/entities/:kind/search` and `/graph/entities/:kind/:value/expand`.

## Open product questions (resolve before proposal)

1. **Canonical identity now, or defer?** Synonym-collapsing of bioactivities/applications a
   v-now requirement (→ B, write-path + registry), or is free-text grouping (A) acceptable
   for the first slice?
2. **Which free-text fields become graph entities?** Candidates: `bioactivity`,
   `application_area`, `assay_model`, `geography`, `ecosystem`, `organism_part`,
   `compound_class`. Recommended first-slice subset: `bioactivity` + `application_area` +
   `assay_model`.
3. **Co-occurrence: materialize now or keep on-the-fly?** Recommend defer (v3 perf opt; CTE
   already works).
4. **Confirm the two-change split** — PR3 (LLM linker) as a separate feature-flagged change.
5. **Registry seeding (only if B):** curated seed (~50 terms), MeSH/UniProt, or one-shot LLM
   distillation? (LLM expansion moves it out of "LLM-free".)
6. **Backfill policy (only if B):** script-backfill existing facts, or grow organically?
   (Approach A sidesteps this.)

## Status

- **Recommended next**: sdd-propose (frame as PR2 only, Approach A first slice; resolve
  questions 1/2/4 with the user first).
- **Risks**: Approach B touches the extractor write path (must be idempotent + soft-fail);
  registry seeding for B is unresolved; pulling in co-occurrence materialization duplicates
  working on-the-fly logic for no measured benefit.
