# Spec: bioprospecting-entity-graph

## Purpose

Ship KG v2 (PR2): a **read-only, LLM-free entity mention graph** over the
three free-text entity columns on `research_bioprospecting_facts` —
`bioactivity`, `application_area`, `assay_model`. v1 made **compounds**
consultable nodes; this change makes those three **entity kinds**
consultable too, answering "list the bioactivities we know about" and
"expand this application_area to its compounds / facts / sources."

The capability is purely additive and LLM-free. It ships **Approach A +
light query-time normalization**: live SQL views over the existing
columns (always fresh, no materialized view, no refresh hook) plus a
deterministic (non-LLM) SQL normalizer so obvious spelling variants
collapse to one node (`antifungal` = `anti-fungal` = `Antifungal`). No
write-path change: the extractor and `replaceBioprospectingFactsForSource`
are untouched, and no existing table or column is modified. The JSON
contract is keyed by `{ kind, value, display }` so a future Approach-B
canonical registry can add an `entity_id` without breaking consumers.

This is PR2 and PR2 only. Approach-B canonical registry tables, the PR3
LLM linker, co-occurrence materialization, and additional entity kinds
are explicitly out of scope (see the final section).

## ADDED Requirements

### Requirement: graph_normalize_entity Deterministic Normalization Function

The system MUST create a pure, deterministic, LLM-free SQL function
`public.graph_normalize_entity(text)` that maps a raw free-text entity
value to a normalized key used for grouping and matching. The function
MUST be `IMMUTABLE` (same input → same output, no external state) so the
planner can use it in views and indexed expressions, and it MUST NOT
mutate any row — normalization happens at read/query time only; the
original free-text values in `research_bioprospecting_facts` are never
rewritten.

**Signature:**

```sql
CREATE OR REPLACE FUNCTION public.graph_normalize_entity(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(
    -- 5) conservative singularization: strip a single trailing 's'
    --    only when the remaining stem is at least 3 chars and does not
    --    already end in 's' (avoids gutting short words / possessives).
    regexp_replace(
      -- 4) collapse internal whitespace runs to a single space
      regexp_replace(
        -- 3) strip hyphens (join hyphenated variants)
        replace(
          -- 2) trim leading/trailing whitespace
          btrim(
            -- 1) lowercase
            lower(coalesce(p_value, ''))
          ),
          '-', ''
        ),
        '\s+', ' ', 'g'
      ),
      '([a-z]{3,}[^s])s$', '\1', 'g'
    ),
    ''
  );
$$;
```

**Normalization contract (applied in order):**

1. **Lowercase** the input.
2. **Trim** leading and trailing whitespace.
3. **Strip hyphens** so hyphenated variants join (`anti-fungal` →
   `antifungal`).
4. **Collapse internal whitespace** runs to a single space
   (`anti  tumoral` → `anti tumoral`).
5. **Conservative singularization** — strip a single trailing `s` only
   when the stem is long enough that pluralization is the likely cause.
   This step MUST stay conservative: it MUST NOT collapse semantically
   distinct concepts, and any contested collapse is deferred to
   Approach B.

The function MUST return `NULL` (via `NULLIF(..., '')`) for input that is
`NULL`, empty, or whitespace-only, so blank entity values never produce a
node.

**Normalization examples (before → after) — MUST hold:**

| Raw input        | `graph_normalize_entity` output |
| ---------------- | ------------------------------- |
| `antifungal`     | `antifungal`                    |
| `anti-fungal`    | `antifungal`                    |
| `Antifungal`     | `antifungal`                    |
| `  Antifungal  ` | `antifungal`                    |
| `Anti-Fungals`   | `antifungal`                    |
| `cytotoxic`      | `cytotoxic`                     |
| `anti-tumoral`   | `antitumoral`                   |
| `NULL` / `''`    | `NULL`                          |

The last three rows prove the normalizer is **conservative**:
`cytotoxic` and `anti-tumoral` (a real synonym pair in oncology) MUST
remain two distinct nodes because collapsing them requires a synonym
dictionary, which is Approach-B (MeSH-grade) work explicitly out of
scope here.

