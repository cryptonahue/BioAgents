# Spec: graph-neighborhood-edges

## Purpose

Expose a typed, read-only neighborhood endpoint
`GET /api/research-brain/graph/neighborhood` that returns, for a focus
node, its 1-hop neighborhood AND the induced subgraph edges **among
those neighbors** — so `/graph` renders a connected subgraph instead of
a disconnected star. The payload is composed **on the fly** from
existing helpers (`expandEntity`, `getTopCoOccurring`,
`buildCitationGraph`). No new tables, no stored edges, no refresh hook,
no migration, no LLM.

Shipped surface:

- `src/services/researchBrain/graphService.ts` — neighborhood types,
  `composeNeighborhood()`, and three batched read helpers
  (`getFactLinks`, `getSourcesByIds`, `getCompoundsByIds`).
- `src/routes/research-brain-graph.ts` — the `GET /graph/neighborhood`
  route, gated by `authResolver({ required: true })`.
- The citation candidate-selection fix in
  `src/services/researchBrain/citationGraph.ts` is a prerequisite and is
  specified under `bioprospecting-knowledge-graph`.

## Requirements

### Requirement: Neighborhood Endpoint Contract

The system MUST expose `GET /api/research-brain/graph/neighborhood`
returning HTTP 200 with a body of shape
`{ focus, nodes, edges, meta }`. `focus` MUST identify the requested
node. Every node MUST carry an `id`, a `type` of exactly one of
`entity | compound | source`, and a display `label`. Facts MUST NOT be
emitted as nodes — facts remain edges. Every edge MUST carry `source`,
`target`, a `type`, and a numeric `weight`. Node ids MUST be stable so
edges resolve against the returned node set: an edge MUST NOT reference
an id absent from `nodes`.

**Node id format** (identical to the client's existing convention, so no
id migration is required):

- `entity:{kind}:{value}`
- `compound:{uuid}`
- `source:{uuid}`

**Parameters:**

| Param    | Required                  | Values                                                                       |
| -------- | ------------------------- | ---------------------------------------------------------------------------- |
| `type`   | yes                       | `entity` \| `compound` \| `source`                                            |
| `kind`   | iff `type=entity`         | the `ENTITY_KINDS` allowlist (else HTTP 400 `{ error, allowed }`)             |
| `value`  | iff `type=entity`         | URL-decoded normalized key, passed to `expandEntity` verbatim                 |
| `id`     | iff `type=compound\|source` | UUID (else HTTP 400)                                                        |
| `limit`  | no                        | 1-100, default 20 — neighbors per class, clamped defensively                  |
| `fanout` | no                        | 1-5, default 3 — neighbor expansions used to derive induced edges             |

`limit` and `fanout` MUST be clamped defensively like the other graph
read paths. A `compound`/`source` `id` that does not resolve MUST return
HTTP 404. An `entity` focus that matches nothing MUST return HTTP 200
with the focus node and zero edges (empty-is-not-error, matching the
`expandEntity` contract). A DB error MUST return HTTP 500
`{ error: "internal_error" }` with no leaked detail.

#### Scenario: Focus node returns typed nodes and edges

- GIVEN an authenticated caller and a focus node with neighbors
- WHEN `GET /graph/neighborhood` is called for that node
- THEN the response is HTTP 200 with `{ focus, nodes, edges, meta }`
- AND every node's `type` is one of `entity`, `compound`, `source`
- AND every edge carries `source`, `target`, `type`, and numeric `weight`
- AND every edge endpoint id exists in `nodes`

#### Scenario: Facts are edges, never nodes

- GIVEN a focus node whose facts link it to compounds and sources
- WHEN the neighborhood is returned
- THEN no node has type `fact`
- AND the fact-derived relationships appear as edges between the entity,
  compound, and source nodes

#### Scenario: Unmatched entity focus returns an empty neighborhood

- GIVEN an authenticated caller and an `entity` focus value that matches
  nothing
- WHEN `GET /graph/neighborhood` is called
- THEN the response is HTTP 200 (empty-not-error)
- AND `nodes` contains at most the focus node and `edges` is empty

#### Scenario: Unresolvable compound or source id returns 404

- GIVEN an authenticated caller
- WHEN the endpoint is called with `type=compound` (or `type=source`) and
  a well-formed `id` that resolves to no row
