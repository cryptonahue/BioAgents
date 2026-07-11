# Tasks: knowledge-graph-entity-graph (KG v2 — entity mention graph, LLM-free)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~120 SQL + ~120 service + ~90 route ≈ **~330 backend LOC** (no enforced tests) |
| 400-line budget risk | **Low** |
| Fits one PR (<400 lines) | **Yes** |
| Chained PRs recommended | **No** |
| Decision needed before apply | **No** |
| Delivery strategy | single-pr (additive, read-only, LLM-free) |

Decision needed before apply: No
Chained PRs recommended: No
400-line budget risk: Low

Rationale: single idempotent migration + two additive service helpers + two
additive route handlers. No matview, no refresh hook, no extractor change, no
schema mutation. The view/RPCs/service/routes must land together (endpoints
depend on the RPCs; the RPCs depend on the view and normalizer), so splitting
would only create dead intermediate states — keep it one PR.

### Suggested Work Units

| Unit | Goal | Depends on | Likely PR |
|------|------|-----------|-----------|
| 1 | DB migration: normalizer fn + live view + 2 RPCs + 3 expression indexes + GRANTs | — | PR 1 |
| 2 | Types + `searchEntities` / `expandEntity` in `graphService.ts` | Unit 1 | PR 1 |
| 3 | Two routes in `research-brain-graph.ts` (allowlist, admin gate, error mapping) | Unit 2 | PR 1 |
| 4 | Verification (typecheck + manual behavioral checklist) | Units 1–3 | PR 1 |

Sequencing is strict: **migration → service → route → verification**.

---

## Phase 1: DB Migration (Storage) — no dependencies

Single idempotent, timestamped, `BEGIN`/`COMMIT`-wrapped migration under
`supabase/migrations/`, mirroring `20260615030000_graph_compound_aggregates.sql`.
Target file: `supabase/migrations/20260711000000_graph_entity_views.sql`.

- [x] 1.1 Create the migration file `supabase/migrations/20260711000000_graph_entity_views.sql` with a `BEGIN;` / `COMMIT;` wrapper.
  - Done when: file exists, wrapped in a transaction, uses only `CREATE OR REPLACE` / `CREATE ... IF NOT EXISTS` (idempotent, re-run is a no-op).

- [x] 1.2 Add `public.graph_normalize_entity(p_value TEXT) RETURNS TEXT`, `LANGUAGE sql IMMUTABLE PARALLEL SAFE`.
  - Steps in order: lower + `btrim`; strip hyphens/unicode dashes `[-‐‑‒–—]`; collapse `\s+` → single space; conservative singularization `([bcdfghjklmnpqrtvwxyz])s$` → `\1`; wrap in `NULLIF(..., '')`.
  - Done when: `antifungal`/`anti-fungal`/`Antifungal`/`  Antifungal  `/`Anti-Fungals` → `antifungal`; `cytotoxic` → `cytotoxic`; `anti-tumoral` → `antitumoral`; `NULL`/`''`/`'   '` → `NULL`; `class`/`analysis`/`virus`/`assays` behave per design (only trailing non-`s` consonant + `s` is stripped). `IMMUTABLE` present (required for the expression indexes).

- [x] 1.3 Add `public.research_graph_entities` as a plain live `VIEW` (NOT materialized).
  - UNION ALL over the 3 columns (`bioactivity`, `application_area`, `assay_model`), each filtered `col IS NOT NULL AND btrim(col) <> ''`; `value = graph_normalize_entity(col)`; `display = mode() WITHIN GROUP (ORDER BY raw)`; `compound_count = COUNT(DISTINCT compound_canonical_id)`; `fact_count = COUNT(DISTINCT id)`; `source_count = COUNT(DISTINCT source_id)`; `WHERE value IS NOT NULL AND value <> ''`; `GROUP BY kind, value`.
  - Done when: distinct normalized values yield one node per `(kind, value)`; counts are DISTINCT (not row counts); blank/NULL raw values produce no node; view is fresh with no refresh step.

- [x] 1.4 Add `public.graph_entity_search(p_kind TEXT, p_query TEXT, p_limit INTEGER)`, `LANGUAGE plpgsql STABLE`.
  - Allowlist-guard `p_kind IN ('bioactivity','application_area','assay_model')` else `RAISE EXCEPTION ... USING ERRCODE = 'invalid_parameter_value'`; clamp `v_limit := greatest(1, least(coalesce(p_limit,20),100))`; normalize the query via `graph_normalize_entity`; read the live view `WHERE kind = p_kind` (literal filter, no dynamic column) and `ILIKE` on normalized value with `%`/`_` escaped; empty query → list all; `ORDER BY fact_count DESC, value ASC LIMIT v_limit`.
  - Done when: returns rows for each valid kind; unknown kind raises; limit clamps to [1,100]; `Anti-Fungal`/`antifungals`/`antifungal` all match the single node.

