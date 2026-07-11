# Design: Graph Neighborhood Edges (de-star the graph)

## Technical Approach

Compose, don't store. Three existing helpers already hold every edge we need
(`expandEntity`, `getTopCoOccurring`, `buildCitationGraph`). We (1) fix the
citation candidate bug that makes one of them return nothing, (2) add a single
read-only composition endpoint that fans out to all three and returns a typed
`{nodes, edges}` graph including the **induced subgraph among the neighbors**,
and (3) make the client render that payload instead of stitching a star.

No tables, no stored edges, no refresh hook, no LLM, no migration.

---

## Part 1 — The DOI bug fix (`citationGraph.ts`)

### Before (`citationGraph.ts:257-276`)

```ts
let q = sb.from("research_sources").select("id, title, doi, trust_tier")
  .neq("id", sourceId).limit(candidateLimit);          // candidateLimit = min(500, limit*10)
if (sourceDoiLower) {
  q = q.ilike("doi", sourceDoi);                       // ← AND-filter. Kills every neighbor.
}
```

Two defects, not one:
1. When the source has a DOI, candidates collapse to same-DOI sources → shared-compound / shared-species neighbors are dropped.
2. When it does **not**, candidates are the *arbitrary first 500 rows* of `research_sources` — no semantic filter at all. Correct only by accident on a 14-source corpus.

### After — candidates come from a **union of three OR-branches**

The DOI stops being a filter and becomes one of three ways to *enter* the
candidate set; it keeps its existing role as a `+5` weight bonus at line 360-370
(`computeCitationWeight`, unchanged).

| # | Query (parallel where possible) | Yields |
|---|---|---|
| Q1 | `research_sources.select("id, doi").eq(id)` | focus DOI; `sourceFound` |
| Q2 | `research_bioprospecting_facts.select("compound_canonical_id, species_taxon_id").eq("source_id", sourceId)` | focus compound-id set + taxon-id set |
| Q3 | facts `.in("compound_canonical_id", focusCompoundIds).limit(FACT_SCAN_CAP)` | **branch A ids _and_ the shared-compound aggregate, in one query** |
| Q4 | facts `.in("species_taxon_id", focusTaxonIds).limit(FACT_SCAN_CAP)` | **branch B ids _and_ the shared-species aggregate** |
| Q5 | `research_sources.select("id").ilike("doi", sourceDoi).neq("id", sourceId)` — skipped when the focus has no DOI | branch C ids |
| Q6 | `research_sources.select("id, title, doi, trust_tier").in("id", candidateIds)` | candidate hydration |

`candidateIds = (A ∪ B ∪ C) \ {sourceId}`, **capped at the existing
`candidateLimit = min(500, limit * 10)`** (compound-branch ids first, then
species, then DOI — the ordering matches the weight coefficients 3 > 2, and DOI
hits are rare). Q3/Q4/Q5 run in one `Promise.all`; Q6 follows. Steps 4-6 of the
current function (compose → `computeCitationWeight` → sort desc → `slice(0, limit)`)
are **untouched**: top-N-by-weight is preserved, the query stays bounded, and the
public signature/return type of `buildCitationGraph` is unchanged (it must stay
composable — the new endpoint calls it).

Round trips: 4 today (2 of them useless) → 4 sequential rounds / ≤6 queries.
Delete the misleading comment at `citationGraph.ts:264-269` (it promises an
EXISTS fallback that was never written).

**Rejected**: just deleting the `.ilike` line. It fixes the reported symptom on
today's 14-source corpus and leaves defect 2 — a silent, unbounded-scan landmine
at 1000 sources. Not worth the 20 saved lines.

---

## Part 2 — `GET /api/research-brain/graph/neighborhood`

### Route + params (`src/routes/research-brain-graph.ts`)

Mirrors the file's existing shape: same `/api/research-brain` prefix,
`{ beforeHandle: authResolver({ required: true }) }`, `400` on bad input,
`500 { error: "internal_error" }` on throw, `logger.error` with an event name.