- THEN the response is HTTP 404

#### Scenario: Invalid focus kind returns 400

- GIVEN an authenticated caller
- WHEN the endpoint is called with a `kind` outside the allowlist
- THEN the response is HTTP 400 with `{ error, allowed }`

### Requirement: Induced Subgraph Among Neighbors (De-Starring)

The endpoint MUST return not only center→neighbor spokes but also the
edges that exist BETWEEN the neighbors themselves (the induced
subgraph):

- **`reports`** (compound↔source) MUST be derived from a single batched
  `getFactLinks({ compoundIds, sourceIds })` call over the neighbor sets.
- **`co_occurs_with`** (compound↔compound) MUST be derived from
  `getTopCoOccurring` over the neighbor compounds.
- **`related_source`** (source↔source) MUST be derived from
  `buildCitationGraph` over the neighbor sources.

Cross-edges whose two endpoints are not BOTH in the returned neighbor
set MUST be discarded — this pruning is what makes the subgraph
*induced*. Duplicate edges between the same unordered pair and type MUST
be deduplicated (undirected key; on collision the higher weight wins).
Self-edges MUST be dropped.

**Fan-out bound (the N+1 guard).** Only the top `fanout` neighbors per
class (ranked by fact count) are expanded, NOT all `limit` of them. The
`co_occurs_with` derivation MUST short-circuit when fewer than 2 neighbor
compounds exist; the `related_source` derivation MUST short-circuit when
fewer than 2 neighbor sources exist. Edges MUST be returned sorted by
`weight` descending.

#### Scenario: Cross-edges appear between neighbors

- GIVEN a focus entity whose neighborhood contains ≥2 compounds that
  co-occur and ≥2 sources that share a compound or species
- WHEN the neighborhood is returned
- THEN at least one compound↔compound edge is present between two
  neighbor compounds
- AND at least one source↔source edge is present between two neighbor
  sources
- AND those edges are not incident to the focus node

#### Scenario: Out-of-neighborhood cross-edges are pruned

- GIVEN a neighbor compound that co-occurs with a compound NOT in the
  neighborhood
- WHEN the neighborhood is returned
- THEN no edge referencing that out-of-neighborhood compound is emitted
- AND no node is added for it

#### Scenario: Duplicate edges are deduplicated

- GIVEN two helpers that both yield the same unordered pair and type
- WHEN the payload is composed
- THEN exactly one edge is emitted for that pair and type
- AND its weight is the maximum of the colliding weights

#### Scenario: Fan-out bounds the number of expansions

- GIVEN a focus whose neighborhood contains more neighbor compounds than
  `fanout`
- WHEN the induced subgraph is derived
- THEN at most `fanout` neighbor expansions are issued per class
- AND the remaining neighbors still appear as nodes with their spokes

#### Scenario: Sparse neighborhood short-circuits

- GIVEN a focus with fewer than 2 neighbor sources
- WHEN the neighborhood is composed
- THEN no `buildCitationGraph` expansion is issued
- AND no `related_source` edge is emitted

### Requirement: Typed And Weighted Edges

Every edge MUST declare a `type` drawn from the closed set:

| Type             | Endpoints          | Role    | Weight source                                    |
| ---------------- | ------------------ | ------- | ------------------------------------------------ |
| `has_compound`   | entity → compound  | spoke   | compound `fact_count` from `expandEntity`        |
| `has_source`     | entity → source    | spoke   | source `fact_count` / fact-link count            |
| `reports`        | compound ↔ source  | induced | # facts joining that compound to that source     |
| `co_occurs_with` | compound ↔ compound| induced | `getTopCoOccurring` shared-source `fact_count`   |
| `related_source` | source ↔ source    | induced | `buildCitationGraph` weight = 3·compounds + 2·species + 5·doi |

Every edge MUST carry a numeric `weight` (higher = stronger) so a client
can rank, threshold, or filter edges without re-deriving the signal.
Weights MUST be deterministic — derived from the existing counts (shared
compounds, shared species, shared sources, fact counts), never from an
LLM.

**Weights are comparable only WITHIN a type.** They MUST NOT be
normalized across types by the endpoint: a `related_source` weight of 11
and a `co_occurs_with` weight of 11 are different units. The endpoint
returns raw values; the client normalizes per type for presentation.

