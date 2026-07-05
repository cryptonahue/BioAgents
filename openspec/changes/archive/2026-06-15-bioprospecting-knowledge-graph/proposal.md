# Proposal: Bioprospecting Knowledge Graph (v1 — Compound-Centric Aggregates)

## Intent

Ship the first slice of an explicit "knowledge graph" read layer for the Research Brain: a **compound-centric aggregate view** that answers "what do we know about compound X across all papers" in a single, cheap, O(1) lookup. v1 ships as **one PR** that adds a single materialized view, a single search endpoint, and a soft-fail refresh hook from the extractor. v2/v3 (entity mention graph, compound co-occurrence, LLM-driven fact/claim semantic edges) are explicitly out of scope and tracked separately.

This is the read-side foundation the discovery agent, the evidence pack, and the future graph query layer will all build on. It does NOT change the existing facts/claims/sources schema; the new layer is purely additive.

## Scope

### In Scope (v1)
- **New materialized view** `public.research_graph_compound_aggregates` — one row per canonical compound with `fact_count`, `source_count`, `claim_count`, `last_seen_at`, joined against `research_compounds`.
- **New SQL function** `public.refresh_compound_aggregates()` — wraps `REFRESH MATERIALIZED VIEW CONCURRENTLY` so callers don't need to remember the unique-index prerequisite.
- **New search endpoint** `GET /api/research-brain/graph/compounds/search?q=&limit=&expand=` — typeahead-friendly compound search.
- **Hybrid response shape (Q1 = c)**: by default the endpoint returns lightweight metadata + counts (id, canonical_name, pubchem_cid, fact_count, source_count, claim_count, last_seen_at). When the caller passes `?expand=true`, the response additionally includes `topCoOccurring` (up to 5), `topGeographies` (up to 5), `topBioactivities` (up to 5) — enough to power a detail panel without forcing dropdowns/list views to pay for it.
- **Alias-aware matching (Q2)**: search matches against BOTH `research_compounds.canonical_name`/`normalized_name` AND `research_compound_aliases.alias` (case-insensitive, `ILIKE` on the query, ordered by exact-canonical > exact-alias > prefix > substring).
- **Auth required (Q3)**: endpoint requires authentication. Role check uses `admin` (the only role currently enforced in `src/middleware/authResolver.ts:334-353` — the `researcher` role is not yet a checked value; until the resolver is widened, this proposal gates on `admin` so the route is unreachable to anonymous and JWT-but-not-admin traffic). When the resolver gains `researcher` support, the route can be relaxed without a migration.
- **Post-extraction soft-fail refresh (Q4)**: `bioprospectingExtractor.ts` calls `refresh_compound_aggregates()` after a successful `replaceBioprospectingFactsForSource` batch. The call is wrapped in try/catch: failures log a warning and never abort the extraction. A separate manual `REFRESH MATERIALIZED VIEW` step is documented for backfill.
- **New service module** `src/services/researchBrain/graphService.ts` — read-side helpers (`searchCompounds`, `getCompoundAggregate`, `expandCompoundAggregate`).
- **New route file** `src/routes/research-brain-graph.ts` — mounted under `/api/research-brain/graph/*` to keep the existing `src/routes/research-brain.ts` (32 endpoints) untouched.
- **New spec file** `openspec/specs/bioprospecting-knowledge-graph/spec.md` (written by sdd-spec).
- **One small UI hook** (optional, in PR #1 if time permits; not a blocker) — a list view in the existing EvidencePack panel. JSON endpoint is the v1 contract; UI is best-effort.

### Out of Scope (deferred to follow-up changes)
- `research_graph_entity_mentions` table (PR #2 of the original 3-PR split) — turns free-text `bioactivity`/`application_area`/`assay_model` into typed edges.
- `research_graph_target_terms` / `research_graph_application_terms` curated registries.
- `research_graph_compound_co_occurrences` table and `graphLinkerAgent` (the LLM-driven fact↔fact and claim↔claim edge extractor).
- Discovery persistence (promoting `Discovery` from JSONB to a first-class entity).
- `react-flow` graph visualisation.
- Fact → Claim and Claim → Claim typed semantic edges.

## Capabilities

### New Capabilities
- `bioprospecting-knowledge-graph` (v1): Compound-centric aggregate read layer for the Research Brain. Powers the "show me everything known about compound X" query pattern that today requires hand-rolled `lower(compound) = lower($1)` joins.

### Modified Capabilities
- None. The facts/claims/sources schemas are unchanged. `bioprospectingExtractor.ts` gains one soft-fail hook at the end of the existing flow; it does not mutate extractor behavior.

## Approach

### Storage
One materialized view, two indexes, one SQL function. No new tables in v1.

```sql
-- supabase/migrations/<date>_graph_compound_aggregates.sql
CREATE MATERIALIZED VIEW IF NOT EXISTS public.research_graph_compound_aggregates AS
SELECT
  c.id                                AS compound_id,
  c.canonical_name,
  c.normalized_name,
  c.pubchem_cid,
  COUNT(DISTINCT f.id)                AS fact_count,
  COUNT(DISTINCT f.source_id)         AS source_count,
  COUNT(DISTINCT f.claim_id) FILTER (WHERE f.claim_id IS NOT NULL) AS claim_count,
  MAX(f.created_at)                   AS last_seen_at
FROM public.research_compounds c
LEFT JOIN public.research_bioprospecting_facts f
  ON f.compound_canonical_id = c.id
GROUP BY c.id, c.canonical_name, c.normalized_name, c.pubchem_cid;

-- Required for REFRESH ... CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_research_graph_compound_aggregates_pk
  ON public.research_graph_compound_aggregates (compound_id);
CREATE INDEX IF NOT EXISTS idx_research_graph_compound_aggregates_fact_count
  ON public.research_graph_compound_aggregates (fact_count DESC);

-- Wraps CONCURRENTLY so callers don't have to remember the unique-index rule
CREATE OR REPLACE FUNCTION public.refresh_compound_aggregates()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.research_graph_compound_aggregates;
EXCEPTION WHEN OTHERS THEN
  -- First refresh after creation has no data yet; CONCURRENTLY can fail.
  -- Caller can decide whether to retry; this function stays a no-op on error
  -- so the post-extraction hook can soft-fail without aborting extraction.
  RAISE WARNING 'refresh_compound_aggregates failed: %', SQLERRM;
END;
$$;
```

GRANTs mirror the existing pattern from `compound_authority` and `bioprospecting_dedup`: `GRANT ALL TO anon, authenticated, service_role`. The endpoint reads via the Supabase service role; per-user isolation is not a current concern (Research Brain data is shared corpus, not per-user).

### API

`GET /api/research-brain/graph/compounds/search`

Query params:
- `q` (required, 1-100 chars) — search term.
- `limit` (optional, default 20, max 50) — page size.
- `expand` (optional, default `false`) — when `true`, each hit also returns `topCoOccurring`, `topGeographies`, `topBioactivities` arrays.

Response (lightweight, default):
```json
{
  "query": "quercetin",
  "results": [
    {
      "compound_id": "uuid",
      "canonical_name": "Quercetin",
      "normalized_name": "quercetin",
      "pubchem_cid": 5280343,
      "fact_count": 137,
      "source_count": 42,
      "claim_count": 8,
      "last_seen_at": "2026-06-12T18:22:11Z"
    }
  ]
}
```

Response (expanded, `?expand=true`) — adds three arrays per hit:
```json
{
  "...": "...",
  "results": [
    {
      "...": "all lightweight fields...",
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

`topCoOccurring` in v1 is a best-effort: it comes from a CTE over `research_bioprospecting_facts` that groups by `source_id` for facts that share the search-hit compound. The full `compound_co_occurrences` table is a v3 concern; v1 ships the same logical answer in fewer rows, computed at query time. If the v1 CTE is hot under load, v3 promotes it to a table without breaking the API.

### Search behavior (Q2 — alias matching)

The SQL helper `searchCompounds(q, limit)` does:

1. `SELECT id, canonical_name, normalized_name, pubchem_cid
   FROM research_compounds
   WHERE canonical_name ILIKE $1 OR normalized_name ILIKE $1`
2. **UNION** (by id) with
   `SELECT c.id, c.canonical_name, c.normalized_name, c.pubchem_cid
   FROM research_compounds c
   JOIN research_compound_aliases a ON a.compound_id = c.id
   WHERE a.alias ILIKE $1`
3. Order by a match-quality score:
   - exact match on `canonical_name` (case-insensitive) → rank 0
   - exact match on an alias → rank 1
   - prefix match on `canonical_name` → rank 2
   - substring match (the `ILIKE %q%` case) → rank 3
4. `LIMIT $2`.

The query is parameterized; `$1` is a bound `q + '%'` for the prefix and a separate bound `q` wrapped in `%...%` for the substring. No string interpolation.

### Refresh strategy (Q4 — post-extraction soft-fail)

Inside `bioprospectingExtractor.ts`, after `replaceBioprospectingFactsForSource` returns successfully:

```ts
// Soft-fail refresh. Never aborts extraction.
try {
  await refreshCompoundAggregates(); // calls REFRESH MATERIALIZED VIEW CONCURRENTLY
} catch (err) {
  logger?.warn(
    { err, sourceId: source.id },
    "graph_compound_aggregates_refresh_failed_soft_fail",
  );
}
```

This mirrors the existing soft-fail pattern around `attachCompoundAuthority` (`bioprospectingExtractor.ts:462-473` — failures log and the batch is never aborted).

**Backfill**: for already-ingested sources, run the refresh once via SQL on a deployment window:
```sql
SELECT public.refresh_compound_aggregates();
-- or, if CONCURRENTLY fails on first run:
REFRESH MATERIALIZED VIEW public.research_graph_compound_aggregates;
```
The migration script includes a one-shot `REFRESH MATERIALIZED VIEW` (non-concurrent) immediately after `CREATE MATERIALIZED VIEW` so the view is populated when the migration lands.

### Auth (Q3)

The route is mounted in `src/routes/research-brain-graph.ts` and uses the existing `authResolver({ required: true, role: 'admin' })` middleware from `src/middleware/authResolver.ts`. Since the resolver currently only enforces `admin` (lines 334-353), this proposal gates on `admin` for v1. When the resolver is widened to support a `researcher` role in a follow-up, the route can switch to `role: 'researcher'` (or accept both) without a contract change. The proposal does NOT add a new role-check branch to the resolver — that's a separate change.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `supabase/migrations/<date>_graph_compound_aggregates.sql` | New | Materialized view + 2 indexes + `refresh_compound_aggregates()` SQL function + GRANTs |
| `src/services/researchBrain/graphService.ts` | New | Read-side: `searchCompounds`, `getCompoundAggregate`, `expandCompoundAggregate` |
| `src/services/researchBrain/index.ts` | Modified | Export the new graph service |
| `src/routes/research-brain-graph.ts` | New | Mounts `GET /graph/compounds/search` under `/api/research-brain` |
| `src/index.ts` | Modified | Register the new route module |
| `src/services/researchBrain/bioprospectingExtractor.ts` | Modified | Add soft-fail `refreshCompoundAggregates()` call after `replaceBioprospectingFactsForSource` |
| `src/middleware/authResolver.ts` | Untouched | Reuses existing `admin` role check; no new code |
| `openspec/specs/bioprospecting-knowledge-graph/spec.md` | New | Spec written by sdd-spec |
| `client/src/components/EvidencePack.tsx` | Optional | Small read-only list view if time permits; not a blocker for v1 |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `REFRESH MATERIALIZED VIEW CONCURRENTLY` fails because of pending concurrent writes | Low | Migration uses non-concurrent `REFRESH` initially; the SQL function falls back gracefully. Post-extraction hook is wrapped in try/catch and never aborts extraction. |
| `topCoOccurring` CTE is hot at scale | Low (v1 corpus size) | Capped at 5 per hit; if hot, v3 promotes the computation to a `compound_co_occurrences` table without breaking the API contract. |
| `ILIKE %q%` is slow on large `research_compounds` / `research_compound_aliases` tables | Low | v1 corpus is small (compounds table is bounded by chemistry vocabulary, not by fact count). Add `pg_trgm` GIN index in a follow-up if measured. |
| Auth model gap: `researcher` role not enforced by `authResolver` | Low | Proposal uses `role: 'admin'` for v1, which is strictly more restrictive than researcher. Open a follow-up to widen the resolver. |
| Refresh hook runs in the worker and stalls the extraction job | Low | The hook is a no-op DB call; REFRESH on a single-tenant view with CONCURRENTLY is fast at v1 scale. If it ever blocks, move the hook to a fire-and-forget `queue.enqueue` call. |
| v1 ships the same logical answer as v3 (co-occurrence) via a CTE | Low | API contract is the same; the read path changes underneath. Documented as a v1 simplification. |

## Rollback Plan

1. **Disable the post-extraction hook** — comment out the `refreshCompoundAggregates()` call in `bioprospectingExtractor.ts`. No schema delta. Extraction continues unchanged.
2. **Remove the route mount** — unregister `research-brain-graph.ts` from `src/index.ts`. The endpoint 404s.
3. **Drop the materialized view** — `DROP MATERIALIZED VIEW IF EXISTS public.research_graph_compound_aggregates;`. No downstream FK references; safe.
4. **Drop the SQL function** — `DROP FUNCTION IF EXISTS public.refresh_compound_aggregates();`. No callers outside the (now-removed) hook.

The migration is forward-only on disk; rolling back the migration is a manual SQL step (Supabase migration history is append-only in our current deploy).

## Dependencies

- `research_compounds` and `research_compound_aliases` (from `bioprospecting-compound-authority`) — the search relies on the alias table existing.
- `research_bioprospecting_facts` and `research_compounds.compound_canonical_id` FK (existing).
- `authResolver({ required: true, role: 'admin' })` — existing.
- Supabase service-role credentials (existing).

## Success Criteria

- [ ] `research_graph_compound_aggregates` materialized view exists, is populated by the migration, and stays in sync with `replaceBioprospectingFactsForSource` via the post-extraction hook.
- [ ] `refresh_compound_aggregates()` SQL function exists and is callable from the API service role.
- [ ] `GET /api/research-brain/graph/compounds/search?q=...&limit=...&expand=...` returns:
  - Lightweight metadata + counts by default.
  - Top 5 co-occurring compounds, geographies, bioactivities when `expand=true`.
  - 400 on missing `q`, 401 on no auth, 403 on non-admin auth, 200 on success.
- [ ] Search matches against BOTH `canonical_name` / `normalized_name` AND `research_compound_aliases.alias`, case-insensitive, ordered by match quality (exact canonical > exact alias > prefix > substring).
- [ ] Post-extraction `refreshCompoundAggregates()` hook is soft-fail: extraction never aborts on refresh failure.
- [ ] Manual `REFRESH MATERIALIZED VIEW` is documented for backfill.
- [ ] ~250 LOC total. Single PR. No frontend required (JSON endpoint is the v1 contract; UI is optional/best-effort).
- [ ] New spec file `openspec/specs/bioprospecting-knowledge-graph/spec.md` written by sdd-spec phase.
