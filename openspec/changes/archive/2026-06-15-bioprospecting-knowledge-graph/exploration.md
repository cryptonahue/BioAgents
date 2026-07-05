# Exploration: knowledge graph for bioprospecting

## Current state (what "knowledge" means today)

The Research Brain stores evidence as a constellation of **flat tables** that
the application layer joins ad hoc per query. There is no explicit graph
layer. After the last 4 data-quality changes (compound authority, multi-page
table merge, cost guard rails, figure image extraction) the entities and
their current linking look like this:

### Entity tables (the "nodes")

- `research_sources` — papers / datasets (with DOI, file_path, content_hash).
- `research_evidence_chunks` — text chunks with embeddings (pgvector).
- `research_evidence_tables` — extracted tables with bboxes (per page,
  with `continues_from_id` chain FK from PR #2 of `bioprospecting-multipage-table-merge`).
- `research_evidence_figures` — figure bboxes + extracted image bytes
  (from PR #1+#2 of `figure-image-extraction`).
- `research_bioprospecting_facts` — atomic, structured facts (species,
  compound, bioactivity, geography, …) extracted from chunks/tables/figures.
  Has `identity_key` (5-tuple) and `merged_into_fact_id` for dedup
  (`bioprospecting-semantic-dedup`).
- `research_claims` — semantic claims with `status` (supported / partial /
  contradicted / hypothesis / open_question).
- `research_taxa` / `research_taxon_aliases` — canonical species taxonomy
  + alias map (GBIF-backed).
- `research_compounds` / `research_compound_aliases` — canonical chemistry
  identity + alias map (PubChem-backed, `bioprospecting-compound-authority`).
- `research_bioprospecting_fact_edges` — dedup lineage edges
  (canonical → merged), shape `(canonical_fact_id, merged_fact_id, match_rule)`.
- `research_bioprospecting_contradictions` — fact-level conflicts with
  evidence packs (`bioprospecting-contradiction-detection`).
- `research_edges` — **a generic, underused edge table** that already
  exists. Shape: `(from_id, from_type, relation_type, to_id, to_type,
  metadata)`. Indexed on `(from_id, from_type)` and `(to_id, to_type)`.
- `compound_authority_audit` — JSONB audit, partitioned monthly.

### What the world-state stores (per-conversation, in Postgres JSONB)

`ConversationState.values` (see `src/types/core.ts` line 91-153) carries:

- `objective`, `evolvingObjective`, `currentObjective`
- `keyInsights: string[]`
- `methodology: string`
- `currentHypothesis: string`
- `discoveries: Discovery[]` (each: title, claim, summary,
  `evidenceArray: { taskId, jobId, explanation }[]`, `artifacts`,
  `novelty`)

`Discovery` is **per-conversation** and only links back to plan tasks,
not to the underlying fact/compound/species/claim records in Research
Brain. The discovery agent (`src/agents/discovery/utils.ts` line 28)
re-extracts from task outputs at every cycle — there is no persistent
`Discovery` table.

### Current linking (the "edges" we already have)

- Fact → Source via `source_id` (FK, ON DELETE CASCADE)
- Fact → Chunk via `chunk_id` (FK)
- Fact → Table via `evidence_table_id` (FK, NULL)
- Fact → Figure via `evidence_figure_id` (FK, NULL)
- Fact → Canonical Compound via `compound_canonical_id` (FK)
- Fact → Species/Genus/Family via 3 taxon_id FKs
- Fact → Canonical Fact via `research_bioprospecting_fact_edges` (dedup)
- Fact ↔ Fact (conflicts) via `research_bioprospecting_contradictions`
- Claim → Source via `source_id` (FK)
- Claim → Chunk via `chunk_id` (FK)
- Claim → Source via `research_edges` (from_type="claim",
  relation_type="supports|contradicts|derived_from", to_type="source")
  — created by `createClaimEdges` in `db.ts` line 354.

### The gap

- **No explicit Fact → Compound link** for cases where the
  `compound_canonical_id` was not set (e.g., pending/extracts). Search
  has to do `lower(compound) = lower($1)` joins against aliases.
- **No Fact → Claim link.** The `claim_id` column on the facts table
  exists but is rarely populated; the LLM extractor can choose to
  populate it.
- **No Fact → Discovery link.** Discoveries are conversation-scoped
  (JSONB state), not first-class entities, so a fact extracted in
  conversation A cannot be re-discovered in conversation B.
- **No compound → compound (co-occurrence) edges.** "Compounds that
  appear together in papers" is not a queryable path.
- **No compound → target / disease / application graph.** `application_area`
  is free text on facts; we have no canonical targets/diseases table.
- **No "show me everything known about compound X" path.** Today this
  is a per-search hand-rolled `lower(compound)` filter
  (`searchBioprospectingFacts` in `db.ts`).
- **`research_edges` is generic and untyped.** It works for `claim →
  source` but is not used for any other edge type. No constraint on
  `relation_type` (free text), no source provenance, no metadata
  schema.

## Affected areas

This is a greenfield capability, so the "affected areas" are the
tables and modules the new layer will sit alongside:

- `supabase/migrations/` — new `research_graph_*` tables and the
  indexes/views to power them.
- `src/services/researchBrain/db.ts` — `createClaimEdges` already lives
  here. The new graph writers/queries slot in next to it.
- `src/services/researchBrain/search.ts` — `researchBrainSearch`
  builds the `EvidencePack`; graph expansion hooks in here.
- `src/services/researchBrain/compoundAuthority.ts`,
  `taxonomy.ts`, `bioprospectingExtractor.ts` — the resolution code
  that turns free-text entity mentions into canonical ids. The graph
  layer consumes those canonical ids.
- `src/services/researchBrain/index.ts` — public surface; the new
  graph service exports new helpers (`graphExpand`, `graphForEntity`,
  `graphStats`).
- `src/routes/research-brain.ts` — 32 existing endpoints. New graph
  endpoints slot in under `/api/research-brain/graph/*` (e.g.,
  `/graph/entities/:kind/:canonicalId/expand`,
  `/graph/compounds/:canonicalId/co-occurrences`,
  `/graph/facts/:factId/neighborhood`).
- `src/agents/discovery/index.ts` and `utils.ts` — discovery
  currently extracts from task outputs; v1 of the graph change can
  keep that, v2 can back the discovery candidate pool with graph
  queries.
- `openspec/specs/` — new spec file
  `openspec/specs/bioprospecting-knowledge-graph/spec.md` covering
  the new capability.
- `client/src/components/` — graph visualisation is **out of scope
  for v1** (defer to a follow-up that uses react-flow or similar;
  v1 ships a JSON endpoint and a small list view in the existing
  EvidencePack UI).

## Approaches

### Option A — Adjacency tables in Postgres (recommended)

Add a small set of typed adjacency tables in Postgres, reuse the
existing `pgvector` extension where it already lives, and avoid any
new infrastructure. We already have two edge-shaped tables
(`research_bioprospecting_fact_edges`, `research_edges`) so the
team knows the adjacency pattern.

**Tables to add (one per relation family, all with composite indexes
on `(from_id, from_type)` and `(to_id, to_type)`):**

- `research_graph_entity_mentions` — fact/claim/table/figure → entity
  (compound, taxon, target, application, geography, bioactivity). FKs
  to `research_compounds` / `research_taxa` (existing) and to a new
  `research_graph_target_terms` / `research_graph_application_terms`
  registry (small curated tables). Populated at extraction time by
  the LLM or by deterministic post-processing of the free-text
  fields already on `research_bioprospecting_facts` (e.g.,
  `compound`, `application_area`, `bioactivity`, `assay_model`).
- `research_graph_fact_fact_edges` — Fact → Fact semantic links
  (`related_to`, `co_occurs_with`, `cited_after`, `replicates`).
  Different from `research_bioprospecting_fact_edges` (which is
  dedup lineage) and from `research_bioprospecting_contradictions`
  (which is conflicts). This is the "lateral" knowledge graph.
- `research_graph_claim_claim_edges` — Claim → Claim with
  `relation_type` ∈ {supports, contradicts, extends, refines, is_a}.
  The existing `research_edges` table could be widened (open
  question) or a new typed table is cleaner.
- `research_graph_source_compound_aggregates` — denormalised cache of
  "source paper P contains compound C with N facts at status S". A
  materialised view or a function table refreshed by trigger on
  `research_bioprospecting_facts` insert/update. Powers the "show
  me everything known about compound X across all papers" query in
  O(1) lookup.

**Pros:**

- No new infrastructure. Reuses the Supabase/Postgres we already
  pay for and operate.
- Reuses the existing `research_compounds` and `research_taxa`
  canonical tables as the node identity. The graph layer is a thin
  edge-on-top, not a new store.
- Query path stays SQL: `SELECT ... FROM research_bioprospecting_facts f
  JOIN research_graph_entity_mentions m ON m.from_id = f.id WHERE
  m.to_id = $1`. Joins are exactly what Postgres excels at.
- Indexes are well-understood: composite BTrees on
  `(from_id, from_type)` and `(to_id, to_type)` match the existing
  `research_edges` indexes; GIN on JSONB metadata for facet filters.
- Materialised views are a native Postgres feature; we can precompute
  per-compound and per-species aggregations and refresh on
  ingestion-run completion.
- Reversibility: every table can be dropped without touching the
  underlying facts/claims. The extractor writes the new edges in
  parallel; the read path falls back to the old
  `lower(compound) = lower($1)` join if the new edges are empty.

**Cons:**

- Graph traversals (e.g., "compounds co-occurring with compounds
  that inhibit target T") require recursive CTEs. Those are
  powerful but verbose and slow past depth 3-4. Most of our
  queries are depth 1-2 (expand a node's immediate neighbours),
  so this is fine in practice.
- No native shortest-path / centrality. If we ever want
  betweenness or PageRank, we have to compute it ourselves
  (PostgreSQL has no built-in algorithms — we'd need to do them
  in the application).
- Cardinality of `entity_mentions` will be the same order of
  magnitude as `research_bioprospecting_facts` (one row per
  (fact, entity)). The facts table is already indexed; we add
  one index per edge table.

**Effort:** **Medium**. ~1.5-2 PRs. ~600-800 LOC backend (new
service + new endpoints + new extractor hooks). No frontend
beyond a small read-only list view.

### Option B — Apache AGE (Postgres graph extension)

Add the `age` extension to Supabase Postgres and use Cypher queries
against a graph built on top of the existing tables.

**Pros:**

- Cypher is a natural fit for "expand this node, follow this edge
  type, stop at depth 2" queries.
- Graphs and SQL co-exist in the same database (no new infra).
- AGE supports path queries that recursive CTEs make painful.

**Cons:**

- AGE is **not** on the Supabase managed-extension whitelist (as of
  late 2025). Enabling it requires a self-hosted Postgres or
  Supabase's `extensions` schema override; this is a meaningful
  platform operation and likely not allowed on managed projects.
- AGE is alpha/beta-grade on Postgres 15/16. Production track record
  is thin.
- Supabase Row-Level Security does not apply to AGE's graph layer;
  we'd have to re-implement auth at the query layer.
- New query language to maintain; the team is already fluent in
  Postgres + Supabase, not in Cypher.
- Adds operational risk: graph corruption or extension upgrade
  failures can require DBA intervention.

**Effort:** **High**. 1-2 PRs plus platform work. The infra cost
is the dealbreaker — if Supabase cannot run AGE, this option is
moot.

### Option C — Neo4j (separate graph DB)

Stand up a Neo4j instance, sync Postgres facts/compounds/taxa
into it via a CDC pipeline (e.g., Debezium → Kafka → Neo4j
Streams), and write the new graph queries in Cypher.

**Pros:**

- Best-in-class graph query engine. Native path / centrality /
  community-detection algorithms.
- Cypher is expressive and the right tool for "show me the
  neighbourhood at depth N" and "find shortest path between A
  and B" queries.
- Clear separation: the graph is a derived view of the canonical
  Postgres state. A bug in Neo4j never corrupts the source of
  truth.

**Cons:**

- New infrastructure: a managed Neo4j instance (~$60-300/mo
  depending on tier), a CDC pipeline, a sync lag, and a backup
  story.
- A new auth boundary — the BioAgents API needs to talk to
  Supabase AND Neo4j, with two sets of credentials in
  `.env.example`.
- Sync lag: the graph is eventually consistent. For a "show me
  the new compound that just got canonicalised" query, the
  user sees stale data for as long as the CDC lag.
- Two query languages in the codebase: SQL for everything we
  have today, Cypher for graph traversal. Developers have to
  context-switch.
- Operationally, BioAgents is a small team (CLAUDE.md shows
  one engineering owner). Running a second database cluster
  is a meaningful ops burden.

**Effort:** **High**. 3-4 PRs: infra, CDC sync, API endpoints,
observability. ~1500+ LOC across the new sync worker, the new
graph service, and the new endpoints.

### Option D — Materialised views + recursive CTEs only (no new edge tables)

Skip dedicated edge tables. Build the graph purely from the
existing `research_bioprospecting_facts` join keys (compound,
taxon_id, source_id) plus a few materialised views that precompute
compound × source and compound × compound co-occurrence matrices.

**Pros:**

- Zero schema delta. Zero migration risk.
- Reuses the join keys that are already indexed.
- Fast read path: the materialised view is a single
  `SELECT ... GROUP BY compound_canonical_id` lookup.

**Cons:**

- No new relations can be expressed. "Claim A supports claim B",
  "target X is inhibited by compound Y" — neither is a join
  key in the existing facts table.
- The free-text fields (`bioactivity`, `application_area`,
  `assay_model`) cannot participate in a join graph without
  being canonicalised first. This option depends on the
  follow-up that builds the `target_terms` /
  `application_terms` registry anyway, so it doesn't save
  work.
- The "show me the evidence chain for hypothesis H" path needs
  Fact → Claim → Discovery links, none of which exist as
  join keys today.

**Effort:** **Low-Medium** for the views, but it's a half-measure:
it can power "facts about compound X" but it cannot power the
richer "what does the literature say about X across N papers"
queries that the discovery agent needs. **Not recommended as a
standalone choice**; could be combined with Option A as the
read-side layer.

## Sub-areas within "knowledge graph" (ranked by value)

The phrase "knowledge graph" covers several distinct capabilities.
Recommended v1 slice, in priority order:

### 1. Compound-centric graph (HIGHEST VALUE)

The most common bioprospecting question is "what do we know about
compound X?" This is the only query that directly answers a
researcher question, and it's the one that today requires the most
hand-rolled joins.

- `research_graph_compound_aggregates` materialised view.
- New endpoint `GET /api/research-brain/graph/compounds/:canonicalId`
  → returns `{ compound, allFacts, allSources, allClaims, relatedCompounds }`.
- Backed by the existing `research_compounds` /
  `research_bioprospecting_facts` / `research_claims` tables. No
  new edge types needed for v1; just a denormalised read path.
- **Effort: Low. ~150 LOC. 1 PR.**

### 2. Fact → entity mention graph (HIGH VALUE)

Turn every fact's free-text fields (`compound`, `bioactivity`,
`assay_model`, `application_area`, `geography`, `ecosystem`) into
typed edges to canonical entities. This is the bridge between
today's free-text mining and tomorrow's graph queries.

- `research_graph_entity_mentions` table (one row per
  (fact_id, entity_kind, entity_id)).
- New tables `research_graph_target_terms` and
  `research_graph_application_terms` for the new canonical
  entities (curated seed list + LLM-driven expansion). Mirror
  the `research_compounds` / `research_taxa` pattern.
- New post-processing pass in
  `replaceBioprospectingFactsForSource` that resolves
  free-text mentions to canonical ids and writes the edges.
- New endpoint `GET /api/research-brain/graph/entities/:kind/:id/expand`
  → returns the 1-hop neighbourhood (facts, claims, sources).
- **Effort: Medium. ~400 LOC. 1-2 PRs.**

### 3. Compound co-occurrence graph (MEDIUM VALUE)

"Which compounds appear together in the same paper / same
experiment?" is a bread-and-butter network biology question. This
is a one-shot precompute that the materialised view in #1 can
incorporate, or a separate table.

- `research_graph_compound_co_occurrences` table with columns
  `(compound_a_id, compound_b_id, source_id, fact_count,
  last_seen_at)`. PK `(compound_a_id, compound_b_id, source_id)`
  with `compound_a_id < compound_b_id` for ordering.
- Refreshed by trigger on `research_bioprospecting_facts` insert
  (or batched on ingestion-run completion).
- New endpoint `GET /api/research-brain/graph/compounds/:id/co-occurrences`
  → top N co-occurring compounds ranked by fact count.
- **Effort: Low-Medium. ~200 LOC. 1 PR.**

### 4. Fact → Fact and Claim → Claim semantic edges (MEDIUM VALUE, LATER)

The most "graph-like" layer: explicit semantic links between
facts and claims. This is what enables the discovery agent to
find lateral patterns.

- `research_graph_fact_fact_edges` and
  `research_graph_claim_claim_edges` tables. Edges populated by
  an LLM pass over the existing facts/claims (one shot per
  source ingestion), not at write time.
- New `graphLinkerAgent` (a small LLM-driven service) that
  walks pairs of facts in a source and emits "related",
  "replicates", "extends" edges. Mirrors the existing
  `contradictionDetector` pattern.
- **Effort: Medium. ~500 LOC. 1-2 PRs. LLM cost is real** — needs
  a per-source budget guard (cf. the cost guard rails change).

### 5. Discovery persistence (LOW VALUE, DEFERRED)

Right now discoveries are conversation-scoped JSONB. A future
change can promote them to first-class entities with their own
table (`research_discoveries`) and link them to facts / claims
via the same `research_graph_*` tables. This is out of scope
for the v1 graph change — defer until the user-facing need
("show me discoveries across all my conversations") is
validated.

### 6. Graph visualisation UI (LOW VALUE, DEFERRED)

A `react-flow` view that draws nodes + edges for a compound
neighbourhood. **Explicitly out of scope** for v1; ship a JSON
endpoint first, build the UI when there's a concrete user
request.

## Entities and relations to model

### Node types

| Node type | Canonical table | Notes |
|---|---|---|
| Source (paper / dataset) | `research_sources` | Existing. |
| Fact | `research_bioprospecting_facts` | Existing. |
| Claim | `research_claims` | Existing. |
| Chunk | `research_evidence_chunks` | Existing. |
| Table | `research_evidence_tables` | Existing. |
| Figure | `research_evidence_figures` | Existing. |
| Compound | `research_compounds` | Existing. |
| Taxon | `research_taxa` | Existing. |
| **Target** | `research_graph_target_terms` (NEW) | Small curated list seeded from MeSH/UniProt. |
| **Application** | `research_graph_application_terms` (NEW) | Curated list seeded from bioactivity vocabularies. |
| **Geography** | `research_graph_geography_terms` (NEW) | Optional, mirrors `target_terms`. |
| **Discovery** | (deferred) | Future. |

### Edge types (v1 scope)

| From | → To | Relation | Storage | Notes |
|---|---|---|---|---|
| Fact | → | Compound | `mentions` | `research_bioprospecting_facts.compound_canonical_id` (existing) or new `entity_mentions` for un-canonicalised facts |
| Fact | → | Taxon (species/genus/family) | `mentions` | `research_bioprospecting_facts.species_taxon_id` etc. (existing) |
| Fact | → | Target | `mentions` | New `entity_mentions` |
| Fact | → | Application | `mentions` | New `entity_mentions` |
| Fact | → | Source | `extracted_from` | `research_bioprospecting_facts.source_id` (existing) |
| Fact | → | Chunk | `grounded_in` | `research_bioprospecting_facts.chunk_id` (existing) |
| Fact | → | Table | `grounded_in` | `research_bioprospecting_facts.evidence_table_id` (existing) |
| Fact | → | Figure | `grounded_in` | `research_bioprospecting_facts.evidence_figure_id` (existing) |
| Fact | → | Claim | `supports` | New `fact_claim_edges`; populated by LLM at claim extraction |
| Fact | → | Fact | `related_to` / `replicates` / `extends` | New `fact_fact_edges`; LLM-driven |
| Claim | → | Claim | `supports` / `contradicts` / `extends` / `refines` | Already partly in `research_edges`; new typed table is cleaner |
| Compound | → | Compound | `co_occurs_with` | New `compound_co_occurrences` |
| Compound | → | Source | `reported_in` | Materialised view; one row per (compound, source) |
| Compound | → | Target | `binds_to` / `inhibits` / `activates` | New `compound_target_edges`; LLM-extracted at ingestion |

### Relations explicitly out of scope for v1

- `Discovery → Fact` (discoveries are still JSONB, not entities).
- `Compound → Compound` "metabolite_of" (no metabolism graph
  today).
- `Source → Source` citation graph (could be a future
  `cites_source_id` edge if we ever parse reference lists).

## Recommendation

**Option A (adjacency tables in Postgres), shipped in 3 chained PRs.**

Rationale:

- The team's existing knowledge of the stack is Postgres +
  Supabase. Option A is the lowest-risk path; it ships the
  capability the user is asking for without introducing a new
  database cluster or a new query language.
- The four most valuable query patterns (compound-centric
  aggregation, fact → entity mention graph, compound
  co-occurrence, fact/claim semantic links) are all expressible
  in SQL with adjacency tables. Recursive CTEs handle the
  1-3 hop traversals the discovery agent actually needs.
- The cost (in eng time and infra) is 1/3 of Option C (Neo4j)
  and strictly less risky than Option B (AGE) given the
  Supabase extension constraints.
- The 3-PR split mirrors the project's recent pattern
  (`bioprospecting-multipage-table-merge` shipped in 3 chained
  PRs at ~270/~340/~160 LOC). Each PR is reviewable in a
  single sitting and independently rollbackable.

**Chosen PR split:**

| PR | Scope | ~LOC | Effort |
|---|---|---|---|
| #1 | Compound-centric graph (sub-area 1): materialised view + `GET /api/research-brain/graph/compounds/:canonicalId` + small list UI in the existing EvidencePack panel | ~250 | Low |
| #2 | Entity mention graph (sub-area 2): `entity_mentions` table + `target_terms` / `application_terms` seed + post-processing pass in `replaceBioprospectingFactsForSource` + `GET /api/research-brain/graph/entities/:kind/:id/expand` | ~500 | Medium |
| #3 | Compound co-occurrence + LLM-driven fact/claim edges (sub-areas 3 + 4): `compound_co_occurrences` table + `graphLinkerAgent` (gated by a feature flag, mirrors `BIOPROSPECTING_CONTRADICTION_DETECTION`) + `GET /api/research-brain/graph/compounds/:id/co-occurrences` | ~600 | Medium |

PR #1 is the highest leverage for the least work; ship it first
and use it to validate the read-side API shape before the
write-side work in PR #2. PR #3 is the one that needs an LLM cost
budget — it should ship behind a feature flag with a per-source
cap, mirroring the cost guard rails change.

## Schema impact (Option A, all 3 PRs combined)

```sql
-- PR #1
CREATE MATERIALIZED VIEW public.research_graph_compound_aggregates AS
SELECT
  c.id AS compound_id,
  c.canonical_name,
  c.normalized_name,
  c.pubchem_cid,
  COUNT(DISTINCT f.id) AS fact_count,
  COUNT(DISTINCT f.source_id) AS source_count,
  COUNT(DISTINCT f.claim_id) FILTER (WHERE f.claim_id IS NOT NULL) AS claim_count,
  MAX(f.created_at) AS last_seen_at
FROM public.research_compounds c
LEFT JOIN public.research_bioprospecting_facts f
  ON f.compound_canonical_id = c.id
GROUP BY c.id, c.canonical_name, c.normalized_name, c.pubchem_cid;

CREATE UNIQUE INDEX idx_research_graph_compound_aggregates_pk
  ON public.research_graph_compound_aggregates (compound_id);
CREATE INDEX idx_research_graph_compound_aggregates_fact_count
  ON public.research_graph_compound_aggregates (fact_count DESC);

-- PR #2
CREATE TABLE IF NOT EXISTS public.research_graph_target_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  external_ids JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'curated' CHECK (status IN ('curated', 'auto', 'manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- research_graph_application_terms mirrors this

CREATE TABLE IF NOT EXISTS public.research_graph_entity_mentions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id UUID NOT NULL,                  -- fact id (or claim id)
  from_type TEXT NOT NULL,                -- 'fact' | 'claim'
  entity_kind TEXT NOT NULL,              -- 'compound' | 'taxon' | 'target' | 'application' | 'geography'
  entity_id UUID NOT NULL,                -- FK by kind (compound → research_compounds, taxon → research_taxa, target/application → graph_*_terms)
  surface_form TEXT,                      -- raw text that was resolved
  confidence TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low')),
  resolver TEXT NOT NULL DEFAULT 'extractor' CHECK (resolver IN ('extractor', 'alias_table', 'llm', 'manual')),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_entity_mentions_from ON public.research_graph_entity_mentions (from_id, from_type);
CREATE INDEX idx_entity_mentions_entity ON public.research_graph_entity_mentions (entity_kind, entity_id);

-- PR #3
CREATE TABLE IF NOT EXISTS public.research_graph_compound_co_occurrences (
  compound_a_id UUID NOT NULL REFERENCES public.research_compounds(id) ON DELETE CASCADE,
  compound_b_id UUID NOT NULL REFERENCES public.research_compounds(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES public.research_sources(id) ON DELETE CASCADE,
  fact_count INTEGER NOT NULL DEFAULT 1,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (compound_a_id, compound_b_id, source_id),
  CONSTRAINT compound_co_occurrences_ordered CHECK (compound_a_id < compound_b_id)
);

CREATE INDEX idx_compound_co_occurrences_b
  ON public.research_graph_compound_compound_co_occurrences (compound_b_id, fact_count DESC);
```

## Estimated complexity

- **Overall: Medium** (across all 3 PRs).
- PR #1: Low (~250 LOC, 1 migration, 1 endpoint, 1 small UI).
- PR #2: Medium (~500 LOC, 2 small curated tables + 1 large
  mention table, 1 extractor post-pass, 1 endpoint, 1 LLM helper
  for term expansion).
- PR #3: Medium (~600 LOC, 1 trigger or batch job, 1 LLM linker
  agent behind a feature flag, 1 endpoint, cost guard rails).
- Test coverage needed: aggregate view refresh correctness,
  mention resolution happy-path + miss-path, co-occurrence
  trigger idempotency, linker agent cost cap.
- Total backend: ~1,300 LOC across the 3 PRs.
- Total frontend: ~80 LOC for the list view in PR #1 (rest is
  JSON-only, no UI).
