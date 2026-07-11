# Tasks: Knowledge Graph Explorer Page

> **LIBRARY DECISION (authoritative, from design.md banner):** the graph is
> rendered with **d3-force + SVG**, NOT cytoscape. Every `cytoscape` mention in
> `proposal.md` and the `specs/*/spec.md` deltas is SUPERSEDED by this decision.
> Where a spec scenario says "cytoscape", read it as "the d3-force + SVG graph
> canvas". The gating, layout, fetch/auth, routing, state-model, and empty-state
> requirements in those specs stand unchanged.

Legend: **[CODE]** = implemented by executor · **[MANUAL]** = human action required.
`P` = can run in parallel with sibling `P` tasks · `S` = sequential (has a hard dependency).

---

## 1. Backend gating relaxation (SECURITY-SENSITIVE — surgical, exactly 4 sites)

> Satisfies: `bioprospecting-entity-graph` / Admin Authentication Gate,
> `bioprospecting-knowledge-graph` / Admin Authentication Gate.
> Invariant: these 4 handlers stay READ-ONLY (no mutations) for future maintainers.

- [ ] **1.1 [CODE] S** `src/routes/research-brain-graph.ts:77` (`GET /graph/compounds/search`):
      change `authResolver({ required: true, role: "admin" })` → `authResolver({ required: true })`.
      Add one line above the `beforeHandle`: `// READ-ONLY: any authenticated user. Do NOT add mutations to this handler.`
- [ ] **1.2 [CODE] S** `src/routes/research-brain-graph.ts:128` (`GET /graph/entities/:kind/search`): same flip + same invariant comment.
- [ ] **1.3 [CODE] S** `src/routes/research-brain-graph.ts:166` (`GET /graph/entities/:kind/:value/expand`): same flip + same invariant comment.
- [ ] **1.4 [CODE] S** `src/routes/research-brain-citations.ts:76` (`GET /citations/:sourceId`): same flip + same invariant comment.
- [ ] **1.5 [CODE] S** Update the header docblock `auth:` lines in BOTH files: drop any "admin-only" / "403 Admin role required" note for these 4 read GETs; state "authenticated (any role); read-only".
- [ ] **1.6 [CODE] S** SECURITY SELF-CHECK: `rg 'role: "admin"'` in both files confirms every OTHER admin endpoint (cost-totals, table-merges, review mutations) is UNCHANGED. Exactly 4 gate lines changed, no more.

## 2. Dependency (root `package.json`)

> The client resolves `../node_modules`; add d3 modules to the ROOT manifest.

- [x] **2.1 [CODE] S** Add to `dependencies`: `d3-force`, `d3-selection`, `d3-drag`, `d3-zoom`
      (expected `^3.x` each — confirm exact resolved versions via `bun add d3-force d3-selection d3-drag d3-zoom`).
      Also add the matching `@types/d3-force`, `@types/d3-selection`, `@types/d3-drag`, `@types/d3-zoom`
      to `devDependencies` for `tsc` (or use `bun add -d`).
      Resolved: d3-force@3.0.0, d3-selection@3.0.0, d3-drag@3.0.0, d3-zoom@3.0.0 (all `^3.0.0`).
- [x] **2.2 [MANUAL]** Run `bun install` and confirm lockfile updates; verify no `cytoscape` entry was introduced.
      `bun add` updated `bun.lock`; `rg cytoscape` on lockfile + package.json returns nothing.

## 3. GraphCanvas module (own file)

> Satisfies: `graph-explorer-ui` / Node-Link Star Neighborhood Canvas + empty-state scenario.
> `client/src/components/graph/GraphCanvas.tsx`

- [x] **3.1 [CODE] S** (after §2) Create `GraphCanvas.tsx`: props `{ nodes, edges, onNodeClick }`.
      Run a `d3-force` simulation (forceManyBody + forceLink + forceCenter + forceCollide) over `{nodes, edges}`.