#### Scenario: Case, hyphen, and whitespace variants collapse to one key

- GIVEN four facts whose `bioactivity` raw values are `antifungal`,
  `anti-fungal`, `Antifungal`, and `  Antifungal  `
- WHEN each value is passed through `graph_normalize_entity`
- THEN all four return the identical normalized key `antifungal`
- AND a `GROUP BY graph_normalize_entity(bioactivity)` over the four
  facts yields exactly one group

#### Scenario: Conservative singularization collapses a plural variant

- GIVEN two facts with `bioactivity` raw values `Anti-Fungals` and
  `antifungal`
- WHEN each value is normalized
- THEN both return `antifungal`
- AND they group into a single node

#### Scenario: Distinct concepts are NOT collapsed

- GIVEN two facts with `bioactivity` raw values `cytotoxic` and
  `anti-tumoral`
- WHEN each value is normalized
- THEN the results are `cytotoxic` and `antitumoral` respectively
- AND they remain two distinct nodes (the normalizer does not apply
  synonym resolution)

#### Scenario: Blank and NULL values produce no node

- GIVEN facts whose `bioactivity` is `NULL`, `''`, or `'   '`
- WHEN each value is normalized
- THEN each returns `NULL`
- AND `NULL` normalized keys are excluded from any entity view and never
  appear as a node

### Requirement: Entity Kind Allowlist (Exactly Three Kinds)

The capability MUST expose exactly three entity kinds, mapped 1:1 to the
existing free-text columns on `research_bioprospecting_facts`:
`bioactivity`, `application_area`, and `assay_model`. The `:kind` path
segment on every endpoint MUST be validated against this fixed allowlist
before any database access. `:kind` MUST NEVER be interpolated into SQL;
any dynamic-SQL RPC that resolves a kind to a column MUST use an
allowlist + `format('%I', ...)` identifier binding (mirroring the
existing `graph_top_string_field` RPC pattern), never string
concatenation.

An unknown or unsupported `:kind` MUST be rejected with **HTTP 400** and
body `{ "error": "unknown entity kind", "allowed": ["bioactivity", "application_area", "assay_model"] }`,
and MUST NOT execute any database query.

#### Scenario: Each of the three kinds is accepted

- GIVEN an authenticated caller
- WHEN the search endpoint is called with `:kind` equal to `bioactivity`,
  then `application_area`, then `assay_model`
- THEN each call returns HTTP 200 with a valid entity result body

#### Scenario: Unknown kind is rejected before any DB access

- GIVEN an authenticated caller
- WHEN the search endpoint is called with `:kind = geography` (a
  deferred/out-of-scope kind) or any other value not in the allowlist
- THEN the response is HTTP 400 with body
  `{ "error": "unknown entity kind", "allowed": ["bioactivity", "application_area", "assay_model"] }`
- AND no database query is executed

#### Scenario: Kind is never interpolated into SQL

- GIVEN any request reaching the dynamic-SQL layer
- WHEN the kind is resolved to a physical column name
- THEN the resolution goes through the fixed allowlist and
  `format('%I', ...)` binding
- AND a `:kind` value crafted to inject SQL cannot reach the query
  because it is rejected by the allowlist first

### Requirement: Live Entity Read View(s) Over the Free-Text Columns

The system MUST derive entity nodes from the three free-text columns using
**live SQL views** (NOT a materialized view), so the entity graph is
always fresh, auto-covers the current corpus with no refresh hook, and
the change stays truly additive. A materialized-view + scheduled-refresh
promotion is a deferred performance optimization that MUST NOT change this
JSON contract.

Each entity node is keyed by `{ kind, value }` where `value` is
`graph_normalize_entity(<column>)`, with the following per-node
aggregates computed over `research_bioprospecting_facts`:

- `compound_count` = `COUNT(DISTINCT compound_canonical_id)` — distinct
  compounds linked to the normalized value.
- `fact_count` = `COUNT(DISTINCT id)` — distinct facts carrying the
  normalized value.
- `source_count` = `COUNT(DISTINCT source_id)` — distinct source
  documents carrying the normalized value.
