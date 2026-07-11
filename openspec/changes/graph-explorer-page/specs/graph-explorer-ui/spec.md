# Spec: graph-explorer-ui

## Purpose

Ship a user-facing Knowledge Graph explorer page at `/graph`, visible to
ALL whitelisted authenticated users (NOT admin-gated in the UI). The
Knowledge Graph (entities, compounds, sources, citations) is already
served by read-only API endpoints but has no UI; this capability adds a
first-class master-detail + node-link page so whitelisted users can
search entities/compounds and visually explore the neighborhood
(compounds, facts, sources, provenance/DOI) around a result.

The page is purely additive to the existing client: no existing page,
route, or Sidebar behavior changes. The graph rendering library
(cytoscape.js) is dynamically imported so it loads ONLY on `/graph` and
stays out of the general single bundle. v1 renders **star
neighborhoods** stitched client-side from the existing
`/graph/entities/:kind/:value/expand` payload (with an optional
`/citations/:sourceId` overlay for source nodes). No new backend
endpoint is introduced by this capability.

## ADDED Requirements

### Requirement: Graph Explorer Page Route And Registration

The system MUST add a new page `GraphExplorerPage` mounted at route
`/graph`. The page MUST be registered in BOTH application shells
(`LegacyAppShell` and `CoralAppShell` in `client/src/index.jsx`),
exported from `client/src/pages/index.ts`, and reachable via a new
Sidebar entry. The page and its route MUST be additive: no existing
page, route, or shell wiring is modified in behavior.

#### Scenario: Route is registered in both shells

- GIVEN the client is built and served
- WHEN a whitelisted authenticated user navigates to `/graph` under
  either the legacy shell or the Coral shell
- THEN the `GraphExplorerPage` renders in that shell
- AND no existing route under either shell changes behavior

#### Scenario: Page is exported and importable

- GIVEN `client/src/pages/index.ts`
- WHEN the page barrel is inspected
- THEN it exports `GraphExplorerPage`
- AND `client/src/index.jsx` references that export for the `/graph`
  route in both shells

### Requirement: Sidebar Entry Visible To All Whitelisted Users

The system MUST add a Sidebar navigation entry that links to `/graph`.
Unlike the admin-only Sidebar buttons (gated by `isAdmin`), this entry
MUST be visible to ALL whitelisted authenticated users regardless of
role. It MUST NOT be wrapped in the `isAdmin` gate.

#### Scenario: Non-admin whitelisted user sees the Graph entry

- GIVEN a whitelisted authenticated user whose role is NOT `admin`
- WHEN the Sidebar renders
- THEN the Graph explorer entry is visible and links to `/graph`
- AND the existing admin-only entries remain hidden for this user

#### Scenario: Admin user also sees the Graph entry

- GIVEN a whitelisted authenticated user with role `admin`
- WHEN the Sidebar renders
- THEN the Graph explorer entry is visible alongside the admin-only
  entries

### Requirement: Master-Detail Search And Detail Panel

The page MUST present a master-detail layout. The left panel MUST
provide a kind selector (`bioactivity`, `application_area`,
`assay_model`) plus a search input that calls
`GET /api/research-brain/graph/entities/:kind/search` for entities and
`GET /api/research-brain/graph/compounds/search` for compounds, and MUST
render the returned nodes with their counts (`compound_count`,
`fact_count`, `source_count` for entities). Selecting a result MUST load
its neighborhood via
`GET /api/research-brain/graph/entities/:kind/:value/expand` and render a
detail card showing the linked compounds, facts, and sources with
provenance (quote/page) and DOI where present. All fetches MUST reuse
the existing `getAuthHeaders()` pattern (Bearer `bioagents_auth_token`
plus `credentials: 'include'`).

#### Scenario: Searching a kind returns entity nodes with counts

