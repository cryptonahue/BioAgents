# Tasks: bioprospecting-knowledge-graph (v1)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~470 backend LOC, ~650 with tests |
| 400-line budget risk | Low |
| Chained PRs recommended | No (intentional single-PR per proposal) |
| Delivery strategy | single-pr |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Full v1: matview + 2 RPCs + service + route + hook + tests | PR 1 | Single PR; endpoint cannot mount against unpopulated matview |

## Phase 1: Storage (Migrations)

- [x] 1.1 Create `supabase/migrations/20260615030000_graph_compound_aggregates.sql`: matview, 3 indexes, `refresh_compound_aggregates()` plpgsql, GRANTs, non-concurrent initial REFRESH (BEGIN/COMMIT, IF NOT EXISTS)
- [x] 1.2 Create `supabase/migrations/20260615030010_graph_top_co_occurring.sql`: `graph_top_co_occurring(UUID, INTEGER)` STABLE SQL CTE function + GRANTs
- [x] 1.3 Create `supabase/migrations/20260615030020_graph_top_string_field.sql`: `graph_top_string_field(TEXT, UUID, INTEGER)` STABLE plpgsql with allowlist + `format('%I', ...)` + GRANTs

## Phase 2: Read Service Module

- [x] 2.1 Create `src/services/researchBrain/graphService.ts`: typed Proxy client (mirrors `compoundAuthority.ts:44-53`), exported types, `clampLimit` helper
- [x] 2.2 Implement `searchCompounds({ query, limit, expand })`: 4x FETCH_WINDOW over matview via `or(canonical_name.ilike…, normalized_name.ilike…)`, separate alias pass, 4-tier in-process ranking (exact canonical > exact alias > prefix > substring), tie-break by `fact_count DESC` then `canonical_name ASC`
- [x] 2.3 Add `expand: true` branch: parallel `Promise.all` of `getTopCoOccurring` / `getTopGeographies` / `getTopBioactivities` per hit, attach arrays
- [x] 2.4 Implement `refreshAggregates()`: RPC `refresh_compound_aggregates` with internal try/catch + warn; MUST NOT throw
- [x] 2.5 Implement `getTopCoOccurring`, `getTopGeographies`, `getTopBioactivities` (shared `topByStringField` helper) via the two new RPCs
- [x] 2.6 Modify `src/services/researchBrain/index.ts`: add `export * from "./graphService";`

## Phase 3: API Route

- [x] 3.1 Create `src/routes/research-brain-graph.ts`: Elysia plugin (prefix `/api/research-brain`), `GET /graph/compounds/search`, `beforeHandle: authResolver({ required: true, role: "admin" })`, param validation (`q` 1-100, `limit` clamp 1-100, `expand === "true"`), 400/500 shapes
- [x] 3.2 Modify `src/index.ts`: import + `.use(researchBrainGraphRoute)` after the `researchBrainRoute` mount (line 325)

## Phase 4: Post-Extraction Refresh Hook

- [x] 4.1 Modify `src/services/researchBrain/bioprospectingExtractor.ts`: add `import { refreshAggregates } from "./graphService";` next to existing `compoundAuthority` import (line 11)
- [x] 4.2 Insert 7-line `try { await refreshAggregates(); } catch (err) { logger?.warn(...) }` block after `replaceBioprospectingFactsForSource` (line 480), before `bioprospecting_extraction_completed` log; event name `graph_compound_aggregates_refresh_failed_soft_fail`

## Phase 5: Tests (Hermetic, Mocked Supabase)

- [x] 5.1 Create `__tests__/graphService.test.ts`: scripted Supabase chainable mock (mirrors `compoundAuthority.test.ts:44-60`); cover empty `q`, default limit 20, clamp 100, 4-tier ordering, tie-breakers, case-insensitive, `expand: false` skips RPCs, `expand: true` parallel RPCs, `refreshAggregates` RPC error soft-fail, non-RPC throw soft-fail
- [x] 5.2 Create `__tests__/graphService.cte.test.ts`: mock `supabase.rpc('graph_top_co_occurring', …)`; cover RPC params, default 5, clamp 1-100, empty `compoundId` returns `[]` with no RPC
- [x] 5.3 Create `src/routes/__tests__/research-brain.graph.routes.test.ts`: route-level integration test (auth: admin/non-admin/missing; 400 missing q; 200 with/without expand; limit clamp)

## Phase 6: Verification

- [x] 6.1 Run `bun test src/services/researchBrain/__tests__/graphService*.test.ts`; confirm all 14+ scenarios pass
- [ ] 6.2 Apply migration on a Supabase branch; call `SELECT public.refresh_compound_aggregates();`; confirm matview count = `SELECT count(*) FROM research_compounds`
- [ ] 6.3 Hit `GET /api/research-brain/graph/compounds/search?q=quercetin&expand=true` with admin JWT; confirm 200 + lightweight + expanded shapes per spec
