# Design: Knowledge Graph Explorer Page

> **LIBRARY DECISION UPDATED (2026-07-11): d3-force + SVG, NOT cytoscape.**
> This supersedes every `cytoscape` reference below. Rationale: the graph is a
> user-facing page and the build is `splitting:false`, so a heavy graph lib
> (cytoscape ~120KB gz, or Three.js-based 3d-force-graph ~150KB+ gz) would load
> in the single bundle on EVERY page for ALL users. D3 is modular — import only
> `d3-force` + `d3-selection` + `d3-drag` + `d3-zoom` (~15-25KB gz, tree-shaken),
> which ships fine in the single bundle. We render **navigable ego-graph
> neighborhoods** as SVG we control, with `d3-force` doing the layout physics.
> The `GraphCanvas` module owns the d3-force simulation + SVG (`<svg>` nodes as
> `<circle>`, edges as `<line>`), node-click re-centers on the clicked node.
> Node styling by `type` (entity/compound/source). No dynamic-import / CDN /
> bundle-splitting gymnastics needed — d3-force is small enough to import
> normally. Deps to add (root `package.json`): `d3-force`, `d3-selection`,
> `d3-drag`, `d3-zoom` (or the umbrella `d3` if tree-shaking is confirmed).
> Everything else in this design (backend gating edits, master-detail layout,
> fetch/auth pattern, routing/nav, state model, empty states) stands unchanged.

## Technical Approach

Two decoupled, additive changes. Backend: relax gating on 4 read-only GETs (`role:"admin"` dropped, keep `required:true`). Frontend: a new `/graph` page mirroring the master-detail pattern of `ResearchBrainPage`/`AdminPage`, fetching via the `getAuthHeaders()` pattern from `useAdminReview.ts`, rendering client-stitched star neighborhoods on a cytoscape canvas mounted on a ref. No new backend endpoint; no server-side graph lib.

## Backend edits (surgical, read-only invariant)

Change the `beforeHandle` on exactly 4 sites. cytoscape is NOT needed server-side — the API already returns the aggregate lists the client stitches.

| File | Route | Before | After |
|------|-------|--------|-------|
| `research-brain-graph.ts:77` | `/graph/compounds/search` | `authResolver({ required: true, role: "admin" })` | `authResolver({ required: true })` |
| `research-brain-graph.ts:128` | `/graph/entities/:kind/search` | same | `authResolver({ required: true })` |
| `research-brain-graph.ts:166` | `/graph/entities/:kind/:value/expand` | same | `authResolver({ required: true })` |
| `research-brain-citations.ts:76` | `/citations/:sourceId` | same | `authResolver({ required: true })` |

Add a one-line invariant comment above each: `// READ-ONLY: any authenticated user. Do NOT add mutations to this handler.` Update the `auth:` lines and drop the `403 Admin role required` note in each file's header docblock.

## Decision: cytoscape under `splitting:false` (REALITY CHECK)

**Verified behavior**: `client/build.ts` sets `splitting:false` ("to avoid chunk files the server doesn't handle"). With splitting disabled, Bun.build does NOT emit a separate chunk for a dynamic `import('cytoscape')` — it **inlines** the module into the single entry bundle. The `import()` still returns a Promise, but the code ships in the one bundle and is downloaded up front. **The proposal's success criterion "cytoscape absent from the general bundle" is NOT achievable as written under the current config.**

| Option | Bundle cost | Tradeoff | Decision |
|--------|-------------|----------|----------|
| Dynamic `import('cytoscape')` from one module | +cytoscape in single bundle (~120KB gz); download up front, **evaluation deferred** to `/graph` | Honest, zero infra change | **CHOSEN v1** |
| Runtime CDN `<script>` injection, read `window.cytoscape` | 0 bundle bytes | External dep, CSP/offline risk, version-by-URL | Documented fallback if size is measured-problematic |
| Enable `splitting:true` | true code-split | Server must serve chunk files — out of scope | Rejected |