- `display` = a representative raw form for the normalized key,
  chosen deterministically as the **most frequent raw value** for that
  normalized key (ties broken deterministically, e.g. lexicographically),
  preserved for UI presentation.

Facts whose normalized value is `NULL` (blank/whitespace-only raw values)
MUST be excluded from the node set. The view MUST `GROUP BY` the
normalized value per kind; it MUST NOT mutate any row.

**View shape (illustrative — a single UNION view keyed by `kind`, or one
view per kind):**

```sql
CREATE OR REPLACE VIEW public.research_graph_entity_nodes AS
SELECT
  'bioactivity'::text                            AS kind,
  public.graph_normalize_entity(f.bioactivity)   AS value,
  mode() WITHIN GROUP (ORDER BY f.bioactivity)   AS display,
  COUNT(DISTINCT f.compound_canonical_id)        AS compound_count,
  COUNT(DISTINCT f.id)                            AS fact_count,
  COUNT(DISTINCT f.source_id)                     AS source_count
FROM public.research_bioprospecting_facts f
WHERE public.graph_normalize_entity(f.bioactivity) IS NOT NULL
GROUP BY 1, 2
UNION ALL
SELECT
  'application_area'::text,
  public.graph_normalize_entity(f.application_area),
  mode() WITHIN GROUP (ORDER BY f.application_area),
  COUNT(DISTINCT f.compound_canonical_id),
  COUNT(DISTINCT f.id),
  COUNT(DISTINCT f.source_id)
FROM public.research_bioprospecting_facts f
WHERE public.graph_normalize_entity(f.application_area) IS NOT NULL
GROUP BY 1, 2
UNION ALL
SELECT
  'assay_model'::text,
  public.graph_normalize_entity(f.assay_model),
  mode() WITHIN GROUP (ORDER BY f.assay_model),
  COUNT(DISTINCT f.compound_canonical_id),
  COUNT(DISTINCT f.id),
  COUNT(DISTINCT f.source_id)
FROM public.research_bioprospecting_facts f
WHERE public.graph_normalize_entity(f.assay_model) IS NOT NULL
GROUP BY 1, 2;
```

The view MUST be a plain `VIEW` (not `MATERIALIZED`) so no `REFRESH` step,
no refresh hook, and no unique index are required, and so new facts are
reflected on the very next read.

#### Scenario: View exposes one node per distinct normalized value

- GIVEN a facts table where `bioactivity` has raw values `antifungal`,
  `anti-fungal`, `Antifungal` (3 rows, 2 compounds, 2 sources) plus
  `cytotoxic` (1 row, 1 compound, 1 source)
- WHEN the entity view is read for `kind = bioactivity`
- THEN it returns exactly two nodes: `antifungal` and `cytotoxic`
- AND the `antifungal` node has `fact_count = 3`,
  `compound_count = 2`, `source_count = 2`
- AND its `display` is a raw form present in the corpus for that key

#### Scenario: View is always fresh (no refresh needed)

- GIVEN the entity view already returns node `antifungal` with
  `fact_count = 3`
- WHEN a new fact with `bioactivity = 'Antifungal'` is inserted into
  `research_bioprospecting_facts`
- WHEN the entity view is read again with no refresh step
- THEN the `antifungal` node reflects `fact_count = 4`

#### Scenario: Counts are DISTINCT, not row counts

- GIVEN one compound cited in two facts from the same source, both with
  `bioactivity = 'antifungal'`
- WHEN the `antifungal` node is read
- THEN `compound_count = 1`, `source_count = 1`, `fact_count = 2`

#### Scenario: Blank values contribute no node

- GIVEN facts whose `assay_model` is `NULL` or empty
- WHEN the entity view is read for `kind = assay_model`
- THEN no node exists for those blank values

### Requirement: Entity Expand RPC (1-Hop Over Facts)

