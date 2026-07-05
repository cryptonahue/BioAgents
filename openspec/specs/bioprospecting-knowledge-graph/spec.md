# Spec: bioprospecting-knowledge-graph

## Purpose

Ship the first slice of an explicit "knowledge graph" read layer for
the Research Brain: a **compound-centric aggregate view** that answers
"what do we know about compound X across all papers" in a single,
cheap, O(1) lookup. v1 is one PR that adds a single materialized view,
one SQL function, one read-side service module, one search endpoint,
and a soft-fail refresh hook from the bioprospecting extractor.

The capability is purely additive. The `research_bioprospecting_facts`,
`research_bioprospecting_claims`, and `research_sources` schemas are
unchanged. The new layer is the read-side foundation the discovery
agent, the evidence pack, and the future graph query layer will all
build on. v2/v3 (entity mention graph, compound co-occurrence table,
LLM-driven fact↔fact and claim↔claim edges) are explicitly out of
scope and tracked as follow-up changes.

## Requirements

### Requirement: research_graph_compound_aggregates Materialized View

The system MUST create a `research_graph_compound_aggregates`
materialized view that exposes one row per canonical compound with
denormalized counts and timestamps that summarise everything the
Research Brain knows about that compound. The view is the read-side
foundation: every graph query in v1 reads from this view first and
joins back to the source tables only when a per-fact payload is
required.

**Schema:**

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS public.research_graph_compound_aggregates AS
SELECT
  c.id                              AS compound_id,
  c.canonical_name,
  c.normalized_name,
  c.pubchem_cid,
  c.chebi_id,
  c.molecular_formula,
  COUNT(DISTINCT f.id)              AS fact_count,
  COUNT(DISTINCT f.source_id)       AS source_count,
  COUNT(DISTINCT f.claim_id) FILTER (WHERE f.claim_id IS NOT NULL) AS claim_count,
  MAX(f.created_at)                 AS last_seen_at,
  MIN(f.created_at)                 AS first_seen_at
FROM public.research_compounds c
LEFT JOIN public.research_bioprospecting_facts f
  ON f.compound_canonical_id = c.id
GROUP BY
  c.id, c.canonical_name, c.normalized_name, c.pubchem_cid,
  c.chebi_id, c.molecular_formula;
```

**Indexes:**

```sql
-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS idx_research_graph_compound_aggregates_pk
  ON public.research_graph_compound_aggregates (compound_id);

-- Backs "top compounds by fact count" listings.
CREATE INDEX IF NOT EXISTS idx_research_graph_compound_aggregates_fact_count
  ON public.research_graph_compound_aggregates (fact_count DESC);

-- Backs "recently active compounds" listings.
CREATE INDEX IF NOT EXISTS idx_research_graph_compound_aggregates_last_seen
  ON public.research_graph_compound_aggregates (last_seen_at DESC);