- No new infra: stays on Supabase Postgres.

## Key files to modify

- `supabase/migrations/<date>_graph_compound_aggregates.sql` (PR #1)
- `supabase/migrations/<date>_graph_entity_mentions.sql` (PR #2)
- `supabase/migrations/<date>_graph_compound_co_occurrences.sql` (PR #3)
- `src/services/researchBrain/graphService.ts` (NEW) — read-side
  graph query helpers (`graphForCompound`, `graphExpandEntity`,
  `graphCoOccurrences`).
- `src/services/researchBrain/graphWriter.ts` (NEW) — write-side
  helpers called from the extractor (`writeEntityMentionsForFact`).
- `src/services/researchBrain/index.ts` — public exports.
- `src/services/researchBrain/db.ts` — slot the graph writers in
  next to `createClaimEdges`; pass `research_graph_entity_mentions`
  inserts in the same batch as fact inserts.
- `src/services/researchBrain/bioprospectingExtractor.ts` —
  `replaceBioprospectingFactsForSource` calls `writeEntityMentionsForFact`
  after the fact insert succeeds. Mirrors how
  `attachCompoundAuthority` is called today.
- `src/services/researchBrain/graphLinkerAgent.ts` (PR #3 NEW) —
  LLM-driven fact ↔ fact and claim ↔ claim edge extractor. Mirrors
  the existing `contradictionDetector.ts` shape (deterministic
  + LLM pass).
- `src/routes/research-brain.ts` — 3 new endpoints (one per PR).
- `src/services/researchBrain/llm-cost.ts` — wire PR #3's
  linker into the existing cost guard rail.
- `client/src/components/EvidencePack.tsx` (or whichever panel
  renders the list) — small read-only list view in PR #1.
- `openspec/specs/bioprospecting-knowledge-graph/spec.md` (NEW)
  — covers all 3 sub-areas.

## Risks and open questions

- **Re-extraction blast radius.** PR #2 adds a post-pass that runs
  at every ingestion. We need it to be idempotent and to fail
  gracefully (a mention resolution miss should not fail the
  ingestion). Pattern: write the mentions after the fact insert
  commits; on failure, log a warning and continue. Open question:
  do we want a backfill script (cf. `scripts/merge-multipage-tables.ts`)
  to populate the mention table for already-ingested sources, or
  do we let it grow organically as new extractions run?
- **Curated term lists.** `research_graph_target_terms` and
  `research_graph_application_terms` start small (a seeded list
  of ~100-500 terms). Open question: what is the seeding source?
  MeSH for applications? UniProt for targets? A small LLM
  distillation over the existing `bioactivity` /
  `application_area` text to bootstrap? Recommendation: ship
  with a tiny curated seed (~50 terms per table) and add an LLM
  expansion pass gated behind a feature flag, mirroring the
  compound authority approach.
- **`research_edges` reuse vs new typed tables.** The existing
  `research_edges` table is already used for `claim → source`
  links. We could widen it (add CHECK constraints on
  `relation_type`, add FK columns) or we could leave it alone and
  add a new `research_graph_claim_claim_edges` table. Open
  question for the orchestrator: widen or duplicate? The
  `bioprospecting-multipage-table-merge` change pattern is
  additive (new table, no mutation of existing), so recommendation
  is duplicate.
- **LLM cost on the linker (PR #3).** The fact/claim linker is
  the only LLM-driven step. At ~$0.001 per pair and a worst case
  of O(N²) pairs per source, a single 200-fact source could cost
  ~$20. Hard cap via the existing cost guard rails; recommend
  sampling (only link facts from sources with > 5 facts in the
  last 30 days) and a per-source LLM call budget of $0.50.
- **Supabase RLS on the new tables.** Mirror the existing
  `GRANT ALL TO anon, authenticated, service_role` pattern from
  `compound_authority` and `bioprospecting_dedup`. The
  graph endpoints read all of these, so service_role is fine for
  the v1 read path; per-user isolation is not a current concern
  (Research Brain data is shared corpus, not per-user).
- **Cardinality / index bloat.** The mention table will be the
  same order of magnitude as the facts table (~10⁵-10⁶ rows).
  The composite indexes on `(from_id, from_type)` and
  `(entity_kind, entity_id)` will be 2-3x the size of the table.
  We should measure after PR #2 lands and add a partial index
  if needed.
- **Discovery persistence deferred.** The Discovery ↔ Fact link
  is the most user-facing win, but it requires promoting
  `Discovery` from a JSONB blob to a first-class entity. That's
  a separate change. Open question: do we want to ship a
  "discovery exports to fact links" JSON field on discoveries
  in the meantime? Recommendation: defer to a follow-up
  `bioprospecting-discovery-persistence` change.

## Ready for proposal

Yes. The exploration is complete enough to write a `proposal.md`
for the first sub-area (compound-centric graph, PR #1). The
orchestrator should propose Option A as a 3-chained-PR delivery
and frame PR #1 as the v1 with the strongest user-visible
benefit for the lowest cost.
