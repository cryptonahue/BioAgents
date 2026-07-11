# Proposal: Knowledge Graph Explorer Page

## Intent

The Knowledge Graph (entities, compounds, sources, citations) is fully served by read-only API endpoints, but has NO user-facing UI — it is reachable only by admins via raw HTTP. The KG is the product's core research value. Whitelisted CoralGPT users need a first-class page to search entities/compounds and visually explore the neighborhood around a result (compounds, facts, sources, provenance/DOI).

## Scope

### In Scope

- **Gating relaxation (read-only GETs only, surgical):** change `authResolver({ required: true, role: "admin" })` → `authResolver({ required: true })` on exactly these 4 endpoints:
  - `src/routes/research-brain-graph.ts`: `GET /graph/entities/:kind/search`, `GET /graph/entities/:kind/:value/expand`, `GET /graph/compounds/search`
  - `src/routes/research-brain-citations.ts`: `GET /citations/:sourceId`
  - Invariant: these endpoints stay READ-ONLY (no mutations) for future maintainers.
- **New page** `client/src/pages/GraphExplorerPage.tsx` at route `/graph`; registered in BOTH `LegacyAppShell` and `CoralAppShell` (`client/src/index.jsx`), exported from `client/src/pages/index.ts`, plus a new **Sidebar entry visible to ALL users** (not admin-gated).
- **Layout:** master-detail + canvas. Left = kind selector + search (`/graph/entities/:kind/search`, `/graph/compounds/search`) + detail card from the expand payload (provenance/DOI). Right = node-link canvas.
- **Graph lib: cytoscape.js**, dynamically `import()`ed so it loads ONLY on `/graph` (kept out of the general single bundle).
- **v1 node-link = star neighborhoods** stitched client-side from `/graph/entities/:kind/:value/expand` (entity → compounds/facts/sources); node click re-centers; source node optionally overlays `/citations/:sourceId` edges. **No new backend endpoint.**
- Fetch/auth reuses `getAuthHeaders()` (Bearer `bioagents_auth_token` + `credentials: 'include'`).

### Out of Scope

- Typed `/graph/neighborhood` `{nodes,edges}` endpoint + weighted compound↔compound co-occurrence edges — deferred to v2.
- Any change to non-graph admin endpoints or their gating (review UI, cost totals, table-merges, mutations stay admin-only).
- Dense-corpus graph rendering — corpus is sparse (~1.5 facts/node); search/detail leads, canvas is secondary. Ships with a "no linked neighbors yet" empty state.

## Capabilities

### New Capabilities
- `graph-explorer-ui`: user-facing `/graph` page — search/detail panel + cytoscape node-link star neighborhoods, visible to all whitelisted users.

### Modified Capabilities
- `bioprospecting-entity-graph`: relax access on entity search/expand read endpoints from admin-only to any authenticated user.
- `bioprospecting-knowledge-graph`: relax access on compound-search and citations read endpoints from admin-only to any authenticated user.

## Approach

Two surgical, decoupled changes. Backend: flip the `role: "admin"` flag on 4 enumerated read GETs only. Frontend: additive new page + Sidebar entry, cytoscape lazy-loaded, neighborhoods stitched client-side from existing `expand`/`citations` payloads. No existing page behavior changes.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/routes/research-brain-graph.ts` | Modified | Drop `role: "admin"` on 3 read GETs |
| `src/routes/research-brain-citations.ts` | Modified | Drop `role: "admin"` on `/citations/:sourceId` |
| `client/src/pages/GraphExplorerPage.tsx` | New | Explorer page |
| `client/src/pages/index.ts` | Modified | Export new page |
| `client/src/index.jsx` | Modified | Route in both shells |
| `client/src/components/Sidebar.jsx` | Modified | Nav entry for all users |
| `client/package.json` | Modified | Add cytoscape dep |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Gating relaxation over-exposes data | Med | SECURITY REVIEW required; only 4 read-only aggregate GETs; enumerate exactly; no mutations |
| Scope creep to other admin endpoints | Med | Explicit out-of-scope; do not touch any non-graph endpoint |
| cytoscape inflates general bundle | Med | Dynamic `import()`, loads only on `/graph` |
| Sparse graph feels empty | High | Search/detail leads; "no linked neighbors yet" empty state |

## Rollback Plan

Revert the frontend commits (page/route/sidebar/dep — fully additive) and restore `role: "admin"` on the 4 endpoints. No data migration, no schema change; instant revert.

## Dependencies

- cytoscape.js (new client dependency).
- Existing KG endpoints and `getAuthHeaders()` pattern (both present).

## Success Criteria

- [ ] Any whitelisted (non-admin) user reaches `/graph` and searches entities and compounds successfully.
- [ ] Selecting a result renders a star neighborhood; clicking a node re-centers; source overlay shows citation edges.
- [ ] cytoscape is absent from the general bundle and loads only on `/graph`.
- [ ] Only the 4 enumerated read GETs change gating; all other admin endpoints stay admin-only.
- [ ] Empty state shows for nodes with no linked neighbors.
