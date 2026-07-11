# Proposal: Knowledge Graph Entity Graph (KG v2 — structural entity mention graph, LLM-free)

## Intent

The v1 knowledge graph made **compounds** consultable nodes. But every other "entity" the roadmap cares about — `bioactivity`, `application_area`, `assay_model` — is still **free text** on `research_bioprospecting_facts`. There is no way to ask "list the bioactivities we know about" or "expand this application_area to its compounds/facts/sources." This change fills that gap with a **read-only, LLM-free entity mention graph** over the existing columns, mirroring v1's additive shape.

This is **PR2 of the KG roadmap, and PR2 only**. It ships **Approach A + light query-time normalization**: read views over the existing free-text columns, plus a deterministic (non-LLM) normalizer so obvious spelling variants collapse to one node (`antifungal` = `anti-fungal` = `Antifungal`). The JSON API shape is designed so the future Approach-B canonical registry can swap in transparently, exactly as v1 promised for the co-occurrence CTE→table swap.

## Scope

### In Scope (PR2)
- **Read views** deriving entity nodes from the 3 free-text columns on `research_bioprospecting_facts`: `bioactivity`, `application_area`, `assay_model`. Live SQL views (always fresh, no refresh hook) so the change stays truly additive; a materialized-view + refresh promotion is a deferred perf optimization.
- **Deterministic normalization SQL function** `graph_normalize_entity(text)` — lowercase, trim, collapse internal whitespace, strip hyphens, plus a conservative optional singularization. LLM-free and pure. Used at view/query time only; original free-text values are never mutated.
- **Search within a kind** — distinct normalized entity values for a kind, each with `compound_count`, `fact_count`, `source_count`, and a display value.
- **Expand a single entity value (1-hop)** — the compounds / facts / sources linked to one normalized value, via an on-the-fly RPC over facts (mirrors the `graph_top_string_field` allowlisted-`%I` pattern).
- **New endpoints** under the existing `/api/research-brain/graph/*` prefix: `GET /graph/entities/:kind/search` and `GET /graph/entities/:kind/:value/expand`, reusing the admin-gated `authResolver({ required: true, role: "admin" })` pattern.
- **New read service helpers** in `src/services/researchBrain/graphService.ts` (`searchEntities`, `expandEntity`).

### Out of Scope (deferred to follow-up changes)
- **Approach B** — canonical registry tables (`research_graph_target_terms` / `application_terms`), typed `research_graph_entity_mentions`, write-path resolution, backfill scripts. Full synonym canonicalization (MeSH-grade, e.g. `cytotoxic ≈ anti-tumoral`) belongs here, NOT in this change.
- **PR3** — the LLM-driven fact↔fact / claim↔claim semantic linker (`graphLinkerAgent`), a separate feature-flagged, cost-guarded change.
- **Co-occurrence materialization** — `graph_top_co_occurring` already answers it on the fly; no `co_occurrences` table (v3 perf opt).
- **Additional entity kinds** — `geography`, `ecosystem`, `organism_part`, `compound_class`, `molecule_type`, `evidence_type`.
- **Any write-path change** — the extractor and `replaceBioprospectingFactsForSource` are untouched; no new extractor pass; no schema mutation of existing tables.

## Capabilities

### New Capabilities
- `bioprospecting-entity-graph`: LLM-free, read-only entity mention graph over the free-text `bioactivity` / `application_area` / `assay_model` columns, with query-time normalization, per-kind search, and 1-hop expand. Stable JSON contract designed for a transparent Approach-B backing swap.

### Modified Capabilities
- None. `bioprospecting-knowledge-graph` (v1) is unchanged; the facts/claims/sources schema is unchanged.

## Approach

- **Storage**: live SQL views (one per kind, or a single UNION view keyed by `kind`) that `SELECT graph_normalize_entity(col) AS value_normalized, ...` from `research_bioprospecting_facts`, `GROUP BY` the normalized value, aggregating `COUNT(DISTINCT compound_canonical_id)`, `COUNT(DISTINCT id)`, `COUNT(DISTINCT source_id)`. Auto-covers the current corpus, always fresh.
- **Normalization**: a pure SQL function collapses obvious variants; a `display` value (most frequent raw form per normalized key) is kept for UI. No LLM, no synonym dictionary.
- **Expand**: an allowlisted on-the-fly RPC filters facts where `graph_normalize_entity(col) = $value` and returns linked compounds/facts/sources — no precompute table.
- **API stability**: responses key entities by `{ kind, value }` (normalized) + `display` + counts, so a future Approach-B canonical `entity_id` can be added without breaking existing consumers.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `supabase/migrations/<date>_graph_entity_views.sql` | New | `graph_normalize_entity()` fn + entity read view(s) + expand RPC + GRANTs |
| `src/services/researchBrain/graphService.ts` | Modified | Add `searchEntities`, `expandEntity` (read-only helpers) |
| `src/routes/research-brain-graph.ts` | Modified | Add `/graph/entities/:kind/search` + `/graph/entities/:kind/:value/expand` |
| `src/services/researchBrain/bioprospectingExtractor.ts` | Untouched | No write-path change |
| `openspec/specs/bioprospecting-entity-graph/spec.md` | New | Spec written by sdd-spec |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Live view too slow at scale (per-request GROUP BY over facts) | Low (MVP corpus) | Cap `limit`; promote to matview + scheduled refresh if measured hot — API contract unchanged |
| Normalizer over-collapses distinct concepts (aggressive singularization) | Low | Keep singularization conservative/optional; display value preserves raw form; contested cases deferred to Approach B |
| `:kind` / `:value` path params open injection surface | Low | `:kind` validated against a fixed allowlist (3 kinds); `:value` bound as a parameter, never interpolated |
| API shape locks out Approach B | Low | Response keyed by `{kind, value}`; optional `entity_id` is purely additive later |

## Rollback Plan

1. Unregister the two new routes from `research-brain-graph.ts` → endpoints 404.
2. `DROP VIEW`/`DROP FUNCTION` for the entity views, normalizer, and expand RPC. No FK references, no dependent objects, no write-path hook to unwind.
3. Remove `searchEntities` / `expandEntity` from `graphService.ts`. No other module imports them.

## Dependencies

- `research_bioprospecting_facts` with the free-text `bioactivity` / `application_area` / `assay_model` columns and `compound_canonical_id` / `source_id` (existing).
- `authResolver({ required: true, role: "admin" })` (existing).
- Supabase service-role credentials (existing).

## Success Criteria

- [ ] `graph_normalize_entity()`, entity read view(s), and the expand RPC exist and cover the current corpus with no write-path change.
- [ ] `GET /graph/entities/:kind/search` returns distinct normalized values for each of the 3 kinds with `compound_count`, `fact_count`, `source_count`, and a display value; 400 on unknown `:kind`, 401/403 on auth, 200 on success.
- [ ] `GET /graph/entities/:kind/:value/expand` returns the linked compounds / facts / sources for one normalized value (1-hop).
- [ ] `antifungal`, `anti-fungal`, and `Antifungal` collapse to a single node.
- [ ] Extractor and existing tables are provably unchanged; the whole surface is LLM-free.
- [ ] Response shape leaves room for a future Approach-B `entity_id` without breaking consumers.
- [ ] New spec file `openspec/specs/bioprospecting-entity-graph/spec.md` written by sdd-spec.