#### Scenario: Edge weight is deterministic and rankable

- GIVEN two identical requests for the same focus node with unchanged data
- WHEN both responses are compared
- THEN the same edges are returned with the same `type` and `weight`
- AND edges can be sorted by `weight` descending

#### Scenario: Weight reflects the underlying signal strength

- GIVEN two source↔source neighbors, one sharing 3 compounds and one
  sharing 1
- WHEN the neighborhood is returned
- THEN the 3-compound edge has a strictly greater `weight`

#### Scenario: Weights are not normalized across types

- GIVEN a payload containing both a `co_occurs_with` and a
  `related_source` edge
- WHEN the weights are inspected
- THEN each is the raw value from its own helper
- AND no cross-type rescaling has been applied

### Requirement: Authentication Gate (Any Authenticated Caller, Read-Only)

The endpoint MUST be gated by `authResolver({ required: true })`:
authentication required, NO role restriction, so any authenticated
caller (JWT of any role, x402/b402 proof, or api-key) may read it. It
MUST return HTTP 401 before executing any database query when no auth
context is present. It MUST remain READ-ONLY.

#### Scenario: Unauthenticated request returns 401

- GIVEN no auth header is sent
- WHEN `GET /graph/neighborhood` is called
- THEN the response is HTTP 401
- AND no database query is executed

#### Scenario: Non-admin authenticated request succeeds

- GIVEN a JWT-authenticated caller whose role is NOT `admin`
- WHEN the endpoint is called with valid parameters
- THEN the response is HTTP 200 with the normal body
- AND no 403 is returned

### Requirement: On-The-Fly Composition (No Storage, No Migration)

The neighborhood MUST be composed at request time from existing
helpers. The change MUST NOT introduce a new table, a new column, a
materialized edge store, a refresh hook, or a database migration, and
MUST NOT perform any write. It MUST NOT call an LLM.

#### Scenario: No persistence surface is added

- GIVEN the change's diff
- WHEN it is inspected
- THEN it contains no new migration, no new table or column, and no
  stored-edge write path
- AND no refresh hook is registered

#### Scenario: Request path performs reads only

- GIVEN a neighborhood request
- WHEN the handler runs
- THEN it issues only read queries and no LLM call
- AND it never inserts, updates, or deletes any row

### Requirement: Additive Backend Change

Existing graph endpoints (`/graph/compounds/search`,
`/graph/entities/:kind/search`, `/graph/entities/:kind/:value/expand`,
`/citations/:sourceId`) MUST keep their current request and response
contracts. `buildCitationGraph` MUST keep its public signature and
return shape so it stays composable by the neighborhood endpoint. The
only backend behavior change outside this new endpoint is the citation
candidate-selection fix specified in `bioprospecting-knowledge-graph`.

#### Scenario: Existing endpoints are unchanged

- GIVEN the existing graph read endpoints
- WHEN they are called before and after this change
- THEN their request/response contracts are identical
- AND no consumer must be migrated

### Requirement: Canonical-Id Coverage Measurement

The change MUST report the non-null rate of
`research_bioprospecting_facts.compound_canonical_id` and
`species_taxon_id` over the corpus, so the next slice is scoped on
measured data rather than assumption. The measurement MUST be
read-only and MUST NOT gate the endpoint's behavior. The SQL snippet is
committed in the `citationGraph.ts` header.

Measured at ship time: ~278 of ~472 facts carry a canonical compound
(~59%) — high enough for `co_occurs_with` and `related_source` to yield
real edges, which production confirmed.

#### Scenario: Coverage numbers are reported

- GIVEN the corpus of bioprospecting facts
- WHEN coverage is measured
- THEN the non-null rate for `compound_canonical_id` and for
  `species_taxon_id` is reported and recorded with the change
- AND the endpoint's behavior does not depend on the result

## Out of Scope

- **LLM semantic linker.** No `graphLinkerAgent`, no fact↔fact or
  claim↔claim LLM edges. Deferred behind measured evidence that
  deterministic edges are insufficient, an LLM cost guard, and a human
  review gate.
- **Deterministic fact↔fact edges in `research_edges`.** Requires
  promoting facts to first-class NODES (a real UI model change), hub
  suppression, and a unique constraint. Facts stay edges here.
- **Stored/materialized edges.** Composition is on-the-fly by design.