```

**Column semantics:**

- `compound_id` is the FK-equivalent primary key, copied from
  `research_compounds.id`. The unique index on this column is the
  prerequisite for `REFRESH MATERIALIZED VIEW CONCURRENTLY`.
- `canonical_name` and `normalized_name` are copied (not joined) so
  the view is self-contained and `searchCompounds` can read it
  without a second hop.
- `pubchem_cid`, `chebi_id`, and `molecular_formula` are copied from
  the canonical row. All three are nullable — compounds that never
  resolved to PubChem or ChEBI still appear, just with NULL
  chemistry metadata.
- `fact_count` is the distinct number of `research_bioprospecting_facts`
  rows whose `compound_canonical_id` points at this compound.
  A compound with no facts (e.g. just resolved, not yet cited) is
  still present with `fact_count = 0` because the join is `LEFT`.
- `source_count` is the distinct number of source documents that
  contain at least one fact for this compound. This is the
  cross-paper reach signal — the "how many papers mention this"
  number — and is the headline metric for the search response.
- `claim_count` counts only facts whose `claim_id IS NOT NULL`,
  i.e. facts that have been promoted into a research claim. A
  compound that is widely cited as raw facts but never promoted
  to a claim will have a low `claim_count` even with a high
  `fact_count`. The two together describe extraction depth vs.
  curation depth.
- `last_seen_at` is the most recent `created_at` of any fact for
  this compound. Used for "recently active compounds" listings.
- `first_seen_at` is the earliest `created_at` of any fact for this
  compound. Used for the compound's "first cited in our corpus"
  signal. NULL when `fact_count = 0`.

The view MUST be `MATERIALIZED` (not a plain view) so the read path
is O(1) on a single-row lookup and does not re-aggregate the full
facts table on every request. The trade-off — staleness bounded by
the post-extraction refresh hook — is documented in the refresh
requirement below.

#### Scenario: View is populated on a populated facts table

- GIVEN 5 canonical compounds in `research_compounds`
- AND 1,200 facts in `research_bioprospecting_facts` spread across
  the 5 compounds, with 17 distinct sources and 4 distinct claims
- WHEN the migration runs
- THEN `research_graph_compound_aggregates` has exactly 5 rows
- AND each row's `fact_count`, `source_count`, and `claim_count`
  match a `SELECT COUNT(DISTINCT ...)` from the source tables
- AND the `last_seen_at` and `first_seen_at` match
  `MAX(f.created_at)` and `MIN(f.created_at)` for that compound

#### Scenario: Compound with zero facts is present with zero counts

- GIVEN a canonical compound C that has no facts pointing at it
- AND 4 other compounds that do
- WHEN the migration runs
- THEN `research_graph_compound_aggregates` has 5 rows
- AND C's row has `fact_count = 0`, `source_count = 0`,
  `claim_count = 0`, `last_seen_at = NULL`, `first_seen_at = NULL`

#### Scenario: Unique index is created

- GIVEN the migration has run
- WHEN `pg_indexes` is queried for
  `research_graph_compound_aggregates`
- THEN three indexes exist:
  `idx_research_graph_compound_aggregates_pk` (unique on
  `compound_id`), `idx_research_graph_compound_aggregates_fact_count`
  (on `fact_count DESC`),
  `idx_research_graph_compound_aggregates_last_seen` (on
  `last_seen_at DESC`)

### Requirement: refresh_compound_aggregates SQL Function

The system MUST expose a `public.refresh_compound_aggregates()`
SQL function that wraps `REFRESH MATERIALIZED VIEW CONCURRENTLY
public.research_graph_compound_aggregates` so callers do not need
to remember the unique-index prerequisite, and so the post-extraction
hook in the application layer can call a stable surface.

**Signature:**

```sql
CREATE OR REPLACE FUNCTION public.refresh_compound_aggregates()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY
    public.research_graph_compound_aggregates;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'refresh_compound_aggregates failed: %', SQLERRM;