- GIVEN a whitelisted user on `/graph` with kind `bioactivity` selected
- WHEN the user searches for `anti`
- THEN the left panel lists the matching entity nodes
- AND each node shows its `compound_count`, `fact_count`, and
  `source_count`

#### Scenario: Selecting a result shows its expand neighborhood

- GIVEN a search result node for `bioactivity = antifungal`
- WHEN the user selects it
- THEN the detail card shows the expand neighborhood: linked compounds,
  facts, and sources
- AND facts display their provenance (quote/page) and sources display
  their DOI where present

#### Scenario: Fetches use the shared auth header pattern

- GIVEN the page issues a search or expand request
- WHEN the request is sent
- THEN it carries the `getAuthHeaders()` Bearer token from
  `bioagents_auth_token` and `credentials: 'include'`

### Requirement: Node-Link Star Neighborhood Canvas

The right panel MUST render a node-link canvas using cytoscape.js. On
selecting a node, the canvas MUST render that node's **star
neighborhood** stitched client-side from the `expand` payload: the
selected entity at the center with edges to its neighboring compounds,
facts, and sources. Clicking a neighbor node MUST re-center the canvas
on that neighbor (fetching its own neighborhood as needed). For a source
node, the page MAY overlay source↔source citation edges fetched from
`GET /api/research-brain/citations/:sourceId`. A node whose neighborhood
resolves to no neighbors MUST render an explicit empty state (e.g. "no
linked neighbors yet") rather than a blank or broken canvas.

#### Scenario: Selecting a node renders its star neighborhood

- GIVEN a selected `bioactivity` node with 2 compounds, 3 facts, and 2
  sources in its expand payload
- WHEN the canvas renders
- THEN the selected node is centered
- AND it has edges to the compound, fact, and source neighbor nodes
  stitched from that expand payload

#### Scenario: Clicking a neighbor re-centers the canvas

- GIVEN a rendered star neighborhood with a compound neighbor node
- WHEN the user clicks that compound node
- THEN the canvas re-centers on the compound
- AND the compound's own neighborhood is rendered

#### Scenario: Source overlay adds citation edges

- GIVEN a selected source node with a `sourceId`
- WHEN the user requests the citation overlay
- THEN the page fetches `/api/research-brain/citations/:sourceId`
- AND renders source↔source citation edges on the canvas

#### Scenario: Node with no neighbors shows the empty state

- GIVEN a node whose expand payload returns empty compounds, facts, and
  sources
- WHEN the canvas would render its neighborhood
- THEN an explicit empty state ("no linked neighbors yet") is shown
- AND the canvas does not render a broken or blank graph

### Requirement: cytoscape Loaded Only On /graph (Dynamic Import)

The cytoscape.js library MUST be loaded via a dynamic `import()` so it
is fetched ONLY when the `/graph` page mounts, and MUST NOT be part of
the general single client bundle. No other page may pull cytoscape into
its load path.

#### Scenario: cytoscape is absent from the general bundle

- GIVEN the client is built with `bun run build:client`
- WHEN the general single bundle is inspected
- THEN cytoscape.js is NOT included in it
- AND it is fetched only when `/graph` mounts via dynamic `import()`

#### Scenario: Visiting a non-graph page does not load cytoscape

- GIVEN a whitelisted user who never navigates to `/graph`
- WHEN they use other pages
- THEN cytoscape.js is never fetched or evaluated

### Requirement: Additive-Only Client Change

The change MUST be purely additive to the client. It MUST NOT alter the
behavior of any existing page, route, shell, or Sidebar entry. The only
mutations are: the new `GraphExplorerPage`, its export from
`pages/index.ts`, its route registration in both shells, the new
Sidebar entry, and the new cytoscape client dependency.

#### Scenario: Existing pages and routes are unchanged

- GIVEN the client before and after this change
- WHEN existing pages and routes are exercised
- THEN their behavior is identical to before the change
- AND the only additions are the `/graph` page, its export/route/Sidebar
  wiring, and the cytoscape dependency