- [x] 1.5 Add `public.graph_entity_expand(p_kind TEXT, p_value TEXT, p_limit INTEGER) RETURNS jsonb`, `LANGUAGE plpgsql STABLE`.
  - Allowlist-guard `p_kind` (same as 1.4); resolve `v_col := p_kind`; build the query with `format('%1$I', v_col)` for the dynamic column and `EXECUTE ... USING p_value, v_limit` (bind `$1`/`$2`, never interpolate); `matched` CTE filters `graph_normalize_entity(f.<col>) = $1`; join `research_compounds` and `research_sources`; return `jsonb_build_object('compounds', ..., 'facts', ..., 'sources', ...)` with each `COALESCE(..., '[]'::jsonb)`; a non-match returns the empty-arrays payload (NOT an error).
  - Done when: matching value returns the 1-hop compounds/facts/sources; unknown value returns `{compounds:[],facts:[],sources:[]}` (empty-not-error); `:kind` reaches the column only through the allowlist + `%I`.

- [x] 1.6 Add the 3 partial expression indexes (`IF NOT EXISTS`) on `research_bioprospecting_facts`.
  - `idx_bioprospecting_norm_bioactivity`, `idx_bioprospecting_norm_application_area`, `idx_bioprospecting_norm_assay_model`, each `ON (public.graph_normalize_entity(<col>)) WHERE <col> IS NOT NULL AND <col> <> ''`.
  - Done when: all three indexes create without error (proves `graph_normalize_entity` is `IMMUTABLE`).

- [x] 1.7 Add GRANTs mirroring v1: `GRANT SELECT` on the view and `GRANT EXECUTE` on the normalizer + both RPCs `TO anon, authenticated, service_role`.
  - Done when: all four GRANT statements present; migration contains no `ALTER TABLE`/`DROP`/column addition against `research_bioprospecting_facts`, `research_bioprospecting_claims`, `research_compounds`, or `research_sources` (additive-only guarantee).

## Phase 2: Service Layer — depends on Phase 1

Target file: `src/services/researchBrain/graphService.ts` (add only; no existing
function changes). Reuse the module's TDZ-safe Proxy client and `clampLimit`.

- [x] 2.1 Add the exported types + kind allowlist const.
  - `EntityKind`, `ENTITY_KINDS` (`readonly EntityKind[]` as const), `EntityNode`, `EntityExpandCompound`, `EntityExpandFact`, `EntityExpandSource`, `EntityExpansion`, and a typed `UnknownEntityKindError`.
  - Done when: types match the design's signatures; `{ kind, value, display }` identity triple is present with no field that blocks a later additive `entity_id`.

- [x] 2.2 Implement `searchEntities({ kind, query, limit? }): Promise<EntityNode[]>`.
  - Validate `kind` against `ENTITY_KINDS` up-front → throw `UnknownEntityKindError`; call `.rpc("graph_entity_search", { p_kind, p_query, p_limit })`; map `compound_count`/`fact_count`/`source_count` through `Number(...)` (BIGINT arrives as string); default limit 20, max 100 (clamped, never throws).
  - Done when: returns ≤ limit `EntityNode`s; query substring-filters over the normalized value; unknown kind throws the typed error (route → 400).

- [x] 2.3 Implement `expandEntity({ kind, value, limit? }): Promise<EntityExpansion>`.
  - Validate `kind` → throw `UnknownEntityKindError`; call `.rpc("graph_entity_expand", { p_kind, p_value, p_limit })`; read the single `jsonb` as `EntityExpansion`, default missing arrays to `[]`, coerce numeric `fact_count` via `Number(...)`; pass `value` VERBATIM (do NOT re-normalize in TS — the SQL function is the single source of truth); default limit 20, max 100.
  - Done when: no-match resolves to `{compounds:[],facts:[],sources:[]}` (does not reject); value is never re-normalized in the service.