END;
$$;
```

**Contract:**

- The function MUST be `RETURNS void` and MUST NOT take arguments.
- The function MUST attempt `REFRESH MATERIALIZED VIEW CONCURRENTLY`.
  `CONCURRENTLY` requires the unique index on `compound_id` and is
  a no-op for reads while it runs.
- The function MUST catch any exception and emit a `RAISE WARNING`
  rather than re-throw. The first refresh after `CREATE
  MATERIALIZED VIEW` (when the view has never been populated)
  can fail under `CONCURRENTLY` because there is no prior version
  to compare against; the migration handles the initial populate
  with a non-concurrent `REFRESH MATERIALIZED VIEW` and the
  function's soft-fail behaviour keeps the post-extraction hook
  simple.
- The function MUST be `SECURITY INVOKER` (default) and MUST be
  executable by the Supabase service role. GRANTs mirror the
  pattern used by `compound_authority` and `bioprospecting_dedup`:
  `GRANT EXECUTE ON FUNCTION public.refresh_compound_aggregates()
  TO anon, authenticated, service_role;`. The endpoint layer reads
  via the service role; per-user isolation is not a current concern
  (Research Brain data is a shared corpus, not per-user data).
- The function MUST be idempotent: calling it twice in a row with
  no underlying changes is a no-op (the view's contents are
  byte-identical).

#### Scenario: First successful refresh after migration

- GIVEN the migration has just run, populating the view with the
  non-concurrent `REFRESH MATERIALIZED VIEW` step
- WHEN `SELECT public.refresh_compound_aggregates();` is called
- THEN the call returns successfully
- AND no warning is logged
- AND the view's row count and aggregate values are unchanged
  (idempotent)

#### Scenario: Refresh on an empty view logs a warning and does not throw

- GIVEN a database where the migration's initial non-concurrent
  `REFRESH MATERIALIZED VIEW` was skipped (e.g. an empty
  `research_compounds` table at migration time)
- AND the view exists with 0 rows
- WHEN `SELECT public.refresh_compound_aggregates();` is called
- THEN the call returns successfully (does not raise an error to
  the caller)
- AND a `WARNING: refresh_compound_aggregates failed: ...` is
  emitted in the server log
- AND the application's `refreshAggregates()` caller's `try/catch`
  does NOT trigger (the SQL function absorbed the error)

### Requirement: Migration Is Idempotent and Self-Contained

The system MUST ship a Supabase migration
`supabase/migrations/<date>_graph_compound_aggregates.sql` that
creates the materialized view, the three indexes, the SQL function,
and the GRANTs, and that performs a non-concurrent initial
`REFRESH MATERIALIZED VIEW` so the view is populated when the
migration lands. The migration MUST be idempotent (`IF NOT EXISTS`
everywhere) so a re-run is a no-op.

**Migration contents (in order):**

1. `CREATE MATERIALIZED VIEW IF NOT EXISTS
   public.research_graph_compound_aggregates` with the column list
   and `LEFT JOIN` from the schema above.
2. `CREATE UNIQUE INDEX IF NOT EXISTS
   idx_research_graph_compound_aggregates_pk` (prerequisite for
   `CONCURRENTLY`).
3. `CREATE INDEX IF NOT EXISTS
   idx_research_graph_compound_aggregates_fact_count` (on
   `fact_count DESC`).
4. `CREATE INDEX IF NOT EXISTS
   idx_research_graph_compound_aggregates_last_seen` (on
   `last_seen_at DESC`).
5. `CREATE OR REPLACE FUNCTION
   public.refresh_compound_aggregates()` with the soft-fail body
   from the SQL function requirement.
6. `GRANT EXECUTE ON FUNCTION
   public.refresh_compound_aggregates() TO anon, authenticated,
   service_role;`.
7. A one-shot non-concurrent refresh so the view is populated on
   first deploy, before any concurrent refreshes have a prior
   version to compare against:
   `REFRESH MATERIALIZED VIEW public.research_graph_compound_aggregates;`
   (no `CONCURRENTLY`).
8. `GRANT SELECT ON
   public.research_graph_compound_aggregates TO anon, authenticated,
   service_role;` so the API layer can read the view via the
   Supabase service role.

The migration MUST NOT depend on a later migration, MUST NOT relax
any existing constraint, and MUST NOT add any new column to
`research_bioprospecting_facts`, `research_bioprospecting_claims`,
or `research_sources`.

#### Scenario: Running the migration on an empty database

- GIVEN an empty database (no `research_compounds`, no
  `research_bioprospecting_facts`)
- WHEN the migration runs
- THEN `research_graph_compound_aggregates` exists and is empty
  (0 rows)
- AND the three indexes exist
- AND `refresh_compound_aggregates()` exists and is callable
- AND `GRANT` entries are in place

#### Scenario: Running the migration on a populated database

- GIVEN a populated `research_compounds` (50 rows) and
  `research_bioprospecting_facts` (10,000 rows)
- WHEN the migration runs
- THEN `research_graph_compound_aggregates` has 50 rows
- AND the row counts and aggregates match the source tables
- AND a `SELECT count(*) FROM
  research_graph_compound_aggregates` returns 50 within
  sub-second time on the v1 corpus

#### Scenario: Re-running the migration is a no-op

- GIVEN the migration has already been applied
- WHEN the migration runs again
- THEN no error is raised
- AND no duplicate view, indexes, or function are created
- AND the existing aggregates are untouched

### Requirement: graphService Read Module

The system MUST export a `graphService` module from
`src/services/researchBrain/graphService.ts` that encapsulates the
read-side of the v1 knowledge graph. The module is a pure
read-side helper: it does not insert, update, or delete any row in
`research_bioprospecting_facts`, `research_compounds`, or the
materialized view.

**Exported functions:**

```typescript
// src/services/researchBrain/graphService.ts