The system MUST expose an on-the-fly, read-only RPC that, given a kind and
a normalized `value`, returns the 1-hop neighborhood: the distinct
compounds, facts, and sources whose `graph_normalize_entity(<column>)`
equals the requested value. There MUST be no precomputed edge table; the
RPC filters `research_bioprospecting_facts` at query time. The RPC MUST
resolve the kind-to-column mapping through the fixed allowlist +
`format('%I', ...)` binding, and MUST bind `value` as a parameter (never
interpolated).

When the value has no matching facts, the RPC MUST return an **empty
result** (empty compound / fact / source collections), NOT an error.

#### Scenario: Expand returns linked compounds, facts, and sources

- GIVEN `kind = bioactivity` and normalized `value = antifungal` matching
  3 facts across 2 compounds and 2 sources
- WHEN the expand RPC is called
- THEN it returns those 2 distinct compounds, 3 facts, and 2 sources
- AND every returned fact's `graph_normalize_entity(bioactivity)` equals
  `antifungal`

#### Scenario: Expand on an unknown value returns empty, not an error

- GIVEN `kind = bioactivity` and `value = nonexistententity`
- WHEN the expand RPC is called
- THEN it returns an empty result (no compounds, facts, or sources)
- AND it does NOT raise an error

### Requirement: graphService Entity Read Helpers

The system MUST add two read-only helpers to
`src/services/researchBrain/graphService.ts` — `searchEntities` and
`expandEntity` — reusing the existing module's service-role Supabase
client (the TDZ-guard Proxy) and `clampLimit` guard. Neither helper MUST
insert, update, or delete any row.

**Exported types and signatures (illustrative):**

```typescript
export type EntityKind = "bioactivity" | "application_area" | "assay_model";

export type EntityNode = {
  kind: EntityKind;
  value: string;        // normalized key
  display: string;      // representative raw form
  compound_count: number;
  fact_count: number;
  source_count: number;
  // entity_id?: string; // reserved for a future Approach-B canonical id
};

export type SearchEntitiesParams = {
  kind: EntityKind;
  query?: string;       // optional substring filter over the normalized value
  limit?: number;       // default 20, max 100 (silently clamped)
};

export type ExpandEntityResult = {
  kind: EntityKind;
  value: string;
  display: string;
  compounds: Array<{ compound_id: string; canonical_name: string; fact_count: number }>;
  facts: Array<{ id: string; source_id: string; compound_canonical_id: string | null }>;
  sources: Array<{ source_id: string; fact_count: number }>;
};

export async function searchEntities(
  params: SearchEntitiesParams,
): Promise<EntityNode[]>;

export async function expandEntity(
  kind: EntityKind,
  value: string,
  limit?: number,       // default 20, max 100 (silently clamped)
): Promise<ExpandEntityResult>;
```

**Behavior:**

- `searchEntities` MUST read the live entity view filtered by `kind`,
  return one `EntityNode` per distinct normalized value, and apply the
  optional `query` as a substring filter over the normalized `value`.
  Default `limit` is 20, max 100 (silently clamped, never throws). Results
  SHOULD be ordered by a stable, meaningful default (e.g. `fact_count`
  descending, then `value` ascending).
- `expandEntity` MUST call the expand RPC with the normalized `value`
  bound as a parameter and return the 1-hop neighborhood. It MUST return
  an empty (but well-formed) `ExpandEntityResult` when the value has no
  matches — it MUST NOT throw for a no-match.
- Both helpers MUST validate `kind` against the three-kind allowlist and
  MUST NOT interpolate `kind` or `value` into SQL.

#### Scenario: searchEntities returns normalized nodes with counts

- GIVEN a populated facts table
- WHEN `searchEntities({ kind: "bioactivity", limit: 5 })` runs
- THEN it returns at most 5 `EntityNode` objects
- AND each has `kind`, `value`, `display`, `compound_count`,
  `fact_count`, `source_count`

#### Scenario: searchEntities applies the query filter over normalized value

- GIVEN nodes `antifungal`, `antibacterial`, and `cytotoxic` for
  `bioactivity`
- WHEN `searchEntities({ kind: "bioactivity", query: "anti" })` runs
- THEN the result includes `antifungal` and `antibacterial`
- AND excludes `cytotoxic`