| Param | Required | Values |
|---|---|---|
| `type` | yes | `entity` \| `compound` \| `source` |
| `kind` | iff `type=entity` | `ENTITY_KINDS` allowlist (else 400 `{error:"unknown entity kind", allowed}`) |
| `value` | iff `type=entity` | URL-decoded normalized key, passed to `expandEntity` **verbatim** (no re-normalization — `graphService.ts:585-589`) |
| `id` | iff `type=compound\|source` | UUID (else 400) |
| `limit` | no | 1-100, default 20 — neighbors per class |
| `fanout` | no | 1-5, default 3 — neighbor expansions used for induced edges |

Why this scheme: entity identity is `(kind, value)`; compound/source identity is
a UUID. One `type` discriminant + a disjoint param set beats overloading a single
opaque `node=entity:bioactivity:antifungal` string (unparseable — values contain
`:`; the client already hits this at `GraphExplorerPage.tsx:416-418`).

**404** when a `compound`/`source` id does not resolve. **200 with the focus node
and zero edges** when an entity matches nothing — empty-is-not-error, per the
`expandEntity` contract.

### Response types (new, exported from `graphService.ts`)

```ts
export type GraphNodeType = "entity" | "compound" | "source";   // facts stay EDGES
export type GraphEdgeType =
  | "has_compound"     // focus entity  → compound        (spoke)
  | "has_source"       // focus         → source          (spoke)
  | "reports"          // compound      ↔ source          (fact-backed, induced)
  | "co_occurs_with"   // compound      ↔ compound        (induced)
  | "related_source";  // source        ↔ source          (induced, citation)

export type NeighborhoodNode = {
  id: string;      // "entity:{kind}:{value}" | "compound:{uuid}" | "source:{uuid}"
  type: GraphNodeType;
  label: string;
  meta?: { kind?: string; value?: string; factCount?: number; doi?: string | null; url?: string | null };
};
export type NeighborhoodEdge = {
  source: string;  // node id
  target: string;  // node id
  type: GraphEdgeType;
  weight: number;  // comparable WITHIN a type only — see below
  label?: string;
};
export type NeighborhoodResult = {
  focus: NeighborhoodNode;
  nodes: NeighborhoodNode[];
  edges: NeighborhoodEdge[];
  meta: { limit: number; fanout: number; elapsed: number; counts: { nodes: number; edges: number } };
};
```

Node id format is deliberately identical to the client's current convention
(`GraphExplorerPage.tsx:158, 167, 178`) so `GraphCanvas` needs no id migration.

### Weight per edge type

| Type | Weight | Source |
|---|---|---|
| `has_compound` | compound `fact_count` | `expandEntity` payload |
| `has_source` | source `fact_count` | `expandEntity` payload / fact-link count |
| `reports` | # facts joining that compound to that source | in-process count over fact links |
| `co_occurs_with` | RPC `fact_count` (shared-source ranking) | `getTopCoOccurring` |
| `related_source` | `CitationEdge.weight` = `3·compounds + 2·species + 5·doi` | `buildCitationGraph` |

Weights are **NOT normalized across types** — a `related_source` 11 and a
`co_occurs_with` 11 are different units. The endpoint returns raw values; the
client normalizes per type for stroke width. Faking a global scale would be a lie.

### Composition algorithm (`composeNeighborhood` in `graphService.ts`)

```
1. RESOLVE FOCUS
   entity   → expandEntity({kind, value, limit})     → compounds[], sources[]  (facts ignored for edges)
   compound → getCompoundsByIds([id])  (label, 404 if empty)
              getTopCoOccurring(id, limit)           → neighbor compounds
              getFactLinks({compoundIds:[id]})       → neighbor source ids
   source   → getSourcesByIds([id])    (label, 404 if empty)
              getFactLinks({sourceIds:[id]})         → neighbor compound ids
              buildCitationGraph({sourceId: id, limit}) → neighbor sources
   (hydrate any bare ids via getSourcesByIds / getCompoundsByIds — 1 batched query each)

2. SPOKES  focus → each neighbor:  has_compound | has_source

3. INDUCED SUBGRAPH  (N_c = neighbor compounds, N_s = neighbor sources)
   a. reports          1 query:  getFactLinks({ compoundIds: N_c, sourceIds: N_s })
                       keep links where BOTH endpoints ∈ neighbor set; weight = count
   b. co_occurs_with   skip if |N_c| < 2. Take top `fanout` of N_c by fact_count →
                       Promise.all(getTopCoOccurring(cid, limit)) → KEEP ONLY edges whose
                       other endpoint ∈ N_c  (this is what makes it *induced*)
   c. related_source   skip if |N_s| < 2. Take top `fanout` of N_s by fact_count →
                       Promise.all(buildCitationGraph({sourceId, limit})) → KEEP ONLY edges
                       whose otherSourceId ∈ N_s

4. DEDUPE + EMIT
   nodes: Map<id, node>, first write wins (focus written first)
   edges: Map<key, edge>, key = `${type}|${[a,b].sort().join("|")}`  → undirected dedupe,
          max weight wins on collision. Drop self-edges and edges whose endpoint ∉ nodes.
   sort edges by weight desc; return.
```