- [x] **3.2 [CODE] S** Render as SVG the executor controls: `<line>` per edge, `<circle>` per node, `<text>` label per node; tick handler updates positions.
- [x] **3.3 [CODE] S** Interactions: `d3-drag` on nodes (pin/unpin during drag), `d3-zoom` for pan+zoom on the `<svg>`/root `<g>`.
- [x] **3.4 [CODE] S** Node styling keyed on `node.type`: `entity` (accent/blue), `compound` (green), `source` (purple, DOI-badged).
- [x] **3.5 [CODE] S** `onNodeClick(node)` callback so the page can re-center on the clicked node.
- [x] **3.6 [CODE] S** Empty state: when `nodes.length <= 1` (center only, no neighbors) render "no linked neighbors yet" instead of a blank/broken canvas.
- [x] **3.7 [CODE] S** Cleanup: stop the simulation on unmount to avoid leaks (Preact effect teardown).

## 4. GraphExplorerPage (master-detail)

> Satisfies: `graph-explorer-ui` / Master-Detail Search And Detail Panel.
> `client/src/pages/GraphExplorerPage.tsx`

- [x] **4.1 [CODE] S** (after §3) State model: `selectedKind`, `query`, `searchResults`, `focusNode:{type,id,value}|null`, `elements:{nodes,edges}`, `overlayEdges`, `loading`, `error`.
- [x] **4.2 [CODE] S** Fetch helpers reuse the `getAuthHeaders()` pattern from `useAdminReview.ts` (Bearer `bioagents_auth_token` + `credentials:'include'`): entity search, compound search, entity expand, citations.
- [x] **4.3 [CODE] S** Left panel — kind selector (`bioactivity` / `application_area` / `assay_model` / `compound`) + query input + results list; entity results show `compound_count` / `fact_count` / `source_count`.
- [x] **4.4 [CODE] S** Detail card from the `expand` payload: linked compounds, facts (with provenance quote/page), sources (with DOI where present).
- [x] **4.5 [CODE] S** Star-neighborhood stitcher → `{nodes, edges}`: center = `entity:{kind}:{value}`; each `expansion.compounds[]` → compound node + `entity→compound` edge; each `expansion.sources[]` → source node; each `expansion.facts[]` → `compound→source` edge labelled by `result_summary`.
- [x] **4.6 [CODE] S** Right panel mounts `GraphCanvas` with the stitched `{nodes, edges}`; node-click re-centers (re-fetch expand for the clicked node).
- [x] **4.7 [CODE] S** Source-node click optionally overlays `/citations/:sourceId` `source↔source` edges into `overlayEdges` merged onto the canvas.
- [x] **4.8 [CODE] S** Loading + error UI for search/expand/citations fetches.

## 5. Routing + navigation (additive only)

> Satisfies: `graph-explorer-ui` / Route Registration, Sidebar Entry, Additive-Only.

- [x] **5.1 [CODE] P** `client/src/pages/index.ts`: add `export { GraphExplorerPage } from './GraphExplorerPage';`.
- [x] **5.2 [CODE] P** `client/src/styles/graph.css`: new file; mirror `research.css`/`corpus.css` layout language (master-detail + canvas panel).
- [x] **5.3 [CODE] S** (after 5.1, 5.2) `client/src/index.jsx`:
      - add `import './styles/graph.css';` alongside the other style imports;
      - add `<LayoutRoute path="/graph" component={GraphExplorerPage} />` in `LegacyAppShell`;
      - add `<LayoutRoute path="/graph" component={GraphExplorerPage} coralGptMode privyLogout={privyLogout} />` in `CoralAppShell`.
- [x] **5.4 [CODE] S** `client/src/components/Sidebar.jsx`: add an **UNGATED** Graph entry (`route('/graph')`, near the Research Brain entry) visible to ALL whitelisted users — MUST NOT be wrapped in `isAdmin`.

## 6. Verification

- [x] **6.1 [MANUAL]** `bun tsc --noEmit` — no type errors (d3 typings resolve).
      No NEW errors; the only 5 remaining are pre-existing in `scripts/ingest-marine-drugs.ts`.
- [x] **6.2 [MANUAL]** `bun run build:client` succeeds; d3 modules bundle without chunking errors (`splitting:false` is fine — d3 is small enough to ship in the single bundle).
      Build OK: `index.js` 7294kb (unminified/dev-map path), single bundle, no chunk errors.