#### Scenario: expandEntity on a no-match value resolves empty

- WHEN `expandEntity("assay_model", "nonexistent")` runs
- THEN it resolves to an `ExpandEntityResult` with empty `compounds`,
  `facts`, and `sources` arrays
- AND it does not reject

### Requirement: Search Endpoint GET /api/research-brain/graph/entities/:kind/search

The system MUST expose `GET /api/research-brain/graph/entities/:kind/search`
in `src/routes/research-brain-graph.ts`, reusing the same
`authResolver({ required: true })` gate already applied to
`/graph/compounds/search` in the same file — authentication required, NO
role restriction, so any authenticated caller (read-only) can read it.
The endpoint returns the distinct normalized entity nodes for the given
kind.

**Endpoint contract:**

- `GET /api/research-brain/graph/entities/:kind/search`
- Path parameter `:kind` — MUST be one of `bioactivity`,
  `application_area`, `assay_model` (see the allowlist requirement).
- Query parameters:
  - `q` (optional, string) — substring filter over the normalized value.
    When absent, all nodes for the kind (up to `limit`) are returned.
  - `limit` (optional, integer) — page size. Default 20, max 100.
    Out-of-range values are clamped silently.
- Authentication: `authResolver({ required: true })` — any authenticated
  caller (read-only), identical to `/graph/compounds/search`. 401 when no
  auth context. NO role restriction (no 403 for non-admin callers).
- Response: HTTP 200 with body:

```json
{
  "kind": "bioactivity",
  "query": "anti",
  "limit": 20,
  "entities": [
    {
      "kind": "bioactivity",
      "value": "antifungal",
      "display": "Antifungal",
      "compound_count": 2,
      "fact_count": 3,
      "source_count": 2
    }
  ]
}
```

