# Delta for graph-explorer-ui

## MODIFIED Requirements

### Requirement: d3-force + SVG Ego-Graph Canvas

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
neighbor (fetching its own neighborhood). A node whose neighborhood
resolves to no neighbors MUST render an explicit empty state (e.g. "no
linked neighbors yet") rather than a blank or broken canvas. The
simulation MUST be stopped on unmount.
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

## ADDED Requirements

### Requirement: Typed And Weighted Client Edge Model

The client `GraphEdge` model MUST be
`{ source, target, type, weight, label? }`. `type` MUST mirror the edge
types returned by `GET /graph/neighborhood`, and `weight` MUST be the
numeric weight from the payload. `GraphCanvas` MUST style edges by `type`
(so a co-occurrence edge is visually distinguishable from an
entity↔compound edge) and MUST be able to filter/threshold edges by
`weight` to keep dense neighborhoods readable. The optional `label` field
MUST be preserved so existing rendering does not break.

#### Scenario: Edges carry type and weight

- GIVEN a neighborhood payload with typed, weighted edges
- WHEN the client maps it into `GraphEdge[]`
- THEN each edge exposes `type` and numeric `weight`
- AND `label` remains optional

#### Scenario: Canvas styles edges by type

- GIVEN a rendered graph containing at least two distinct edge types
- WHEN the canvas draws them
- THEN the two types are visually distinguishable

#### Scenario: Weight threshold reduces a hairball

- GIVEN a dense neighborhood with many low-weight edges
- WHEN a weight threshold is applied
- THEN edges below the threshold are hidden
- AND the remaining high-weight edges stay rendered

### Requirement: Neighborhood Fetch Uses The Shared Auth Header Pattern

The neighborhood fetch MUST reuse the existing `getAuthHeaders()` pattern
(Bearer `bioagents_auth_token` plus `credentials: 'include'`), like every
other graph fetch on the page. A 401 response MUST surface as an error
state, not a blank canvas.

#### Scenario: Neighborhood request carries auth

- GIVEN the page issues a neighborhood request
- WHEN the request is sent
- THEN it carries the `getAuthHeaders()` Bearer token and
  `credentials: 'include'`

#### Scenario: Unauthorized response surfaces an error state

- GIVEN the endpoint responds 401
- WHEN the page handles it
- THEN an error state is shown rather than a blank or broken canvas

### Requirement: v2 Change Remains Additive To The Rest Of The Client

The v2 change MUST remain additive outside the graph surface: no existing
page, route, shell, or Sidebar entry changes behavior, no client
dependency is added or removed, and no data migration is required. Only
`GraphExplorerPage`, `GraphCanvas`, the graph types/styles, and the
neighborhood fetch change.

#### Scenario: Existing pages and routes are unchanged

- GIVEN the client before and after this change
- WHEN existing pages and routes are exercised
- THEN their behavior is identical
- AND the only mutations are on the `/graph` page, its canvas, its edge
  model, and its styles
