# Design: knowledge-graph-entity-graph (KG v2 — entity mention graph, LLM-free)

## Overview

KG v2 (PR2) makes the three free-text columns on
`research_bioprospecting_facts` — `bioactivity`, `application_area`,
`assay_model` — consultable as **entity nodes**, mirroring how v1 made
`research_compounds` consultable. The whole surface is **read-only,
LLM-free, and additive**: no write path changes, no schema mutation of
existing tables, no new extractor pass.

Unlike v1 (which used a materialized view + a post-extraction refresh
hook), v2 ships **live SQL objects only**: one live view, one immutable
normalizer function, and two allowlisted RPCs. There is **no matview and
no refresh hook** — the view is always fresh by construction. This is a
locked decision: the deferred perf optimization (promote to matview) can
land later without touching the JSON contract.

This document resolves the design questions the proposal flagged,
reuses the `format('%I')` allowlist technique from v1's
`graph_top_string_field`, and pins the contract for `sdd-tasks` /
`sdd-apply`.

## Architecture at a glance

```
┌───────────────────────────────────────────────────────────────────┐
│  HTTP read path (admin-gated)                                     │
│                                                                    │
│  GET /api/research-brain/graph/entities/:kind/search              │
│  GET /api/research-brain/graph/entities/:kind/:value/expand       │
│  ┌────────────────────────┐                                       │
│  │ authResolver(role:     │  ← admin gate (same as v1)            │
│  │   'admin')             │                                       │
│  └──────────┬─────────────┘                                       │
│             ▼                                                     │
│  ┌────────────────────────┐                                       │
│  │ graphService.          │  ← NEW read-only helpers              │
│  │   searchEntities()     │  .rpc('graph_entity_search')          │
│  │   expandEntity()       │  .rpc('graph_entity_expand')          │
│  └──────────┬─────────────┘                                       │
│             ▼                                                     │
└─────────────┼──────────────────────────────────────────────────────┘
              │
   ┌──────────┴───────────────────────────────────────────────────┐
   │  SQL layer (all LIVE — no matview, no refresh)               │
   │                                                              │
   │  graph_entity_search(kind, query, limit)  ── STABLE RPC ──┐   │
   │      allowlist-validates :kind                            │   │
   │      reads the live UNION view, ILIKE on normalized value │   │
   │             │                                             │   │
   │             ▼                                             │   │
   │  ┌──────────────────────────────────────┐                │   │
   │  │ VIEW research_graph_entities         │  ← always fresh │   │
   │  │  UNION ALL of the 3 kinds, GROUP BY  │                │   │
   │  │  graph_normalize_entity(col)         │                │   │
   │  │  → (kind, value, display, counts)    │                │   │
   │  └──────────────┬───────────────────────┘                │   │
   │                 │ calls                                   │   │
   │                 ▼                                         │   │
   │  ┌──────────────────────────────────────┐                │   │
   │  │ FUNCTION graph_normalize_entity(text)│  ← IMMUTABLE    │   │
   │  │  lower·trim·collapse-ws·strip-hyphen │    (single      │   │
   │  │  ·conservative-singularize           │     source of   │   │
   │  └──────────────▲───────────────────────┘     truth)     │   │
   │                 │ SAME function on SAME column           │   │
   │  graph_entity_expand(kind, value, limit) ── STABLE RPC ──┘   │
   │      allowlist-validates :kind, maps kind→column via %I       │
   │      filters facts WHERE graph_normalize_entity(col) = value  │
   │      returns jsonb { compounds, facts, sources }              │
   └───────────────────────────────────────────────────────────────┘
```

## File map

| Path | Status | Purpose |
|---|---|---|
| `supabase/migrations/20260711000000_graph_entity_views.sql` | New | `graph_normalize_entity()` fn + `research_graph_entities` view + `graph_entity_search()` / `graph_entity_expand()` RPCs + expression indexes + GRANTs |
| `src/services/researchBrain/graphService.ts` | Modified | Add `searchEntities`, `expandEntity` read-only helpers + types |
| `src/routes/research-brain-graph.ts` | Modified | Add `/graph/entities/:kind/search` + `/graph/entities/:kind/:value/expand` |
| `src/services/researchBrain/bioprospectingExtractor.ts` | Untouched | No write-path change (LLM-free, additive) |
| `openspec/specs/bioprospecting-entity-graph/spec.md` | New | Spec written by `sdd-spec` |