- [ ] **6.3 [MANUAL]** Smoke: a NON-admin whitelisted user opens `/graph`, searches an entity/compound, selects a node, sees the ego graph render, clicks a neighbor → canvas re-centers.
- [ ] **6.4 [MANUAL]** Empty-state smoke: select a node with no neighbors → "no linked neighbors yet" shows (no blank/broken canvas).
- [ ] **6.5 [MANUAL]** SECURITY smoke (proves surgical relaxation): as a non-admin, hit a non-graph admin endpoint (e.g. cost-totals or table-merges) → still HTTP 403. Unauthenticated hit on the 4 relaxed GETs → HTTP 401.

---

## Task Dependency Summary

| Group | Depends on | Parallelizable within group |
|-------|-----------|------------------------------|
| §1 Backend gating | none | 1.1–1.4 independent edits; 1.5–1.6 after |
| §2 Dependency | none | — |
| §3 GraphCanvas | §2 | sequential build-up |
| §4 GraphExplorerPage | §3 | sequential build-up |
| §5 Routing/nav | 5.1 + 5.2 parallel, then 5.3/5.4 need §4 page to exist | 5.1 ∥ 5.2 |
| §6 Verification | §1–§5 all done | manual checks |

**Parallel-safe:** §1 (backend) and §2 (deps) can start together; both are independent of the frontend build chain (§3→§4→§5). 5.1 and 5.2 are parallel. Everything else is sequential.

**Bottleneck:** §3→§4→§5.3/5.4 is the critical path (GraphCanvas must exist before the page; the page export/route/sidebar wiring needs the page). Backend §1 is off the critical path but is the security-sensitive gate that verification §6.5 depends on.

---

## Review Workload Forecast

**Touches BOTH backend (security-sensitive gating) AND frontend (new page).**

| Area | Files | Est. changed lines |
|------|-------|--------------------|
| Backend gating (§1) | `research-brain-graph.ts`, `research-brain-citations.ts` | ~12 (4 gate flips + 4 invariant comments + docblock notes) |
| Dependency (§2) | root `package.json` (+ lockfile) | ~8 |
| GraphCanvas (§3) | `client/src/components/graph/GraphCanvas.tsx` (new) | ~180–240 |
| GraphExplorerPage (§4) | `client/src/pages/GraphExplorerPage.tsx` (new) | ~220–300 |
| Routing/nav + css (§5) | `pages/index.ts`, `index.jsx`, `Sidebar.jsx`, `styles/graph.css` (new) | ~90–130 |
| **Total** | 4 modified + 3 new | **~510–690 lines** |

- **Single-PR fit (≤400 lines):** NO — estimate exceeds the 400-line budget; **400-line budget risk: High**.
- **Chained PRs recommended:** YES. Natural split:
  - **PR A (backend, security):** §1 gating + §6.5 security smoke. Small (~12 lines), reviewed in isolation so the gate relaxation gets focused security eyes. Independently shippable (endpoints just become reachable by more users; no client yet).
  - **PR B (frontend):** §2 deps + §3 GraphCanvas + §4 page + §5 routing/nav + §6.1–§6.4. Larger (~500–650 lines), no security surface.
- **Decision needed before apply:** YES — orchestrator must apply the cached `delivery_strategy` (backend/frontend split vs. single PR with `size:exception`).

### Security note (gating)
The backend change relaxes admin-only → any-authenticated on **exactly 4 read-only GET endpoints**. Task 1.6 is a mandatory self-check that no other `role:"admin"` gate is touched. The read-only invariant comment is required on all 4 handlers. Verification 6.5 proves surgical scope by confirming a non-graph admin endpoint still returns 403 for a non-admin. This is the single highest-risk item and is isolated into PR A for focused review.

### Residual decisions (for orchestrator/human)
1. **PR split:** backend/frontend chained PRs (recommended) vs. single PR with `size:exception`. Apply cached `delivery_strategy`.
2. **d3 versions:** confirm exact resolved versions at `bun add` time (expected `d3-*@^3.x`); decide granular `d3-*` modules (chosen) vs. umbrella `d3`.
3. **Spec vs. design library mismatch:** specs/proposal still say "cytoscape"; design banner (authoritative) mandates d3-force+SVG. Tasks follow the design. If specs must read clean, a spec text update is a separate doc-only follow-up (not required for apply).
4. **Open question from design (§Open Questions):** product acceptance that d3 ships in the single bundle — resolved favorably by the small d3 footprint; no CDN/splitting gymnastics needed.