**Fan-out bound (the N+1 guard).** Only `fanout` (default 3, max 5) neighbors are
expanded per class, not all `limit` of them. Worst case DB round trips for an
entity focus:
`1 (expand) + 1 (fact links) + 5 (co-occur RPCs) + 5 × 6 (citation graph) = 37`,
all inside two `Promise.all` waves. Default (`fanout=3`): `1 + 1 + 3 + 18 = 23`.
`buildCitationGraph` is the expensive term — hence the tight cap and the
`|N_s| < 2` short-circuit.

**Rejected**: deriving `related_source` in-process from the fact-link table (0
extra queries). It would only see shared compounds *already in the neighbor set*,
silently drop shared-species and DOI signals, and duplicate the weighting formula
in a second place. Calling `buildCitationGraph` also exercises the Part-1 fix on
the real path.

---

## Part 3 — Frontend

### `client/src/components/graph/GraphCanvas.tsx`

```ts
export type GraphEdgeType =
  "has_compound" | "has_source" | "reports" | "co_occurs_with" | "related_source";

export interface GraphEdge extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  type: GraphEdgeType;   // NEW — required; the endpoint is now the only producer
  weight: number;        // NEW — required
  label?: string;        // unchanged
}
```

- `EDGE_STROKE: Record<GraphEdgeType, string>` — spokes stay `#334155` (grey,
  structural); `co_occurs_with` green (matches the compound node fill `#4ade80`),
  `related_source` purple (`#a78bfa`, the source fill), `reports` slate-blue.
  Cross-edges are the story: higher `stroke-opacity` (0.9) than spokes (0.45).
- Stroke width = `1 + 3 * (weight / maxWeightForItsType)`, clamped `[1, 4]`.
  Max is computed **per type** over the current edge array (see weight note above).
- New optional prop `hiddenEdgeTypes?: GraphEdgeType[]` → filtered out of
  `simLinks` before the force sim (line 92-98). `<title>{type} · {weight}</title>`
  per `<line>` for hover inspection.
- `NODE_FILL` / `NODE_RADIUS` / d3 setup unchanged. **No new node types.**

### `client/src/pages/GraphExplorerPage.tsx`

| Delete | Replace with |
|---|---|
| `stitchEntityExpansion` (154-209) — the filler-edge loop at 203-206 is literally what draws the star | one `apiGet<NeighborhoodResult>("/graph/neighborhood?…")` → `setElements(data)` |
| `stitchCompound` (211-242) | same call, `type=compound&id=…` |
| `overlayCitations` (383-412) + `overlay` state + the `canvasElements` merge memo (269-280) | clicking a source node now **re-focuses** it: `type=source&id=…` |

`handleNodeClick` (414-427) keeps its `node.id` → param mapping (entity ids split
on the first two `:`), but routes every type through one `focusNode()` call.
The DetailCard keeps its existing `/expand` and `/compounds/search?expand=true`
fetches (it needs fact quotes/pages/DOIs, which the graph payload deliberately
does not carry) — fired **in parallel** with the neighborhood call.

**Rejected**: embedding an `expansion` block in the neighborhood response. It
would couple a graph contract to a detail-panel view model for one saved round
trip. The graph endpoint returns a graph.

---

## Part 4 — Coverage measurement

