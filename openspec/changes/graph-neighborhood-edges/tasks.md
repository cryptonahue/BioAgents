# Tasks: graph-neighborhood-edges

Delivery: 2 commits. Commit 1 = backend (this batch). Commit 2 = frontend.

## Phase 1 — Backend (commit 1)

- [x] 1.1 `citationGraph.ts`: replace the DOI AND-filter with a 3-branch OR
      union (shared compound ∪ shared species ∪ same DOI), keep the DOI's +5
      weight bonus, keep top-N-by-weight, keep `buildCitationGraph`'s
      signature/return shape.
- [x] 1.2 `citationGraph.ts`: kill defect #2 — a focus with no canonical keys
      and no DOI no longer falls through to an arbitrary 500-row scan of
      `research_sources`. Branch scans bounded by `CITATION_FACT_SCAN_CAP`;
      candidate set still bounded by `candidateLimit = min(500, limit * 10)`.
- [x] 1.3 REWRITE `__tests__/citationGraph.test.ts`: the old `buildCitationGraph`
      tests scripted the buggy AND-filter query order and therefore encoded the
      bug. New fixture-driven fake DB; tests now assert the OR-union
      (DOI-bearing focus returns shared-compound / shared-species neighbors),
      the DOI bonus, self-exclusion, intersection semantics, and the bound.
- [x] 1.4 `graphService.ts`: neighborhood types (`GraphNodeType`,
      `GraphEdgeType`, `NeighborhoodNode/Edge/Result`), `FocusNotFoundError`,
      node-id helpers.
- [x] 1.5 `graphService.ts`: 3 batched helpers — `getFactLinks`,
      `getSourcesByIds`, `getCompoundsByIds`.
- [x] 1.6 `graphService.ts`: `composeNeighborhood()` — focus resolution, spokes,
      induced subgraph (`reports` / `co_occurs_with` / `related_source`) pruned
      to the neighbor set, undirected dedupe (max weight wins), fan-out bound,
      `< 2 neighbors` short-circuit, sort by weight desc.
- [x] 1.7 `research-brain-graph.ts`: `GET /graph/neighborhood`,
      `authResolver({ required: true })`, `type` + (`kind`,`value` | `id`),
      `limit` 1-100 (default 20), `fanout` 1-5 (default 3), 400/404/500 shapes
      matching the file's existing routes.
- [x] 1.8 Tests: `graphService.neighborhood.test.ts` (induced-edge pruning,
      dedupe, fan-out bound, short-circuit, 404 signals) + `/graph/neighborhood`
      param-validation tests in `research-brain.graph.routes.test.ts`.
- [x] 1.9 Coverage measurement: SQL snippet committed in the `citationGraph.ts`
      header + design.md Part 4. Live numbers to be recorded in the verify
      report (known from prod: ~278/472 facts carry a canonical compound).

## Phase 2 — Frontend (commit 2)

- [x] 2.1 `GraphCanvas.tsx`: `GraphEdgeType`, required `GraphEdge.{type,weight}`,
      per-type stroke color/opacity (spokes 0.45, cross-edges 0.9), per-type
      normalized stroke width (`1 + 3*(w/maxOfItsType)`, clamped `[1,4]`),
      `hiddenEdgeTypes` prop, `<title>` hover. Exports `EDGE_STROKE` /
      `EDGE_LABEL` for the page legend.
- [x] 2.2 `GraphExplorerPage.tsx`: deleted `stitchEntityExpansion`,
      `stitchCompound`, `overlayCitations` + the `canvasElements` overlay merge
      memo and the `overlay` state; one `GET /graph/neighborhood` call per
      focus; every node click routes through one `focusOn(FocusNode)`; new
      `source` focus type; DetailCard keeps its own `/expand` +
      `/compounds/search?expand=true` fetches, fired in parallel; explicit
      canvas error state (401 -> error + Retry, never a blank canvas);
      stale-response guard via a request-sequence ref.
- [x] 2.3 `graph.css`: `.graph-legend*` (edge-type legend / toggle filter),
      `.graph-canvas-error` + `.graph-retry-btn`.

## Verification (Phase 1)

- `bun tsc --noEmit` — no new errors (pre-existing: `scripts/ingest-marine-drugs.ts`).
- `bun test src/services/researchBrain/__tests__/citationGraph.test.ts` — 25/25 pass.
- `bun test src/services/researchBrain/__tests__/graphService.neighborhood.test.ts` — 14/14 pass.
- researchBrain + graph/citation route suites: 399 pass / 30 fail, identical to
  the 30 pre-existing baseline failures (compoundAuthority fuzzy-recovery +
  stale admin-only auth assertions). Zero new failures.

## Verification (Phase 2)

- `bun tsc --noEmit` — no new errors (pre-existing: `scripts/ingest-marine-drugs.ts`).
- `bun tsc --noEmit -p client/tsconfig.json` — zero errors in `GraphCanvas.tsx` /
  `GraphExplorerPage.tsx` (the client baseline has ~15 pre-existing errors in
  other files: `ProvenanceBadge`, `SuggestedSteps`, `useSessions`,
  `useX402Payment`, `ResearchBrainPage`, `PrivyProvider`, `CDPProvider`).
- `bun run build:client` — succeeds (index.js 7300kb, index.css 132kb).
- Manual: `/graph` -> search+select -> cross-edges (`co_occurs_with`,
  `related_source`, `reports`) render BETWEEN neighbors, not only as spokes.
</content>
