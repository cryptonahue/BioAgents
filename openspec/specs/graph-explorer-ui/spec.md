# Spec: graph-explorer-ui

## Purpose

Ship a user-facing Knowledge Graph explorer page at `/graph`, visible to
ALL authenticated (whitelisted) users of the app — NOT admin-gated in the
UI. The Knowledge Graph (entities, compounds, sources, citations) is
served by read-only API endpoints that are open to **any authenticated
caller (read-only)**; this capability adds a first-class master-detail +
node-link page so users can search entities/compounds and visually
explore the neighborhood (compounds, facts, sources, provenance/DOI)
around a result.

The page is purely additive to the existing client: no existing page,
route, or Sidebar behavior changes. The graph is rendered with
**d3-force + SVG** (`d3-force`, `d3-selection`, `d3-drag`, `d3-zoom`) —
NOT cytoscape and NOT a WebGL/3D library.

**v2 (current).** The page consumes the typed backend endpoint
`GET /api/research-brain/graph/neighborhood` (owned by the
`graph-neighborhood-edges` capability) and renders its `{ nodes, edges }`
payload directly. The rendered graph is the **induced subgraph**: edges
between neighbors (compound↔compound co-occurrence, source↔source
relatedness, compound↔source `reports`) are drawn in addition to the
focus→neighbor spokes, so the canvas is a network rather than a star.
Client-side stitching is REMOVED.

(History — v1: the page stitched an ego graph client-side from one
`/graph/entities/:kind/:value/expand` payload plus an optional
`/citations/:sourceId` overlay, so no neighbor↔neighbor edge could ever
be drawn. The detail panel still calls `expand` and
`/graph/compounds/search?expand=true` for fact quotes, pages, and DOIs,
which the graph payload deliberately does not carry.)

## Requirements

### Requirement: Graph Explorer Page Route And Registration

The system MUST add a new page `GraphExplorerPage` mounted at route
`/graph`. The page MUST be registered in BOTH application shells
(`LegacyAppShell` and `CoralAppShell` in `client/src/index.jsx`),
exported from `client/src/pages/index.ts`, and reachable via a new
Sidebar entry. The page and its route MUST be additive: no existing
page, route, or shell wiring is modified in behavior.

#### Scenario: Route is registered in both shells

- GIVEN the client is built and served
- WHEN an authenticated user navigates to `/graph` under either the
  legacy shell or the Coral shell
- THEN the `GraphExplorerPage` renders in that shell
- AND no existing route under either shell changes behavior

#### Scenario: Page is exported and importable

- GIVEN `client/src/pages/index.ts`
- WHEN the page barrel is inspected
- THEN it exports `GraphExplorerPage`
- AND `client/src/index.jsx` references that export for the `/graph`
  route in both shells

### Requirement: Sidebar Entry Visible To All Users (Not Admin-Gated)

The system MUST add a Sidebar navigation entry that links to `/graph`.
Unlike the admin-only Sidebar buttons (gated by `isAdmin`), this entry
MUST be visible to ALL authenticated (whitelisted) users regardless of
role. It MUST NOT be wrapped in the `isAdmin` gate.

#### Scenario: Non-admin user sees the Graph entry

- GIVEN an authenticated whitelisted user whose role is NOT `admin`
- WHEN the Sidebar renders
- THEN the Graph explorer entry is visible and links to `/graph`
- AND the existing admin-only entries remain hidden for this user

#### Scenario: Admin user also sees the Graph entry

- GIVEN an authenticated user with role `admin`
- WHEN the Sidebar renders
- THEN the Graph explorer entry is visible alongside the admin-only
  entries

### Requirement: Master-Detail Search And Detail Panel

The page MUST present a master-detail layout. The left panel MUST
provide a kind selector (`bioactivity`, `application_area`,
`assay_model`, `compound`) plus a search input that calls
`GET /api/research-brain/graph/entities/:kind/search` for entities and
`GET /api/research-brain/graph/compounds/search` for compounds, and MUST
render the returned nodes with their counts (`compound_count`,
`fact_count`, `source_count` for entities). Selecting a result MUST
render a detail card showing the linked compounds, facts, and sources
with provenance (quote/page) and DOI where present. The detail card MUST
source that data from
`GET /api/research-brain/graph/entities/:kind/:value/expand` (and
`GET /graph/compounds/search?expand=true` for a compound focus), because
the neighborhood payload deliberately does not carry fact quotes, pages,
or DOIs. These detail fetches MUST be issued in PARALLEL with the
canvas's `GET /graph/neighborhood` call — the detail card and the canvas
have separate data sources and neither may block the other. All fetches
MUST reuse the existing `getAuthHeaders()` pattern (Bearer
`bioagents_auth_token` plus `credentials: 'include'`).

#### Scenario: Searching a kind returns entity nodes with counts

- GIVEN a user on `/graph` with kind `bioactivity` selected
- WHEN the user searches for `anti`
- THEN the left panel lists the matching entity nodes
- AND each node shows its `compound_count`, `fact_count`, and
  `source_count`