Run against the live DB; record the numbers in the verify report (they scope Slice 1).

```sql
SELECT count(*)                                                    AS facts,
       count(DISTINCT source_id)                                   AS sources,
       count(compound_canonical_id)                                AS with_compound,
       round(100.0 * count(compound_canonical_id) / nullif(count(*),0), 1) AS pct_compound,
       count(species_taxon_id)                                     AS with_taxon,
       round(100.0 * count(species_taxon_id) / nullif(count(*),0), 1)      AS pct_taxon,
       count(*) FILTER (WHERE compound_canonical_id IS NOT NULL
                          AND species_taxon_id IS NOT NULL)        AS with_both
FROM research_bioprospecting_facts;

-- how many sources could EVER get a citation edge (needs ≥1 canonical key)
SELECT count(*) FILTER (WHERE n_compound > 0) AS sources_with_compound,
       count(*) FILTER (WHERE n_taxon > 0)    AS sources_with_taxon,
       count(*)                               AS sources_total
FROM (SELECT source_id,
             count(compound_canonical_id) AS n_compound,
             count(species_taxon_id)      AS n_taxon
      FROM research_bioprospecting_facts GROUP BY source_id) s;
```

If `pct_compound` is ~0, `related_source` and `co_occurs_with` yield nothing and
the star persists for reasons this change cannot fix — that outcome must be
reported loudly, not buried.

---

## File Changes

| File | Action | Description |
|---|---|---|
| `src/services/researchBrain/citationGraph.ts` | Modify | Candidate query → 3-branch OR union (Part 1). Weighting/sort/limit untouched. |
| `src/services/researchBrain/graphService.ts` | Modify | New types + `composeNeighborhood()` + 3 batched helpers: `getFactLinks`, `getSourcesByIds`, `getCompoundsByIds`. Reuses the Proxy client (TDZ-safe, `graphService.ts:42-51`) and `clampLimit`. |
| `src/routes/research-brain-graph.ts` | Modify | `GET /graph/neighborhood`, `authResolver({required:true})`, same 400/404/500 shape as the 3 existing routes. |
| `client/src/components/graph/GraphCanvas.tsx` | Modify | `GraphEdgeType`, `GraphEdge.{type,weight}`, per-type stroke/width, `hiddenEdgeTypes`. |
| `client/src/pages/GraphExplorerPage.tsx` | Modify | Delete both stitchers + the overlay path; fetch `/graph/neighborhood`. |
| `src/services/researchBrain/__tests__/citationGraph.test.ts` | Modify | The DOI-branch tests currently assert the buggy AND-filter — they must be rewritten to assert the OR-union. |

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Unit | Candidate union: DOI-bearing source still returns shared-compound neighbors (**the regression test for the bug**); no-DOI source; DOI still adds `+5`; `candidateLimit` cap holds | Extend the existing mock-DB harness in `citationGraph.test.ts` (`.from()` chain fakes) |
| Unit | `composeNeighborhood`: induced edges kept only when both endpoints ∈ neighbor set; undirected dedupe; fan-out ≤ `fanout` (assert RPC call count); `|N| < 2` short-circuit | Mock `expandEntity` / `getTopCoOccurring` / `buildCitationGraph` |
| Route | 400 (bad `type`/`kind`/non-UUID `id`), 404 (unknown id), 200-empty (unmatched entity), 401 (no auth) | Mirror `research-brain.graph.routes.test.ts` |
| Manual | `/graph` on a focus node with ≥2 related neighbors renders a connected subgraph, not a star | Browser |

## Migration / Rollout

No migration. No feature flag: the endpoint is additive and read-only, and the
`citationGraph` change is a bug fix whose current behavior is "return nothing".
Rollback = revert the commit; there is no data to unwind.

## Out of Scope

LLM semantic linker; fact↔fact edges in `research_edges`; facts as graph nodes;
the `contradictionLlM.ts` id bug; the compound-detail-by-name fetch hack in
`GraphExplorerPage` (`focusCompound`, line 352-360) — ugly, but not this change.

## Open Questions

- [ ] `fanout` default 3 vs 5 — 3 is safe; the real answer depends on the coverage
      numbers from Part 4. Ship 3, revisit with data.