- Error responses:
  - 400 `{ "error": "unknown entity kind", "allowed": [...] }` on a
    `:kind` not in the allowlist.
  - 401 on no auth (per the resolver's contract).
  - 500 `{ "error": "internal_error" }` on DB error (the service role's
    error message MUST NOT leak into the response body).

#### Scenario: Search returns normalized entity nodes for a kind

- GIVEN an authenticated caller and a populated facts table
- WHEN `GET /api/research-brain/graph/entities/bioactivity/search?q=anti`
  is called
- THEN the response is HTTP 200
- AND `entities` contains one node per distinct normalized value
  matching `anti`, each with `value`, `display`, `compound_count`,
  `fact_count`, `source_count`
- AND `antifungal`, `anti-fungal`, and `Antifungal` appear as a single
  `antifungal` node

#### Scenario: Unknown kind returns 400

- WHEN `GET /api/research-brain/graph/entities/geography/search` is called
  by an authenticated caller
- THEN the response is HTTP 400 with body
  `{ "error": "unknown entity kind", "allowed": ["bioactivity", "application_area", "assay_model"] }`

#### Scenario: limit is clamped and defaults to 20

- WHEN the endpoint is called with `limit=500`
- THEN the response is HTTP 200 and `limit` in the body is `100`
- WHEN the endpoint is called with no `limit`
- THEN `limit` in the body is `20`

### Requirement: Expand Endpoint GET /api/research-brain/graph/entities/:kind/:value/expand

The system MUST expose
`GET /api/research-brain/graph/entities/:kind/:value/expand` in
`src/routes/research-brain-graph.ts`, gated identically to the other
read-only graph endpoints (`authResolver({ required: true })` — any
authenticated caller, read-only). The endpoint returns the 1-hop neighborhood
(compounds / facts / sources) for a single normalized entity value.

**Endpoint contract:**

- `GET /api/research-brain/graph/entities/:kind/:value/expand`
- Path parameters:
  - `:kind` — validated against the three-kind allowlist (400 otherwise).
  - `:value` — the normalized entity value. It MUST be bound as a
    parameter in the underlying RPC, NEVER interpolated into SQL. The
    endpoint MAY re-run `graph_normalize_entity` on the incoming `:value`
    so a caller passing a raw form (`Anti-Fungal`) resolves to the same
    node as the normalized form (`antifungal`).
- Query parameter `limit` (optional, integer) — cap on returned rows per
  collection. Default 20, max 100, clamped silently.
- Authentication: `authResolver({ required: true })` — any authenticated
  caller (read-only). 401 when no auth context; no role restriction.
- Response: HTTP 200 with body:

```json
{
  "kind": "bioactivity",
  "value": "antifungal",
  "display": "Antifungal",
  "compounds": [
    { "compound_id": "uuid", "canonical_name": "Quercetin", "fact_count": 2 }
  ],
  "facts": [
    { "id": "uuid", "source_id": "uuid", "compound_canonical_id": "uuid" }
  ],
  "sources": [
    { "source_id": "uuid", "fact_count": 2 }
  ]
}
```

- Behavior on a value with no matching facts: HTTP 200 with empty
  `compounds`, `facts`, and `sources` arrays — NOT a 404 and NOT a 500.
- Error responses: 400 unknown kind, 401 no auth, 500 DB error
  (`{ "error": "internal_error" }`, no leaked detail).

#### Scenario: Expand returns the 1-hop neighborhood

- GIVEN an authenticated caller and `bioactivity` node `antifungal` linked to 2
  compounds, 3 facts, 2 sources
- WHEN `GET /api/research-brain/graph/entities/bioactivity/antifungal/expand`
  is called
- THEN the response is HTTP 200
- AND `compounds` has the 2 distinct compounds, `facts` the 3 facts,
  `sources` the 2 sources

#### Scenario: Expand accepts a raw variant and resolves the same node

- GIVEN the `antifungal` node above
- WHEN the endpoint is called with `:value = Anti-Fungal`
- THEN it resolves to the same normalized node `antifungal`
- AND returns the same neighborhood

#### Scenario: Expand on a value with no matches returns 200 empty

- GIVEN an authenticated caller
- WHEN `GET /api/research-brain/graph/entities/bioactivity/nonexistent/expand`
  is called
- THEN the response is HTTP 200
- AND `compounds`, `facts`, and `sources` are all empty arrays
- AND no error is returned

### Requirement: Authentication Gate (Any Authenticated Caller, Read-Only)

Both entity read endpoints —
`GET /api/research-brain/graph/entities/:kind/search` and
`GET /api/research-brain/graph/entities/:kind/:value/expand` — MUST be
gated by `authResolver({ required: true })`: authentication required, NO
role restriction, so **any authenticated caller (read-only)** — a valid
JWT of any role, an x402/b402 payment proof, or an api-key — can read
them. This is what lets the `/graph` explorer page serve all whitelisted
users, not just admins.

The endpoints MUST return HTTP 401 when the caller has no auth context,
before executing any database query. An admin caller MUST continue to
succeed. Both endpoints MUST remain READ-ONLY (no insert, update, or
delete) and LLM-free — the relaxed gate changes ONLY who may call them,
never the response contract or the query behavior. This requirement MUST
NOT widen `authResolver` to add a new role branch, and MUST NOT relax any
endpoint outside these two.

(History: both endpoints originally shipped with
`authResolver({ required: true, role: "admin" })` and returned HTTP 403
for authenticated non-admin callers. The `graph-explorer-page` change
dropped the role gate on these two read-only GETs.)

#### Scenario: Unauthenticated request returns 401

- GIVEN no auth header is sent
- WHEN either entity endpoint is called
- THEN the response is HTTP 401
- AND no database query is executed

#### Scenario: Non-admin authenticated request succeeds

- GIVEN a JWT-authenticated caller whose role is NOT `admin`
- WHEN either entity endpoint is called with valid parameters
- THEN the response is HTTP 200 with the normal entity/expand body
- AND no 403 is returned

#### Scenario: Admin request still succeeds

- GIVEN a JWT-authenticated caller whose role is `admin`
- WHEN either entity endpoint is called with valid parameters
- THEN the response is HTTP 200 with the normal entity/expand body

#### Scenario: Endpoints remain read-only

- GIVEN the relaxed gating on the two entity endpoints
- WHEN either endpoint handles a request
- THEN it performs only read queries
- AND it never inserts, updates, or deletes any row

### Requirement: Additive-Only Guarantee (No Write-Path or Schema Change)

The change MUST be purely additive. It MUST NOT modify, drop, or add a
column to any existing table — specifically not
`research_bioprospecting_facts`, `research_bioprospecting_claims`,
`research_compounds`, or `research_sources`. It MUST NOT alter the
extractor or `replaceBioprospectingFactsForSource`, MUST NOT add a new
extractor pass, and MUST NOT introduce any write path or refresh hook. The
entire surface (function, views, RPC, service helpers, endpoints) is
read-only and LLM-free. The migration MUST be idempotent (`CREATE OR
REPLACE` / `IF NOT EXISTS`) and self-contained (no dependency on a later
migration), and MUST `GRANT EXECUTE`/`GRANT SELECT` to
`anon, authenticated, service_role` mirroring the v1 graph migration.

#### Scenario: No existing table is modified

- GIVEN the migration for this change
- WHEN it is inspected
- THEN it contains no `ALTER TABLE`, `DROP`, or column addition against
  `research_bioprospecting_facts`, `research_bioprospecting_claims`,
  `research_compounds`, or `research_sources`
- AND it only creates the normalizer function, the entity view(s), the
  expand RPC, and the associated GRANTs

#### Scenario: Extractor is unchanged and no refresh hook is added

- GIVEN `src/services/researchBrain/bioprospectingExtractor.ts`
- WHEN the change is applied
- THEN the extractor file is untouched
- AND no refresh call is added anywhere (the views are live, not
  materialized)

#### Scenario: Re-running the migration is a no-op

- GIVEN the migration has already been applied
- WHEN it runs again
- THEN no error is raised and no duplicate object is created

### Requirement: API Stability for a Future Approach-B Canonical Backing

Every entity node and expand response MUST be keyed by
`{ kind, value, display }` where `value` is the normalized key. This
contract MUST allow a future Approach-B canonical registry to add an
optional `entity_id` (and any canonical metadata) as a purely additive
field — existing consumers reading `kind` / `value` / `display` / counts
MUST continue to work unchanged when `entity_id` is later introduced. The
current change MUST NOT add `entity_id` (it belongs to the deferred
Approach-B change), but MUST NOT structure the response in a way that
would require a breaking change to add it.

#### Scenario: Response is keyed by kind + value + display

- WHEN either entity endpoint returns a node
- THEN the node carries `kind`, `value` (normalized), and `display`
  (raw representative), plus the distinct counts
- AND no field is required that would block adding an optional
  `entity_id` later

#### Scenario: Adding entity_id later is non-breaking

- GIVEN a future Approach-B change that adds an optional `entity_id` to
  each node
- WHEN an existing consumer that reads only `{ kind, value, display }`
  and counts processes the new response
- THEN it continues to work without modification (the new field is
  ignored)

## Out of Scope (PR2)

The following are explicitly NOT part of this change and are tracked as
follow-up changes:

- **Approach B — canonical registry** — `research_graph_target_terms` /
  `research_graph_application_terms`, typed
  `research_graph_entity_mentions`, write-path resolution, backfill
  scripts, and full MeSH-grade synonym canonicalization (e.g.
  `cytotoxic ≈ anti-tumoral`). This change uses raw normalized-string
  grouping only.
- **PR3 — LLM linker** — the `graphLinkerAgent` fact↔fact / claim↔claim
  semantic linker. Feature-flagged, cost-guarded, separate change.
- **Co-occurrence materialization** — no `co_occurrences` table; the v1
  `graph_top_co_occurring` RPC already answers it on the fly.
- **Additional entity kinds** — `geography`, `ecosystem`,
  `organism_part`, `compound_class`, `molecule_type`, `evidence_type`.
  Only the three kinds above ship here.
- **Materialized entity view + refresh** — a perf optimization that would
  swap the live views for a matview + scheduled refresh WITHOUT changing
  this JSON contract. Deferred until measured hot.
- **Any write-path change** — the extractor and
  `replaceBioprospectingFactsForSource` remain untouched.