Single migration (unlike v1's three) because v2 has no matview /
refresh split — the view, normalizer, and two RPCs form one atomic,
rollback-in-one-block unit.

## The correctness-critical invariant (read this first)

> **Search grouping and expand lookup MUST apply the *same*
> `graph_normalize_entity()` to the *same* raw column.**

- The `research_graph_entities` view computes each node's key as
  `value = graph_normalize_entity(<col>)` and groups by it.
- `graph_entity_expand()` filters facts with
  `WHERE graph_normalize_entity(<col>) = p_value`.

Because both sides call the identical immutable function on the
identical column, every `value` the search endpoint emits is guaranteed
to resolve to the exact same fact set on expand — no drift, no
"searched-for X but expand returns empty" class of bug. Normalization
lives **only** in SQL (`graph_normalize_entity`); the service and route
layers never re-implement or pre-normalize it. This is the single most
important property of the design and the reason normalization is a DB
function rather than TypeScript.

## Storage layer

### Migration `20260711000000_graph_entity_views.sql`

Idempotent (`OR REPLACE` / `IF NOT EXISTS`), wrapped in
`BEGIN`/`COMMIT` (mirrors `20260615030000_graph_compound_aggregates.sql`).

#### 1) `graph_normalize_entity` — pure, IMMUTABLE normalizer

```sql
-- Deterministic, LLM-free normalizer. IMMUTABLE so it can back an
-- expression index and so the planner can fold it. PARALLEL SAFE so
-- the live GROUP BY can parallelize. Steps, in order:
--   1) lower + trim
--   2) strip hyphens / unicode dashes (antifungal = anti-fungal)
--   3) collapse internal whitespace to a single space
--   4) conservative singularization: strip a trailing 's' ONLY when
--      it follows a consonant other than 's' (so 'antifungals' ->
--      'antifungal', but 'class'/'analysis'/'virus' are untouched).
CREATE OR REPLACE FUNCTION public.graph_normalize_entity(p_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(
    regexp_replace(                                        -- 4) singularize
      regexp_replace(                                      -- 3) collapse ws
        regexp_replace(                                    -- 2) strip dashes
          lower(btrim(coalesce(p_value, ''))),             -- 1) lower + trim
          '[-‐‑‒–—]', '', 'g'
        ),
        '\s+', ' ', 'g'
      ),
      '([bcdfghjklmnpqrtvwxyz])s$', '\1'
    ),
  '');
$$;
```

Notes:
- The singularization character class is *consonants except `s`*
  (includes `y`), so `assays → assay` (`y`+`s`) while `class → class`
  (`s`+`s`, preceding char is `s`, excluded). It only ever touches the
  final token's trailing `s`; this is intentionally conservative.
  Contested collapses (`cytotoxic ≈ anti-tumoral`) are explicitly **out
  of scope** and deferred to Approach B.
- `NULLIF(..., '')` makes empty/whitespace-only inputs normalize to
  `NULL`, which the view then filters out.
- `IMMUTABLE` is load-bearing: the expression indexes below cannot be
  created against a `STABLE`/`VOLATILE` function.

#### 2) `research_graph_entities` — live UNION node view

```sql
CREATE OR REPLACE VIEW public.research_graph_entities AS
WITH mentions AS (
  SELECT 'bioactivity'::text AS kind, f.bioactivity AS raw,
         f.compound_canonical_id, f.id AS fact_id, f.source_id
  FROM public.research_bioprospecting_facts f
  WHERE f.bioactivity IS NOT NULL AND btrim(f.bioactivity) <> ''
  UNION ALL
  SELECT 'application_area'::text, f.application_area,
         f.compound_canonical_id, f.id, f.source_id
  FROM public.research_bioprospecting_facts f
  WHERE f.application_area IS NOT NULL AND btrim(f.application_area) <> ''
  UNION ALL
  SELECT 'assay_model'::text, f.assay_model,
         f.compound_canonical_id, f.id, f.source_id
  FROM public.research_bioprospecting_facts f
  WHERE f.assay_model IS NOT NULL AND btrim(f.assay_model) <> ''
),
normalized AS (
  SELECT m.kind,
         public.graph_normalize_entity(m.raw) AS value,
         m.raw,
         m.compound_canonical_id, m.fact_id, m.source_id
  FROM mentions m
)
SELECT
  n.kind,
  n.value,
  mode() WITHIN GROUP (ORDER BY n.raw)       AS display,       -- most frequent raw form
  COUNT(DISTINCT n.compound_canonical_id)    AS compound_count,
  COUNT(DISTINCT n.fact_id)                  AS fact_count,
  COUNT(DISTINCT n.source_id)                AS source_count
FROM normalized n
WHERE n.value IS NOT NULL AND n.value <> ''
GROUP BY n.kind, n.value;
```

DISTINCT-count semantics (explicit):
- `compound_count = COUNT(DISTINCT compound_canonical_id)` — distinct
  canonical compounds. `NULL` FKs are dropped by `COUNT(DISTINCT)`, so
  facts with no resolved compound do not inflate the count.
- `fact_count = COUNT(DISTINCT fact_id)` — distinct facts. (Facts are
  one row each, but `DISTINCT` is used for robustness against future
  joins.)
- `source_count = COUNT(DISTINCT source_id)` — distinct source docs.
- `display = mode() WITHIN GROUP (ORDER BY raw)` — the most frequent
  original spelling for the node (ties resolve to the lexicographically
  smallest), so the UI can show `Antifungal` even though the key is
  `antifungal`.

#### 3) `graph_entity_search` — allowlisted search RPC

Search reads the pre-aggregated live view and filters by the `kind`
**literal column** (no dynamic column → zero identifier-injection
surface). The `:kind` allowlist is still enforced (raise on unknown so
the route can map it to 400). The user's raw query is passed through the
**same** `graph_normalize_entity()` before the `ILIKE`, so
`Anti-Fungal`, `antifungals`, and `antifungal` all match the one node.

```sql
CREATE OR REPLACE FUNCTION public.graph_entity_search(
  p_kind  TEXT,
  p_query TEXT,
  p_limit INTEGER
)
RETURNS TABLE (
  kind TEXT, value TEXT, display TEXT,
  compound_count BIGINT, fact_count BIGINT, source_count BIGINT
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_norm  TEXT;
  v_limit INT := greatest(1, least(coalesce(p_limit, 20), 100));
BEGIN
  IF p_kind NOT IN ('bioactivity', 'application_area', 'assay_model') THEN
    RAISE EXCEPTION 'graph_entity_search: invalid kind %', p_kind
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_norm := public.graph_normalize_entity(coalesce(p_query, ''));

  RETURN QUERY
  SELECT e.kind, e.value, e.display,
         e.compound_count, e.fact_count, e.source_count
  FROM public.research_graph_entities e
  WHERE e.kind = p_kind
    AND (
      v_norm = ''  -- empty query -> list top nodes by fact_count
      OR e.value ILIKE '%' ||
         replace(replace(v_norm, '%', '\%'), '_', '\_') || '%'
    )
  ORDER BY e.fact_count DESC, e.value ASC
  LIMIT v_limit;
END;
$$;
```

#### 4) `graph_entity_expand` — allowlisted `%I` expand RPC

Expand needs *per-fact* rows, so it must read the raw column
dynamically. This is where the v1 `format('%I')` + allowlist +
`EXECUTE ... USING` pattern is reused verbatim. Returns a single
`jsonb` payload with three arrays so one round-trip yields the whole
1-hop neighborhood.

```sql
CREATE OR REPLACE FUNCTION public.graph_entity_expand(
  p_kind  TEXT,
  p_value TEXT,      -- an ALREADY-normalized key (as emitted by search)
  p_limit INTEGER
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_col    TEXT;
  v_limit  INT := greatest(1, least(coalesce(p_limit, 20), 100));
  v_result jsonb;
BEGIN
  IF p_kind NOT IN ('bioactivity', 'application_area', 'assay_model') THEN
    RAISE EXCEPTION 'graph_entity_expand: invalid kind %', p_kind
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_col := p_kind;  -- allowlisted; quoted via %I below

  EXECUTE format($q$
    WITH matched AS (
      SELECT f.id AS fact_id, f.source_id, f.compound_canonical_id,
             f.result_summary, f.quote, f.page, f.doi
      FROM public.research_bioprospecting_facts f
      WHERE public.graph_normalize_entity(f.%1$I) = $1
    ),
    compounds AS (
      SELECT c.id, c.canonical_name,
             COUNT(DISTINCT m.fact_id) AS fact_count
      FROM matched m
      JOIN public.research_compounds c ON c.id = m.compound_canonical_id
      WHERE m.compound_canonical_id IS NOT NULL
      GROUP BY c.id, c.canonical_name
      ORDER BY fact_count DESC, c.canonical_name ASC
      LIMIT $2
    ),
    facts AS (
      SELECT m.fact_id AS id, m.source_id, m.compound_canonical_id,
             m.result_summary, m.quote, m.page, m.doi
      FROM matched m
      ORDER BY m.fact_id
      LIMIT $2
    ),
    sources AS (
      SELECT s.id, s.title, s.doi, s.url,
             COUNT(DISTINCT m.fact_id) AS fact_count
      FROM matched m
      JOIN public.research_sources s ON s.id = m.source_id
      GROUP BY s.id, s.title, s.doi, s.url
      ORDER BY fact_count DESC, s.title ASC
      LIMIT $2
    )
    SELECT jsonb_build_object(
      'compounds', COALESCE((SELECT jsonb_agg(to_jsonb(compounds)) FROM compounds), '[]'::jsonb),
      'facts',     COALESCE((SELECT jsonb_agg(to_jsonb(facts))     FROM facts),     '[]'::jsonb),
      'sources',   COALESCE((SELECT jsonb_agg(to_jsonb(sources))   FROM sources),   '[]'::jsonb)
    )
  $q$, v_col)
  INTO v_result
  USING p_value, v_limit;

  RETURN COALESCE(
    v_result,
    jsonb_build_object('compounds', '[]'::jsonb,
                       'facts',     '[]'::jsonb,
                       'sources',   '[]'::jsonb)
  );
END;
$$;
```

`%1$I` is the positional identifier slot; `$1`/`$2` bind `p_value` /
`v_limit` via `USING`. Exactly the v1 `graph_top_string_field` shape —
allowlist first, `%I` for the identifier, parameters for values.
**A non-matching `p_value` returns the empty-arrays payload, which is a
200 with empty results, NOT an error** (empty-not-error on expand).

#### 5) Expression indexes (keep the live view fast without materializing)

The view's `GROUP BY graph_normalize_entity(col)` and the expand
`WHERE graph_normalize_entity(col) = $1` both benefit from an
expression index per kind:

```sql
CREATE INDEX IF NOT EXISTS idx_bioprospecting_norm_bioactivity
  ON public.research_bioprospecting_facts (public.graph_normalize_entity(bioactivity))
  WHERE bioactivity IS NOT NULL AND bioactivity <> '';

CREATE INDEX IF NOT EXISTS idx_bioprospecting_norm_application_area
  ON public.research_bioprospecting_facts (public.graph_normalize_entity(application_area))
  WHERE application_area IS NOT NULL AND application_area <> '';

CREATE INDEX IF NOT EXISTS idx_bioprospecting_norm_assay_model
  ON public.research_bioprospecting_facts (public.graph_normalize_entity(assay_model))
  WHERE assay_model IS NOT NULL AND assay_model <> '';
```

These are the reason `graph_normalize_entity` is `IMMUTABLE`. They make
`expand`'s lookup an index scan rather than a full-table seq-scan +
per-row function eval. The search view still does a full GROUP BY per
request (the accepted "live view" cost), but the index lets the planner
use an index-only path for the grouping expression on larger corpora.

#### 6) GRANTs (mirror v1)

```sql
GRANT SELECT ON public.research_graph_entities
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.graph_normalize_entity(TEXT)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.graph_entity_search(TEXT, TEXT, INTEGER)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.graph_entity_expand(TEXT, TEXT, INTEGER)
  TO anon, authenticated, service_role;
```

## Read service: `graphService.ts` additions

Two new read-only helpers, using the existing module's TDZ-safe Proxy
client and `clampLimit`. No changes to existing functions.

### New types

```ts
/** The three consultable entity kinds. Allowlist source of truth in TS. */
export type EntityKind = "bioactivity" | "application_area" | "assay_model";

export const ENTITY_KINDS: readonly EntityKind[] = [
  "bioactivity",
  "application_area",
  "assay_model",
] as const;

/** One entity node as returned by search.
 *  `{ kind, value, display }` is the stable identity triple; a future
 *  Approach-B canonical `entity_id?: string` is purely additive here. */
export type EntityNode = {
  kind: EntityKind;
  value: string;    // normalized key (graph_normalize_entity output)
  display: string;  // most frequent raw form, for UI
  compound_count: number;
  fact_count: number;
  source_count: number;
};

/** A compound linked to an expanded entity value. */
export type EntityExpandCompound = {
  id: string;
  canonical_name: string;
  fact_count: number;
};

/** A single fact linked to an expanded entity value (1-hop). */
export type EntityExpandFact = {
  id: string;
  source_id: string | null;
  compound_canonical_id: string | null;
  result_summary: string | null;
  quote: string | null;
  page: number | null;
  doi: string | null;
};

/** A source doc linked to an expanded entity value. */
export type EntityExpandSource = {
  id: string;
  title: string;
  doi: string | null;
  url: string | null;
  fact_count: number;
};

/** The 1-hop neighborhood of one normalized entity value. */
export type EntityExpansion = {
  compounds: EntityExpandCompound[];
  facts: EntityExpandFact[];
  sources: EntityExpandSource[];
};
```

### Function signatures

```ts
/** Search distinct normalized entity nodes within a kind.
 *  Throws UnknownEntityKindError for a kind outside ENTITY_KINDS so the
 *  route maps it to 400. Default limit 20, max 100 (clamped). */
export async function searchEntities(params: {
  kind: EntityKind;
  query: string;
  limit?: number;
}): Promise<EntityNode[]>;

/** Expand one normalized entity value to its 1-hop compounds / facts /
 *  sources. Returns { compounds:[], facts:[], sources:[] } (NOT an
 *  error) when the value matches nothing. Default limit 20, max 100. */
export async function expandEntity(params: {
  kind: EntityKind;
  value: string;
  limit?: number;
}): Promise<EntityExpansion>;
```

Implementation notes:
- Both validate `kind` against `ENTITY_KINDS` up-front and throw a
  typed `UnknownEntityKindError` (route → 400) rather than relying only
  on the SQL `RAISE`. Belt-and-suspenders, and keeps a clean 400 vs 500
  boundary (a SQL `RAISE` would otherwise surface as a generic RPC
  error → 500).
- `searchEntities` calls `.rpc("graph_entity_search", { p_kind, p_query, p_limit })`
  and maps `fact_count`/`compound_count`/`source_count` through
  `Number(...)` (Postgres `BIGINT` arrives as string), same as
  `getTopCoOccurring`.
- `expandEntity` calls `.rpc("graph_entity_expand", { p_kind, p_value, p_limit })`;
  the RPC returns a single `jsonb` object, so the helper reads
  `data` as `EntityExpansion` and coerces the numeric `fact_count`
  fields via `Number(...)`. Missing arrays default to `[]`.
- `value` is passed through to the RPC **verbatim** — the service does
  NOT normalize it. The value comes from a prior `search` response
  (already normalized) and expand re-derives the key with the same SQL
  function. The service normalizing here would risk double-normalization
  drift and violate the single-source invariant.

## API route: `research-brain-graph.ts` additions

Two new `GET` handlers appended to the existing Elysia plugin, same
`prefix: "/api/research-brain"`, same admin gate.

### `GET /graph/entities/:kind/search`

| Aspect | Value |
|---|---|
| Path params | `:kind` (must be one of the 3 kinds) |
| Query params | `q` (optional; empty → top nodes), `limit` (default 20, max 100, silent clamp) |
| Auth | `authResolver({ required: true, role: "admin" })` |
| 200 body | `{ kind, query, limit, entities: EntityNode[] }` |
| 400 body | `{ error: "unknown entity kind", allowed: ["bioactivity", "application_area", "assay_model"] }` |
| 401 | resolver contract — no auth |
| 403 | resolver contract — `Admin role required` |
| 500 body | `{ error: "internal_error" }` |

### `GET /graph/entities/:kind/:value/expand`

| Aspect | Value |
|---|---|
| Path params | `:kind` (allowlisted), `:value` (URL-decoded normalized key) |
| Query params | `limit` (default 20, max 100, silent clamp) |
| Auth | admin |
| 200 body | `{ kind, value, limit, expansion: EntityExpansion }` |
| 400 body | `{ error: "unknown entity kind", allowed: [...] }` (unknown `:kind` only) |
| 401/403 | resolver contract |
| 200 (empty) | a value that matches nothing returns `{ ..., expansion: { compounds: [], facts: [], sources: [] } }` — **empty is not an error** |
| 500 body | `{ error: "internal_error" }` |

### Validation & error mapping (both routes)

- `:kind` is validated against `ENTITY_KINDS` **before** any DB call.
  Unknown → 400 (never reaches SQL). This is the primary allowlist gate
  at the edge; the SQL `RAISE` is the defense-in-depth backstop.
- `:value` is never string-interpolated; it is bound as the `$1`
  parameter inside the RPC. Path decoding is the route's responsibility
  (`decodeURIComponent`); the decoded string flows straight to
  `p_value`.
- `limit` parsing mirrors the v1 route (`Number.isFinite` guard, clamp
  to `[1,100]`, default 20).
- Any thrown DB/RPC error is caught, logged
  (`research_brain_graph_entities_*_failed`), and returned as
  `{ error: "internal_error" }` with `set.status = 500` — no detail
  leak, same as v1.

## API stability (Approach-B forward-compat)

Entity identity is the triple `{ kind, value, display }`:
- `value` (normalized) is the join key between search and expand.
- `display` is presentation-only.

When Approach B lands a canonical registry, it adds an optional
`entity_id: string` to `EntityNode` (and accepts it on expand) **without
removing or repurposing** `kind`/`value`. Existing consumers keying on
`{kind, value}` keep working; new consumers prefer `entity_id`. This is
the same additive-swap promise v1 made for the co-occurrence CTE→table
migration.

## Performance notes

- **Live GROUP BY cost.** Each search request re-aggregates the facts
  table through the UNION view. For the MVP corpus this is cheap; the
  three partial expression indexes above keep the grouping expression
  index-backed. If measured hot, the view is promoted to a materialized
  view + scheduled/`pg_cron` refresh **with no API contract change**
  (the RPCs would then read the matview). This promotion is explicitly
  deferred — do not build it now.
- **Expand cost.** Bounded by the per-kind expression index on
  `graph_normalize_entity(col)`; the `WHERE ... = $1` is an index scan.
  Three `LIMIT $2`-capped CTEs keep the payload bounded.
- **`mode()` for display.** Computed inside the same GROUP BY pass; no
  extra scan.
- **No refresh hook** means zero added latency on the write/extraction
  path — a deliberate contrast with v1's post-extraction
  `refreshAggregates()` call.

## Open design decisions resolved

| Decision | Choice | Why |
|---|---|---|
| Matview vs live view | **Live view** (`research_graph_entities`) | Locked decision; always fresh, truly additive, no refresh hook to unwind. Matview is a deferred perf opt with an unchanged contract. |
| Search: dynamic column vs literal-kind filter on a UNION view | **UNION view + `WHERE kind = p_kind` literal** | The pre-aggregated view removes the identifier-injection surface for search entirely; `%I` is reserved for expand, which genuinely needs a per-fact dynamic column. Allowlist guard still enforced in both. |
| Expand return shape | **Single `jsonb` `{compounds,facts,sources}`** | One round-trip for the whole 1-hop neighborhood; maps cleanly to `EntityExpansion`; avoids three RPCs. |
| Where normalization runs | **Only in SQL (`graph_normalize_entity`)** | Guarantees the search-key == expand-key invariant; service/route never re-normalize. |
| Normalizer language | **`LANGUAGE sql IMMUTABLE PARALLEL SAFE`** | `IMMUTABLE` is required for the expression indexes; `sql` folds well and is parallel-safe for the live GROUP BY. |
| Singularization aggressiveness | **Conservative: trailing `s` after a non-`s` consonant only** | Collapses obvious plurals (`antifungals`) without mangling `class`/`analysis`/`virus`; contested semantic synonyms deferred to Approach B. |
| Unknown-kind error boundary | **400 at the route (TS allowlist) + SQL `RAISE` backstop** | Clean 400 vs 500 separation; SQL error never leaks as a 500 for a client input problem. |
| Empty expand result | **200 with empty arrays, not 404/error** | A valid kind + a value that matches nothing is a legitimate empty neighborhood, not a client error. |
| Migration count | **One migration** | No matview/refresh split; view + fn + 2 RPCs + indexes roll back as one block. |

## Risks and tradeoffs

| Risk | Likelihood | Mitigation |
|---|---|---|
| Live GROUP BY too slow at scale | Low (MVP corpus) | Per-kind expression indexes; cap `limit`; deferred matview promotion keeps the contract stable. |
| Normalizer over-collapses distinct concepts | Low | Singularization is consonant-gated and touches only the final trailing `s`; `display` preserves the raw form; contested cases deferred to Approach B. |
| Normalizer under-collapses (`anti fungal` with a space stays distinct from `antifungal`) | Medium | Accepted for v2 — the locked scope is hyphen/case/plural collapse only; space-join collapse is an Approach-B concern to avoid false merges. |
| `:kind` / `:value` injection | Very low | `:kind` allowlisted in TS before any DB call and re-checked in SQL; `:value` always bound as `$1`, never interpolated; expand column comes from the allowlisted kind via `%I`. |
| `IMMUTABLE` mislabeled (function not actually deterministic) | Low | The body is pure string ops (`lower`/`btrim`/`regexp_replace`) with no locale-sensitive collation branch; deterministic for a given input. |
| Expression index bloat (3 partial indexes) | Low | Partial (`WHERE col IS NOT NULL AND col <> ''`) keeps them small; they mirror the existing `lower(col)` partial indexes already on this table. |
| API shape locks out Approach B | Low | Keyed by `{kind, value}`; `entity_id` is additive later. |

## Out of scope (explicit)

- **Approach B** — canonical registry tables, typed
  `research_graph_entity_mentions`, write-path resolution, backfill,
  MeSH-grade synonymy (`cytotoxic ≈ anti-tumoral`).
- **PR3** — the LLM-driven semantic linker (`graphLinkerAgent`).
- **Co-occurrence materialization** — already answered on the fly by
  v1's `graph_top_co_occurring`.
- **Additional kinds** — `geography`, `ecosystem`, `organism_part`,
  `compound_class`, `molecule_type`, `evidence_type`.
- **Any write-path change** — extractor and
  `replaceBioprospectingFactsForSource` are untouched; no schema
  mutation; no refresh hook.
- **Matview + refresh promotion** — deferred perf optimization,
  contract-stable, not built now.
- **Space-join / synonym normalization** — deferred to Approach B.

## Rollback plan

1. Remove the two route handlers from `research-brain-graph.ts` →
   endpoints 404.
2. Remove `searchEntities` / `expandEntity` (+ types) from
   `graphService.ts` — no other module imports them.
3. Drop SQL objects (single block):
   `DROP VIEW IF EXISTS public.research_graph_entities;`
   `DROP FUNCTION IF EXISTS public.graph_entity_search(TEXT, TEXT, INTEGER);`
   `DROP FUNCTION IF EXISTS public.graph_entity_expand(TEXT, TEXT, INTEGER);`
   `DROP INDEX IF EXISTS idx_bioprospecting_norm_bioactivity, idx_bioprospecting_norm_application_area, idx_bioprospecting_norm_assay_model;`
   `DROP FUNCTION IF EXISTS public.graph_normalize_entity(TEXT);`
   No FK references, no dependent objects, no write-path hook to unwind.

## Delivery strategy (for `sdd-tasks`)

- **Single PR.** One migration + service additions + route additions.
  No matview, no extractor hook, no refresh path → smaller than v1.
- Estimated ~120 SQL LOC + ~120 service LOC + ~90 route LOC (~330
  backend), well under the 400-line review budget.
- The view, RPCs, service helpers, and routes must land together (the
  endpoints depend on the RPCs; the RPCs depend on the view and
  normalizer).

## Decision needed before apply: No (single-PR, additive, LLM-free)
## Chained PRs recommended: No
## 400-line budget risk: Low (~330 backend LOC, single reviewable PR)