#### Scenario: Selecting a result shows its expand detail

- GIVEN a search result node for `bioactivity = antifungal`
- WHEN the user selects it
- THEN the detail card shows the expand payload: linked compounds,
  facts, and sources
- AND facts display their provenance (quote/page) and sources display
  their DOI where present
- AND the detail fetch and the `/graph/neighborhood` canvas fetch are
  issued in parallel

#### Scenario: Fetches use the shared auth header pattern

- GIVEN the page issues a search or expand request
- WHEN the request is sent
- THEN it carries the `getAuthHeaders()` Bearer token from
  `bioagents_auth_token` and `credentials: 'include'`

### Requirement: d3-force + SVG Neighborhood Canvas

The right panel MUST render a node-link canvas using **d3-force + SVG**
(a `d3-force` simulation — `forceLink` + `forceManyBody` + `forceCenter`
+ `forceCollide` — driving an SVG scene of `<line>` edges and
`<circle>`/`<text>` nodes, with `d3-drag` for node pinning and `d3-zoom`
for pan/zoom). On selecting a node, the page MUST fetch that node's
neighborhood from `GET /api/research-brain/graph/neighborhood` and render
the returned `{ nodes, edges }` payload directly. The canvas MUST render
the **induced subgraph**, not a star: edges BETWEEN neighbors (e.g.
compound↔compound co-occurrence, source↔source relatedness) MUST be drawn
in addition to the focus→neighbor spokes. The page MUST NOT stitch the
graph client-side from the `expand` payload, and MUST NOT re-derive edges
the endpoint already returns. Node fill MUST be keyed on node type
(entity, compound, source); there MUST be no fact node type — facts are
edges. Clicking a neighbor node MUST re-center the canvas on that
neighbor (fetching its own neighborhood) — every node click MUST route
through a single focus handler, including `source` nodes. A node whose
neighborhood resolves to no neighbors MUST render an explicit empty state
(e.g. "no linked neighbors yet") rather than a blank or broken canvas.
The simulation MUST be stopped on unmount. A stale-response guard (e.g. a
request-sequence ref) MUST prevent an out-of-order response from
overwriting a newer focus.

(Previously: v1 stitched an ego graph client-side from one `expand`
payload plus an optional `/citations/:sourceId` overlay, so no
neighbor↔neighbor edges could ever be drawn.)

#### Scenario: Selecting a node renders its neighborhood from the endpoint

- GIVEN a selected `bioactivity` node
- WHEN the canvas renders
- THEN the page has fetched `GET /graph/neighborhood` for that node
- AND the selected node is centered with edges to its compound and source
  neighbors, drawn from the endpoint's `edges`

#### Scenario: Cross-edges between neighbors are rendered (not a star)

- GIVEN a neighborhood payload containing a compound↔compound edge and a
  source↔source edge between neighbor nodes
- WHEN the canvas renders
- THEN both edges are drawn between the neighbor nodes
- AND the rendered graph is connected rather than a set of spokes

#### Scenario: No fact nodes are rendered

- GIVEN any neighborhood payload
- WHEN the canvas renders
- THEN every node is of type `entity`, `compound`, or `source`
- AND fact relationships appear only as edges

#### Scenario: Clicking a neighbor re-centers the canvas

- GIVEN a rendered neighborhood with a compound neighbor node
- WHEN the user clicks that compound node
- THEN the page fetches the neighborhood for the compound
- AND the canvas re-centers on it

#### Scenario: Node with no neighbors shows the empty state

- GIVEN a node whose neighborhood payload returns no neighbor nodes
- WHEN the canvas would render its neighborhood
- THEN an explicit empty state ("no linked neighbors yet") is shown
- AND the canvas does not render a broken or blank graph

### Requirement: Typed And Weighted Client Edge Model

The client `GraphEdge` model MUST be
`{ source, target, type, weight, label? }`. `type` MUST mirror the edge
types returned by `GET /graph/neighborhood` (`has_compound`,
`has_source`, `reports`, `co_occurs_with`, `related_source`), and
`weight` MUST be the numeric weight from the payload. `GraphCanvas` MUST
style edges by `type` (so a co-occurrence edge is visually
distinguishable from an entity↔compound spoke) and MUST be able to
filter/threshold edges by `weight` to keep dense neighborhoods readable.
The optional `label` field MUST be preserved so existing rendering does
not break.

Because the endpoint's `weight` is comparable only WITHIN an edge type,
stroke width MUST be normalized **per type** — `1 + 3 * (weight /
maxWeightForItsType)`, clamped to `[1, 4]`. Normalizing across types
would compare incomparable units. Cross-edges MUST be visually
foregrounded relative to structural spokes (higher stroke opacity). A
`hiddenEdgeTypes` prop MUST allow the page to filter edge types out of
the simulation, and the canvas MUST expose its stroke/label maps so the
page can render a legend.