- [~] 2.4 Re-export from the module barrel if the module uses one (mirror v1's `export * from "./graphService"` in `src/services/researchBrain/index.ts`).
  - Done when: `searchEntities` / `expandEntity` / types are importable by the route.
  - N/A: `src/services/researchBrain/` has NO barrel `index.ts` (v1's route also imports directly from `./graphService`). The new route imports `searchEntities`/`expandEntity`/`isEntityKind`/`ENTITY_KINDS` directly from `../services/researchBrain/graphService`, matching v1's `searchCompounds` import. No barrel to update.

## Phase 3: API Route — depends on Phase 2

Target file: `src/routes/research-brain-graph.ts` (append two handlers to the
existing Elysia plugin, `prefix: "/api/research-brain"`, reuse the admin gate).

- [x] 3.1 Add `GET /graph/entities/:kind/search`.
  - `beforeHandle: authResolver({ required: true, role: "admin" })` (same as `/graph/compounds/search`); validate `:kind` against `ENTITY_KINDS` BEFORE any DB call → 400 `{ error: "unknown kind", message: "kind must be one of: bioactivity, application_area, assay_model" }`; parse `q` (optional; empty → top nodes) and `limit` (`Number.isFinite` guard, clamp [1,100], default 20); 200 body `{ kind, query, limit, entities }`; catch/log (`research_brain_graph_entities_search_failed`) → 500 `{ error: "internal_error" }` (no detail leak).
  - Done when: 200 with entities for a valid kind; 400 on unknown kind (no DB query); 401 no auth; 403 non-admin; limit clamps; `antifungal`/`anti-fungal`/`Antifungal` return a single node.

- [x] 3.2 Add `GET /graph/entities/:kind/:value/expand`.
  - Same admin gate; validate `:kind` → 400 as above; `decodeURIComponent` the `:value`, pass to `expandEntity` (bound as `$1` in the RPC, never interpolated); `limit` default 20 / max 100; 200 body `{ kind, value, limit, expansion }`; a value matching nothing → 200 with empty arrays (NOT 404/500); catch/log (`research_brain_graph_entities_expand_failed`) → 500 `{ error: "internal_error" }`.
  - Done when: 200 neighborhood for a real value; raw variant (`Anti-Fungal`) resolves the same node; no-match → 200 empty; unknown kind → 400; 401/403 per resolver.

- [x] 3.3 Confirm the plugin is already mounted in `src/index.ts` (v1 mounted `researchBrainGraphRoute`); no new `.use()` needed if the handlers are appended to the same plugin.
  - Done when: both new endpoints are reachable under `/api/research-brain/graph/entities/...`.

## Phase 4: Verification (repo is tdd:false — `bun test` runner, no enforced tests)

Automated + manual gates. No test runner is mandated; note where unit tests
COULD be added but do not require them.

- [x] 4.1 Typecheck: `bun tsc --noEmit` (or the repo's typecheck script) passes with the new types/helpers/handlers.
  - Done when: zero type errors introduced by this change.

- [ ] 4.2 Apply the migration on a local/branch Supabase and sanity-check SQL:
  - `SELECT public.graph_normalize_entity('Anti-Fungals');` → `antifungal`; `SELECT public.graph_normalize_entity('cytotoxic');` → `cytotoxic`; `SELECT public.graph_normalize_entity('   ');` → `NULL`.
  - `SELECT * FROM public.research_graph_entities WHERE kind='bioactivity' LIMIT 5;` returns nodes with the 3 counts + `display`.
  - Re-run the migration → no error, no duplicate object (idempotency).
  - Done when: all three checks pass and re-run is a no-op.

- [ ] 4.3 Behavioral curl checklist (admin JWT) against a running server:
  - `GET /api/research-brain/graph/entities/bioactivity/search?q=anti` → 200, `antifungal` appears as ONE node (the `antifungal`/`anti-fungal` collapse case).
  - `GET /api/research-brain/graph/entities/bioactivity/antifungal/expand` → 200 with compounds/facts/sources.
  - `GET /api/research-brain/graph/entities/bioactivity/Anti-Fungal/expand` → 200, same node as normalized form.
  - `GET /api/research-brain/graph/entities/bioactivity/nonexistent/expand` → 200 with empty arrays (empty-not-error).
  - `GET /api/research-brain/graph/entities/geography/search` → 400 `{ error, allowed/message }`.
  - Same endpoints with no auth → 401; with non-admin JWT → 403.
  - `?limit=500` → clamped to 100; no `limit` → 20.
  - Done when: every row above returns the stated status/body.

- [ ] 4.4 (Optional, not mandated) Note where lightweight unit tests COULD be added: a `graph_normalize_entity` contract table test (raw → normalized rows from the spec) and a `graphService` mocked-Supabase test mirroring v1's `graphService.test.ts` (unknown-kind throw, limit clamp, BIGINT→Number coercion, empty-expand resolves empty). Do NOT mandate a runner or block the PR on these.
