# Proposal: Graph Neighborhood Edges (de-star the graph)

## Intent

`/graph` ego graphs render as disconnected stars. Exploration proved this is **not** missing semantics — it is a bug plus a rendering gap:

- **Bug**: `citationGraph.ts:263-271` applies `.ilike("doi", sourceDoi)` as an **AND-filter** on the candidate query. Any source *with* a DOI (i.e. every real paper) sees its candidate set narrowed to same-DOI sources, silently dropping every shared-compound / shared-species neighbor. The source↔source overlay returns ~nothing.
- **Gap**: the client stitches the ego graph from ONE `expand` payload. Cross-node edges that already exist server-side (`getTopCoOccurring` compound↔compound, `buildCitationGraph` source↔source) are **never fetched**. `GraphEdge` is `{source,target,label?}` — it cannot even carry a type.

Zero LLM is needed. Fix the bug, expose the induced subgraph, render it.

## Scope

### In Scope

1. **Bug fix** — `citationGraph.ts`: DOI match becomes an **OR-branch bonus signal**, not a candidate filter. Shared-compound/species neighbors are returned again.
2. **New endpoint** — `GET /api/research-brain/graph/neighborhood`: typed `{nodes, edges}` for a focus node = 1-hop neighborhood **plus the induced subgraph among those neighbors**. Composed **on-the-fly** from `expandEntity` + `getTopCoOccurring` + `buildCitationGraph`. No new tables, no stored edges, no refresh hook (house precedent). `authResolver({required:true})`.
3. **Frontend** — `GraphExplorerPage` consumes `/graph/neighborhood`; `GraphEdge` extended to `{source, target, type, weight, label?}` so cross-edges are styleable/filterable in `GraphCanvas`. **No new node types** — facts stay edges.
4. **Measure** — report `compound_canonical_id` / `species_taxon_id` non-null coverage, so the next slice is scoped on data, not hope.

### Out of Scope

- **LLM semantic linker (original PR3).** 14 sources / ~470 facts = 110,215 mostly-unrelated pairs → the model is incentivized to invent. We have **proof this failure is invisible**: the LLM contradiction tier has inserted ZERO rows since it shipped (payload omits fact ids; `facts.find(...)` never matches). Deferred behind: (a) measured evidence deterministic edges are insufficient, (b) an LLM cost guard — `costService` covers only `mistral_ocr` and `pubchem`, so any LLM linker is **unbounded spend** today, (c) a human review gate.
- **Slice 1 — deterministic fact↔fact edges in `research_edges`.** Requires promoting facts to first-class NODES (real UI model change), hub suppression, and a unique constraint on `research_edges`.
- **`contradictionLlM.ts` id bug.** KNOWN BUG, dead code, **separate follow-up change** — not graph work. Do not bundle.

## Capabilities

### New Capabilities
- `graph-neighborhood-edges`: typed neighborhood endpoint returning 1-hop nodes + induced subgraph edges (`type`, `weight`), on-the-fly, read-only, auth-gated.

### Modified Capabilities
- `bioprospecting-knowledge-graph`: citation candidate selection — DOI becomes an OR-branch bonus, not an AND-filter.
- `graph-explorer-ui`: v2 — page consumes `/graph/neighborhood` instead of client-side stitching; `GraphEdge` carries `type` + `weight`.

## Approach

Compose, don't store. Every edge already exists in or is derivable from current data; the endpoint fans out to the three existing helpers, dedupes, and returns a single typed payload. The bug fix is a prerequisite — without it the citation overlay contributes nothing.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/services/researchBrain/citationGraph.ts` | Modified | DOI AND-filter → OR-branch bonus |
| `src/services/researchBrain/graphService.ts` | Modified | Neighborhood composition helper |
| `src/routes/research-brain-graph.ts` | Modified | `GET /graph/neighborhood`, `authResolver({required:true})` |
| `client/src/pages/GraphExplorerPage.tsx` | Modified | Fetch neighborhood, drop client stitching |
| `client/src/components/graph/GraphCanvas.tsx` | Modified | Style/filter by edge `type`/`weight` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Fix widens candidate set → slower citation query | Med | Existing `candidateLimit` cap + top-N-by-weight retained |
| Induced subgraph too dense (hairball) | Med | `weight` on every edge → client-side threshold/filter |
| Canonical-id coverage too low to yield edges | Med | Item 4 measures it; free-text entity keys give a floor |
| Frontend edge-model change breaks existing render | Low | Additive fields; `label?` preserved |

## Rollback Plan

Revert the commit. All changes are additive except the one-line-ish `citationGraph.ts` filter change; no migrations, no stored edges, no data to unwind. Reverting restores the previous (broken) behavior with zero cleanup.

## Dependencies

None. Uses existing helpers, tables, and auth middleware.

## Success Criteria

- [ ] Citation overlay returns shared-compound/species neighbors for DOI-bearing sources (was ~zero).
- [ ] `GET /graph/neighborhood` returns edges **between neighbors**, not only spokes to the focus node.
- [ ] `/graph` renders a connected subgraph, not a star, for a focus node with ≥2 related neighbors.
- [ ] Canonical-id coverage numbers reported and recorded for Slice 1 scoping.
- [ ] No new tables, no refresh hooks, no LLM calls introduced.