export type CompoundAggregateStats = {
  fact_count: number;
  source_count: number;
  claim_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

export type CompoundAggregate = {
  compound_id: string;
  canonical_name: string;
  normalized_name: string;
  pubchem_cid: number | null;
  chebi_id: number | null;
  molecular_formula: string | null;
  stats: CompoundAggregateStats;
};

export type TopItem<TKey extends string> = {
  value: TKey extends "compound_id"
    ? { compound_id: string; canonical_name: string; fact_count: number }
    : { value: string; fact_count: number };
};

export type SearchCompoundsParams = {
  query: string;
  limit?: number;     // default 20, max 100
  expand?: boolean;   // default false
};

export type SearchCompoundsResult = {
  compound: CompoundAggregate;
  stats: CompoundAggregateStats;
  topCoOccurring?: Array<{ compound_id: string; canonical_name: string; fact_count: number }>;
  topGeographies?: Array<{ value: string; fact_count: number }>;
  topBioactivities?: Array<{ value: string; fact_count: number }>;
};

export async function searchCompounds(
  params: SearchCompoundsParams,
): Promise<SearchCompoundsResult[]>;

export async function refreshAggregates(): Promise<void>;

export async function getTopCoOccurring(
  compoundId: string,
  limit?: number,    // default 5
): Promise<Array<{ compound_id: string; canonical_name: string; fact_count: number }>>;

export async function getTopGeographies(
  compoundId: string,
  limit?: number,    // default 5
): Promise<Array<{ value: string; fact_count: number }>>;

export async function getTopBioactivities(
  compoundId: string,
  limit?: number,    // default 5
): Promise<Array<{ value: string; fact_count: number }>>;
```

**`searchCompounds` behavior:**

- Default `limit` is 20. Maximum allowed `limit` is 100. Calls
  passing a larger value MUST be clamped to 100 (the function
  MUST NOT throw on over-limit input; the route layer surfaces
  the actual limit applied in the response).
- The function MUST read from
  `research_graph_compound_aggregates` for the compound row plus
  stats. Alias matching is done as a follow-up join against
  `research_compound_aliases` (see the alias-matching requirement
  below).
- Results are returned in match-quality order: exact canonical
  > exact alias > prefix > substring. Ties break by
  `fact_count` descending (more-cited compounds first), then by
  `canonical_name` ascending.
- `expand` defaults to `false`. When `true`, the function MUST
  additionally call `getTopCoOccurring`, `getTopGeographies`, and
  `getTopBioactivities` for each hit and attach the arrays to the
  result. The three top-N calls are issued in parallel
  (`Promise.all`) to keep latency bounded.
- The function MUST be read-only: no insert, update, or delete on
  any table or view.
- The function MUST NOT issue a `REFRESH` call; refresh is the
  caller's responsibility.

**`refreshAggregates` behavior:**

- MUST call `public.refresh_compound_aggregates()` via the
  Supabase service role.
- MUST soft-fail: any thrown error MUST be caught and logged
  (`logger?.warn`) with structured context. The function MUST
  resolve successfully (not reject) on any DB error so callers
  can `await` it without a `try/catch`.
- MUST NOT throw.

**`getTopCoOccurring` behavior:**

- MUST execute a query-time CTE over
  `research_bioprospecting_facts` that finds the top
  co-occurring compounds (those that share at least one
  `source_id` with the input compound) and ranks them by
  shared-source count.
- MUST return at most `limit` rows (default 5).
- MUST exclude the input `compoundId` from the result set
  (a compound does not co-occur with itself).
- MUST return at most the input's `limit` items; callers
  that need the full co-occurrence matrix MUST go to the
  v3 `compound_co_occurrences` table.

**`getTopGeographies` / `getTopBioactivities` behavior:**

- MUST read from `research_bioprospecting_facts` filtered by
  `compound_canonical_id = compoundId`.
- MUST group by the relevant free-text field
  (`geography` and `bioactivity` respectively) and rank by
  `COUNT(*) DESC`.
- MUST return at most `limit` rows (default 5).
- MUST NOT mutate any table.

**Cross-cutting:**

- The module MUST NOT introduce a new Supabase client; it
  reuses the existing service-role client from
  `src/db/supabase.ts` (or the equivalent used by the
  surrounding service modules).
- All exported functions MUST have explicit TypeScript
  signatures and SHOULD be exercised by a happy-path test if
  the project's test runner is wired (the project's `test_command`
  is currently empty per `openspec/config.yaml`, so the
  requirement is forward-compatible and does not block the
  PR).

#### Scenario: searchCompounds default response includes stats

- GIVEN 100 canonical compounds, 20 of which have
  `fact_count > 0`
- WHEN `searchCompounds({ query: "quer", limit: 5 })` runs
- THEN the function returns at most 5 results
- AND each result has a `compound` field with `compound_id`,
  `canonical_name`, `normalized_name`, `pubchem_cid`,
  `chebi_id`, `molecular_formula`
- AND each result has a `stats` field with `fact_count`,
  `source_count`, `claim_count`, `first_seen_at`,
  `last_seen_at`
- AND no `topCoOccurring`, `topGeographies`, or
  `topBioactivities` are present on the result objects

#### Scenario: searchCompounds with expand includes the three arrays

- GIVEN a canonical compound C with at least 5 co-occurring
  compounds, 5 distinct geographies, and 5 distinct
  bioactivities in the facts table
- WHEN `searchCompounds({ query: "Quercetin", expand: true })`
  runs
- THEN each result has `topCoOccurring` (≤ 5),
  `topGeographies` (≤ 5), and `topBioactivities` (≤ 5)
  populated

#### Scenario: Limit is clamped to 100

- WHEN `searchCompounds({ query: "x", limit: 500 })` is called
- THEN the function reads at most 100 rows from the view
- AND no error is thrown

#### Scenario: refreshAggregates soft-fails on DB error

- GIVEN the Supabase service-role client is mocked to reject
  the RPC call with a network error
- WHEN `refreshAggregates()` is called
- THEN the function resolves successfully (does not reject)
- AND a warning is logged with structured context
  (`refresh_compound_aggregates_failed_soft_fail`)

#### Scenario: getTopCoOccurring excludes the input compound

- GIVEN a compound C that appears in 3 sources, two of which
  also contain compound D
- WHEN `getTopCoOccurring(C.id, 5)` runs
- THEN D is in the result
- AND C is not in the result

### Requirement: Alias-Aware Compound Search

The `searchCompounds` function MUST match against BOTH
`research_compounds.canonical_name` and
`research_compound_aliases.alias`, case-insensitively, and MUST
order results by match quality. The alias match is the bridge
between the new `graphService.searchCompounds` (which reads from
the materialized view) and the existing alias table owned by the
`bioprospecting-compound-authority` capability.

**Match-quality ranking (best to worst):**

1. **Exact canonical** — `LOWER(canonical_name) = LOWER(query)`,
   case-insensitive.
2. **Exact alias** — `LOWER(alias) = LOWER(query)`,
   case-insensitive, joined to its canonical.
3. **Prefix canonical** — `canonical_name ILIKE query || '%'`.
4. **Substring** — `canonical_name ILIKE '%' || query || '%'`
   OR an alias's `alias ILIKE '%' || query || '%'`. The
   substring tier is the catch-all and the cheapest for the
   planner to ignore when the upper tiers satisfy `limit`.

Ties within a tier MUST break by `fact_count DESC` (more-cited
compounds first), then by `canonical_name ASC` (deterministic).

**Implementation rules:**

- The query MUST be parameterized. `$1` is the lowercased
  query, bound multiple times with the prefix and substring
  patterns. No string interpolation.
- The `LIMIT` MUST be applied AFTER the union and the
  match-quality ordering; the function MUST NOT push the
  limit down to a per-leg subquery (that would let a substring
  hit steal the limit from a higher-quality exact hit).
- The function MUST NOT mutate the alias table or the
  materialized view.

#### Scenario: Exact canonical name ranks before exact alias

- GIVEN a compound C1 with `canonical_name = "Quercetin"`
- AND a compound C2 with `canonical_name = "Quercetin-3-O-glucoside"`
  that has an alias `"Quercetin"`
- WHEN `searchCompounds({ query: "quercetin" })` runs
- THEN the first result is C1
- AND C2 is in the result set, ranked after C1
- AND the order between them is `exact canonical > exact alias`

#### Scenario: Prefix match outranks substring

- GIVEN a compound C1 with `canonical_name = "Quercitrin"`
- AND a compound C2 with `canonical_name = "Isoquercetin"`
- WHEN `searchCompounds({ query: "quer" })` runs
- THEN both appear
- AND C1 ranks first (prefix) and C2 ranks second (substring)

#### Scenario: Substring is a fallback tier

- GIVEN no compound matches `quercetin` exactly and no
  compound has a prefix match
- AND a compound C has `canonical_name = "Isoquercetin"`
- WHEN `searchCompounds({ query: "quercetin" })` runs
- THEN C is in the result set as a substring match
- AND it is the only hit (no higher-quality matches exist)

#### Scenario: Query is case-insensitive

- GIVEN a compound with `canonical_name = "Quercetin"`
- WHEN `searchCompounds({ query: "QUERCETIN" })` runs
- THEN the Quercetin compound is the first result
- AND the response is byte-identical (modulo timestamps) to
  the response for `{ query: "quercetin" }`

### Requirement: Search Endpoint GET /api/research-brain/graph/compounds/search

The system MUST expose a new REST endpoint
`GET /api/research-brain/graph/compounds/search` under a new route
file `src/routes/research-brain-graph.ts` that is mounted at
`/api/research-brain` from `src/index.ts`. The route file is new
so the existing `src/routes/research-brain.ts` (32 endpoints) is
left untouched. The endpoint is the v1 contract for the
knowledge-graph read layer; the JSON shape is stable and any UI
hooks (e.g. an EvidencePack list view) consume the same shape.

**Endpoint contract:**

- `GET /api/research-brain/graph/compounds/search`
- Query parameters:
  - `q` (required, string, 1-100 chars) — search term. Missing
    or empty `q` returns HTTP 400.
  - `limit` (optional, integer) — page size. Default 20,
    max 100. Out-of-range values are clamped silently.
  - `expand` (optional, boolean string) — when `"true"`, the
    response includes `topCoOccurring`, `topGeographies`, and
    `topBioactivities` arrays on each hit. Default `"false"`.
    Any value other than the literal string `"true"` is treated
    as `false`.
- Authentication: required. The route MUST be wrapped in
  `authResolver({ required: true, role: "admin" })` from
  `src/middleware/authResolver.ts`. The role check uses `admin`
  because the resolver at `src/middleware/authResolver.ts`
  lines 334-353 only enforces the `admin` role today; gating
  on `admin` is strictly more restrictive than the eventual
  `researcher` role and protects the route from anonymous
  and JWT-but-not-admin traffic. The route MUST return:
  - HTTP 401 when the caller has no auth context.
  - HTTP 403 when the caller is authenticated but not in the
    `admin` role.
- Response: HTTP 200 with body
  ```json
  {
    "query": "<echo of q>",
    "limit": <clamped limit>,
    "expand": <bool>,
    "compounds": [
      {
        "compound": {
          "compound_id": "uuid",
          "canonical_name": "Quercetin",
          "normalized_name": "quercetin",
          "pubchem_cid": 5280343,
          "chebi_id": null,
          "molecular_formula": "C15H10O7"
        },
        "stats": {
          "fact_count": 137,
          "source_count": 42,
          "claim_count": 8,
          "first_seen_at": "2024-01-12T08:14:00Z",
          "last_seen_at": "2026-06-12T18:22:11Z"
        },
        "topCoOccurring": [
          { "compound_id": "uuid", "canonical_name": "Kaempferol", "fact_count": 41 }
        ],
        "topGeographies": [
          { "value": "Southeast Asia", "fact_count": 12 }
        ],
        "topBioactivities": [
          { "value": "anti-inflammatory", "fact_count": 18 }
        ]
      }
    ]
  }
  ```
  The three expand fields are present iff `expand=true`; they
  MUST be omitted (not present as empty arrays) when
  `expand=false` so the default response stays lightweight.
- Error responses:
  - 400 `{ "error": "missing query parameter q" }` on missing
    or empty `q`.
  - 401 on no auth (per the resolver's contract).
  - 403 on non-admin auth.
  - 500 on DB error with
    `{ "error": "internal_error" }` and no further detail (the
    service role's error message MUST NOT leak to the
    response body).

**Route mount:**

- The new route file is `src/routes/research-brain-graph.ts`
  and exports a default Elysia plugin (or equivalent) that
  is registered in `src/index.ts` alongside the existing
  `researchBrain` mount. The mount prefix is
  `/api/research-brain`, so the full path is
  `/api/research-brain/graph/compounds/search`.
- The new route module is added to
  `src/services/researchBrain/index.ts` as a re-export
  (e.g. `export * from "./graphService"`) so callers that
  consume the researchBrain barrel are unaffected.

#### Scenario: Search returns lightweight results by default

- GIVEN an admin user U and a populated
  `research_graph_compound_aggregates` view
- WHEN `GET /api/research-brain/graph/compounds/search?q=quercetin`
  is called with U's auth token
- THEN the response is HTTP 200
- AND the body has a `compounds` array of up to 20 hits
- AND each hit has `compound` and `stats` populated
- AND no hit has `topCoOccurring`, `topGeographies`, or
  `topBioactivities`

#### Scenario: expand=true adds the three arrays

- GIVEN the same setup as above
- WHEN `GET /api/research-brain/graph/compounds/search?q=quercetin&expand=true`
  is called
- THEN the response is HTTP 200
- AND each hit has `topCoOccurring` (≤ 5), `topGeographies`
  (≤ 5), and `topBioactivities` (≤ 5) populated

#### Scenario: Missing q returns 400

- WHEN `GET /api/research-brain/graph/compounds/search` is
  called with no `q`
- THEN the response is HTTP 400
- AND the body is `{ "error": "missing query parameter q" }`

#### Scenario: Unauthenticated request returns 401

- GIVEN no auth header is sent
- WHEN the endpoint is called
- THEN the response is HTTP 401
- AND no DB query is executed

#### Scenario: Non-admin auth returns 403

- GIVEN a JWT-authenticated user with role other than `admin`
- WHEN the endpoint is called
- THEN the response is HTTP 403
- AND the body is
  `{ "error": "Forbidden", "message": "Admin role required" }`
  (matching the existing resolver's contract)

#### Scenario: limit=500 is clamped to 100

- WHEN `GET /api/research-brain/graph/compounds/search?q=x&limit=500`
  is called
- THEN the response is HTTP 200
- AND the body's `limit` field is `100`
- AND the `compounds` array has at most 100 entries

#### Scenario: Limit defaults to 20

- WHEN the endpoint is called with `q=x` and no `limit`
- THEN the response is HTTP 200
- AND the body's `limit` field is `20`

### Requirement: Post-Extraction Soft-Fail Refresh Hook

The system MUST call `refreshAggregates()` from
`bioprospectingExtractor.ts` immediately after a successful
`replaceBioprospectingFactsForSource` call, and the call MUST be
soft-fail: any thrown error MUST be caught and logged as a
warning. The extraction batch MUST NOT be aborted on a refresh
failure.

**Hook placement:**

- The hook sits at the end of the existing extraction flow
  in `bioprospectingExtractor.ts`, after the
  `replaceBioprospectingFactsForSource(source, stampedFacts, chunks)`
  call resolves successfully.
- The hook sits in the same try/catch boundary as the existing
  soft-fail around `attachCompoundAuthority` (see
  `src/services/researchBrain/bioprospectingExtractor.ts:462-473`)
  so the surrounding code structure is unchanged.

**Hook shape:**

```typescript
// Soft-fail refresh. Never aborts extraction.
try {
  await refreshAggregates();
} catch (err) {
  logger?.warn(
    { err, sourceId: source.id },
    "graph_compound_aggregates_refresh_failed_soft_fail",
  );
}
```

**Contract:**

- The hook MUST call `graphService.refreshAggregates()` (not
  the SQL function directly). The service function is
  responsible for issuing the RPC and absorbing any DB error.
- The hook MUST NOT re-throw. Any error that escapes
  `refreshAggregates()` is a logic bug; the `try/catch` is
  the safety net.
- The hook MUST log a structured warning that includes
  `sourceId` and the error. The log message is the agreed
  `graph_compound_aggregates_refresh_failed_soft_fail` event
  name; observability and alerting tools MUST be able to
  pattern-match on this name.
- The hook MUST NOT change the return value of the
  surrounding extraction call. The function still returns
  the saved-fact list and the table/chunk counts as before.
- The hook MUST NOT block the worker queue. If a future
  change observes the refresh slowing the worker, the
  hook is the place to move the call to a fire-and-forget
  `queue.enqueue` — the contract is "soft-fail, never block".

**Backfill strategy:**

- For sources ingested BEFORE this change ships, the
  migration's initial non-concurrent
  `REFRESH MATERIALIZED VIEW` populates the view from the
  full facts table at deploy time. This is sufficient for v1.
- A manual `SELECT public.refresh_compound_aggregates();` (or
  the non-concurrent `REFRESH MATERIALIZED VIEW
  public.research_graph_compound_aggregates;` as a fallback)
  is the documented backfill command for incident response
  when the soft-fail hook has been warning for a window.
- No scheduled job is required in v1: the migration's
  initial populate + the post-extraction hook cover the v1
  freshness contract.

#### Scenario: Successful extraction refreshes the view

- GIVEN a source S whose extraction produces 12 new facts
  across 3 compounds (C1, C2, C3) — all three are already
  in the canonical table
- WHEN the extraction runs to completion
- THEN `replaceBioprospectingFactsForSource` returns
  successfully
- AND the post-extraction hook calls
  `refreshAggregates()` once
- AND the materialized view's `fact_count`,
  `source_count`, `claim_count`, `last_seen_at`, and
  `first_seen_at` reflect the new facts for C1, C2, C3
  on the next read

#### Scenario: Refresh failure logs a warning and extraction succeeds

- GIVEN the `refresh_compound_aggregates()` RPC is mocked
  to reject with a transient error
- WHEN the extraction runs to completion
- THEN the post-extraction hook catches the error
- AND a `graph_compound_aggregates_refresh_failed_soft_fail`
  warning is logged with `sourceId`
- AND the extraction function still returns the saved-fact
  list to the caller
- AND the surrounding worker batch is not aborted

#### Scenario: Migration initial populate is the backfill

- GIVEN a database with 10,000 facts and 50 canonical
  compounds at the moment the migration runs
- WHEN the migration lands
- THEN the non-concurrent
  `REFRESH MATERIALIZED VIEW public.research_graph_compound_aggregates;`
  step populates the view with 50 rows
- AND the view is queryable immediately after the
  migration completes
- AND no manual backfill is required

#### Scenario: Manual backfill command is documented

- GIVEN an operator who observes a streak of
  `graph_compound_aggregates_refresh_failed_soft_fail`
  warnings in the logs
- WHEN the operator runs
  `SELECT public.refresh_compound_aggregates();` from
  the Supabase SQL editor
- THEN the view is refreshed against the current
  `research_bioprospecting_facts` state
- AND subsequent reads of the view return up-to-date
  aggregates

## Out of Scope (v1)

The following items are explicitly NOT part of v1 and are tracked
as follow-up changes:

- **`research_graph_entity_mentions` table** — turns free-text
  `bioactivity` / `application_area` / `assay_model` into typed
  edges. v1 reads these as plain strings via
  `getTopBioactivities` and `getTopGeographies`.
- **`research_graph_target_terms` / `research_graph_application_terms`
  curated registries** — controlled vocabularies for entity
  normalization. v1 uses raw string grouping.
- **`research_graph_compound_co_occurrences` table** — a
  precomputed materialization of the co-occurrence CTE in
  `getTopCoOccurring`. Promoted from query-time CTE to a
  table in v3 if the v1 CTE is hot under load; the API
  contract does not change.
- **`graphLinkerAgent`** — the LLM-driven fact↔fact and
  claim↔claim edge extractor. v2/v3 work.
- **Discovery persistence** — promoting the `Discovery`
  JSONB blob to a first-class entity. Separate change.
- **`react-flow` graph visualisation** — the UI graph
  explorer. The v1 deliverable is the JSON endpoint; a UI
  list view in `client/src/components/EvidencePack.tsx` is
  optional and best-effort, not a blocker.
- **Widening `authResolver` to support a `researcher`
  role** — the route gates on `admin` because the resolver
  only enforces `admin` today. When the resolver is widened
  in a follow-up, the route can switch to
  `role: 'researcher'` (or accept both) without a contract
  change. The proposal does NOT add a new role-check
  branch to the resolver.