#### Scenario: Edges carry type and weight

- GIVEN a neighborhood payload with typed, weighted edges
- WHEN the client maps it into `GraphEdge[]`
- THEN each edge exposes `type` and numeric `weight`
- AND `label` remains optional

#### Scenario: Canvas styles edges by type

- GIVEN a rendered graph containing at least two distinct edge types
- WHEN the canvas draws them
- THEN the two types are visually distinguishable

#### Scenario: Stroke width is normalized within a type

- GIVEN a payload with a `co_occurs_with` edge of weight 4 and a
  `related_source` edge of weight 12
- WHEN stroke widths are computed
- THEN each edge is scaled against the maximum weight of ITS OWN type
- AND no cross-type weight comparison is made

#### Scenario: Weight threshold reduces a hairball

- GIVEN a dense neighborhood with many low-weight edges
- WHEN a weight threshold or an edge-type filter is applied
- THEN the filtered edges are hidden
- AND the remaining high-weight edges stay rendered

### Requirement: Neighborhood Fetch Uses The Shared Auth Header Pattern

The neighborhood fetch MUST reuse the existing `getAuthHeaders()` pattern
(Bearer `bioagents_auth_token` plus `credentials: 'include'`), like every
other graph fetch on the page. A 401 response MUST surface as an explicit
error state with a retry affordance, not a blank canvas.

#### Scenario: Neighborhood request carries auth

- GIVEN the page issues a neighborhood request
- WHEN the request is sent
- THEN it carries the `getAuthHeaders()` Bearer token and
  `credentials: 'include'`

#### Scenario: Unauthorized response surfaces an error state

- GIVEN the endpoint responds 401
- WHEN the page handles it
- THEN an error state with a retry action is shown rather than a blank or
  broken canvas

### Requirement: Lightweight Graph Library (No Heavy Bundle Cost)

The graph library MUST be lightweight enough to ship in the client's
single bundle. The client build uses `splitting: false` (a single bundle
is emitted because the server does not serve chunks), so ANY graph
library is loaded by every page for every user. The chosen library MUST
therefore be the modular, tree-shakeable `d3-*` set (`d3-force`,
`d3-selection`, `d3-drag`, `d3-zoom`), NOT a monolithic renderer such as
cytoscape.js (~120KB) or a WebGL/Three.js-based 3D graph (~150KB+). The
client MUST NOT depend on cytoscape.

#### Scenario: The client has no cytoscape dependency

- GIVEN the root `package.json` and the lockfile
- WHEN they are inspected
- THEN no `cytoscape` entry is present
- AND the graph dependencies are `d3-force`, `d3-selection`, `d3-drag`,
  and `d3-zoom`

#### Scenario: Client build succeeds as a single bundle

- GIVEN the client is built with `bun run build:client`
- WHEN the build runs
- THEN it succeeds as a single bundle with no chunking errors
- AND the d3 modules add only a small tree-shaken footprint

### Requirement: Additive-Only Client Change

The capability MUST remain purely additive to the client. It MUST NOT
alter the behavior of any existing page, route, shell, or Sidebar entry.

The v1 mutations are: the new `GraphExplorerPage`, the new `GraphCanvas`
component, the new `graph.css` stylesheet, the page's export from
`pages/index.ts`, its route registration in both shells, the new
Sidebar entry, and the new `d3-*` client dependencies.

The v2 mutations are confined to the graph surface: `GraphExplorerPage`
(neighborhood fetch, deleted stitchers/overlay, error + retry state),
`GraphCanvas` (edge type/weight model, per-type styling,
`hiddenEdgeTypes`), the graph types, and `graph.css` (edge-type legend,
canvas error state). v2 adds and removes NO client dependency and
requires NO data migration.

#### Scenario: Existing pages and routes are unchanged

- GIVEN the client before and after this change
- WHEN existing pages and routes are exercised
- THEN their behavior is identical to before the change
- AND the only additions are the `/graph` page, its canvas/styles, its
  export/route/Sidebar wiring, and the `d3-*` dependencies

#### Scenario: v2 adds no client dependency

- GIVEN the client `package.json` before and after v2
- WHEN it is inspected
- THEN no dependency is added or removed
- AND the only mutations are on the `/graph` page, its canvas, its edge
  model, and its styles

## Out of Scope

- A global node-link view of the whole corpus. The graph is sparse, so the
  page ships navigable per-node neighborhoods instead.
- 3D / WebGL rendering (`3d-force-graph`, Three.js). Rejected: heavy
  bundle cost under `splitting: false`, and 3D only pays off on dense
  graphs.
- Fact nodes. Facts are edges, not nodes. Promoting facts to first-class
  graph nodes is a separate change.

(Resolved in v2: a typed `GET /graph/neighborhood` backend endpoint was
listed as out of scope for v1. It now EXISTS — see the
`graph-neighborhood-edges` capability — and this page consumes it.)