**Recommendation**: keep `import('cytoscape')` isolated to the single `GraphCanvas` module and add cytoscape to `package.json`. Accept it lands in the bundle; deferred *evaluation* is the real retained benefit. Reframe the success criterion to "cytoscape is lazily evaluated on `/graph`, isolated to one module." The isolation keeps a later CDN/splitting swap a one-file change.

## Frontend structure

| Component | Role |
|-----------|------|
| `GraphExplorerPage.tsx` | Master-detail shell; owns state; left panel + right `GraphCanvas` |
| `GraphSearchPanel` (in-file) | Kind selector (`bioactivity`/`application_area`/`assay_model`/`compound`) + query input + results list |
| `GraphDetailCard` (in-file) | Focus-node detail from expand payload (compound/fact counts, source titles, DOI links) |
| `GraphCanvas` (own module) | `import('cytoscape')`, mounts on a `ref`, renders `{nodes,edges}`, emits node-click |

**Data hooks** (mirror `getAuthHeaders()` + `credentials:"include"` from `useAdminReview.ts`): `useEntitySearch(kind,q)`, `useCompoundSearch(q)`, `useEntityExpand(kind,value)`, `useCitations(sourceId)` — thin `fetch` wrappers with `{data,isLoading,error}`.

**State model**: `selectedKind`, `query`, `searchResults`, `focusNode:{type,id,value}|null`, `elements` (cytoscape), `overlayEdges`, `loading/error`.

**Star-neighborhood builder** (from `expand` payload): center = `entity:{kind}:{value}`. For each `expansion.compounds[]` → node `compound:{id}` + edge `entity→compound`. For each `expansion.sources[]` → node `source:{id}`. For each `expansion.facts[]` (carries `source_id`, `compound_canonical_id`, `result_summary`) → edge `compound→source` labelled by `result_summary`. Clicking a node re-centers (re-fetch expand); clicking a source node overlays `/citations/:sourceId` `source↔source` edges. Empty arrays → "no linked neighbors yet" empty state.

**Node styling by type**: `entity` (accent/blue), `compound` (green), `source` (purple/DOI-badged) — cytoscape stylesheet keyed on a `data(type)` selector.

## Routing + nav

- `client/src/pages/index.ts`: add `export { GraphExplorerPage } from './GraphExplorerPage';`
- `client/src/index.jsx`: add `<LayoutRoute path="/graph" component={GraphExplorerPage} />` in `LegacyAppShell` (after line 79) AND `<LayoutRoute path="/graph" component={GraphExplorerPage} coralGptMode privyLogout={privyLogout} />` in `CoralAppShell` (after line 131). Add `import './styles/graph.css';` alongside the other style imports (lines 14-19).
- `client/src/components/Sidebar.jsx`: add an **ungated** `<Button icon="share2" onClick={() => route('/graph')} className={...navActive('/graph')}>Graph</Button>` near the Research Brain entry (line 204) — NOT wrapped in `isAdmin`.
- `client/src/styles/graph.css`: new; mirror `research.css`/`corpus.css` layout language.

## Dependency

`package.json` (root — client resolves `../node_modules`): add `"cytoscape": "^3.30.0"` to `dependencies`.

## Risks / Rollback

| Risk | Mitigation |
|------|------------|
| Gating relaxation over-exposes data | Only 4 read-only aggregate GETs; revert = re-add `role:"admin"`; instant, no migration |
| cytoscape inflates single bundle (~120KB gz) | Isolated to `GraphCanvas`; CDN fallback documented; deferred eval |
| Sparse graph feels empty (~1.5 facts/node) | Search/detail leads; explicit empty state |
| `splitting:false` defeats "out of bundle" goal | Documented above; success criterion reframed to lazy-eval |

**Rollback**: revert frontend commits (fully additive) + restore `role:"admin"` on 4 endpoints. No schema/data change.

## Out of scope

Typed `/graph/neighborhood {nodes,edges}` endpoint, weighted compound↔compound co-occurrence edges, dense-corpus rendering, any change to non-graph admin endpoints/gating.

## Open Questions

- [ ] Confirm product accepts cytoscape shipping in the single bundle (vs. CDN) for v1.
