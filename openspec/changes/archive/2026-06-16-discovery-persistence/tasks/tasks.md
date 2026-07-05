# Tasks: Discovery Persistence (v1)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~940 total (PR #1 ~400 prod, PR #2 ~540 tests + route) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR #1 (backend foundation) → PR #2 (route + tests) |
| Delivery strategy | stacked-to-main (orchestrator-locked) |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | PR | Notes |
|------|------|----|-------|
| 1 | Backend foundation: schema, service, match, dual-write | PR #1 | Base = main. No tests, no endpoint. |
| 2 | Read endpoint + hermetic tests + UI integration note | PR #2 | Base = main after PR #1. |

---

## PR #1 — Backend Foundation

### Phase 1.1: Migration

- [x] 1.1.1 Create `supabase/migrations/20260616000300_create_discovery_persistence.sql` per `design.md` §3.1: 3 tables, 8 indexes, `no_self_supersede` CHECK, BEFORE-UPDATE trigger, GRANTs. Confirm timestamp `20260616000300` is free (last is `20260616000200`).
- [x] 1.1.2 Idempotency: every `CREATE` is `IF NOT EXISTS`, trigger drop is `IF EXISTS`, `pgcrypto` is `IF NOT EXISTS`.

### Phase 1.2: Service + Match

- [x] 1.2.1 Add `ResearchDiscovery` + `ResearchDiscoveryEvidence` to `src/services/researchBrain/types.ts` per `design.md` §9.1.
- [x] 1.2.2 Append `normalizeTokens`, `jaccard`, `discoveryStableKey`, `findMatchingDiscovery` to `src/agents/discovery/utils.ts` per `design.md` §5.1. Pure, no Supabase.
- [x] 1.2.3 Create `src/services/researchBrain/discoveryPersistence.ts` per `design.md` §4.1-§4.4. Re-export 4 match fns, export `persistDiscoveriesToDb` + `getDiscoveriesForConversation`. Use `getServiceClient()` proxy from `compoundAuthority.ts:44-53`. Implement 5-step soft-fail flow with §4.4 event names. Contractually non-throwing.
- [x] 1.2.4 Add `export * from "./discoveryPersistence";` to `src/services/researchBrain/index.ts`.
- [x] 1.2.5 `getDiscoveriesForConversation` per §4.3: single Supabase join `*, evidence:research_discovery_evidence(*)` ordered `created_at DESC`, filtered `is_current = true`. Fallback to 2 queries if join fails.

### Phase 1.3: Agent Dual-Write

- [x] 1.3.1 In `src/agents/discovery/index.ts`, insert `try { await persistDiscoveriesToDb({...}) } catch { logger.error(...) }` AFTER `fixDiscoveryArtifactPaths()`, BEFORE `end = new Date().toISOString()`. Return value unchanged.
- [x] 1.3.2 Add import: `persistDiscoveriesToDb` from `"../../services/researchBrain/discoveryPersistence"`.

### Phase 1.4: Worker + Start Hooks

- [x] 1.4.1 In `src/services/queue/workers/deep-research.worker.ts:957-963`, insert dual-write `try/catch` inside `if (discoveryResult) { ... }` BEFORE the JSONB write per `design.md` §7.1.
- [x] 1.4.2 Add import to worker from `"../../researchBrain/discoveryPersistence"`.
- [x] 1.4.3 In `src/routes/deep-research/start.ts:1783-1791`, insert identical dual-write `try/catch` per `design.md` §7.2.
- [x] 1.4.4 Add import to start.ts from `"../../services/researchBrain/discoveryPersistence"`.

### PR #1 Verification

- [x] 1.5.1 `bun run build` passes; `Discovery` type untouched, no JSONB schema change.
- [x] 1.5.2 Soft-fail confirmed: every call site has `try/catch`; `persistDiscoveriesToDb` never throws.
- [x] 1.5.3 Migration passes `psql --dry-run` if dev DB available; else defer to PR #2 tests.

---

## PR #2 — Read Endpoint + Hermetic Tests

### Phase 2.1: Read Endpoint

- [x] 2.1.1 Create `src/routes/deep-research/discoveries.ts` per `design.md` §8.1: Elysia guard `authResolver({ required: true })`, `GET /conversations/:conversationId/discoveries`. 401/400/404/500/200 paths. Returns `{ discoveries: [...] }` with `evidence[] = []` per row (v1 limit).
- [x] 2.1.2 In `src/index.ts`, add import after `deepResearchBranchRoute` and `.use(deepResearchDiscoveriesRoute)` after `.use(deepResearchPaperRoute)` (line ~323).
- [x] 2.1.3 Document `evidence_archived` not-populated in v1 in the route's header comment.

### Phase 2.2: Match Algorithm Tests

- [x] 2.2.1 Create `src/agents/discovery/__tests__/utils.test.ts`. Cover per `design.md` §10.1: `normalizeTokens` (basic, diacritics, short tokens, punctuation), `jaccard` (identical, disjoint, partial, empty cases), `discoveryStableKey` (determinism, sorted), `findMatchingDiscovery` (high-sim, low-sim null, empty existing, tie-break, parameterizable threshold).

### Phase 2.3: Service Module Tests

- [x] 2.3.1 Create `src/services/researchBrain/__tests__/discoveryPersistence.test.ts`. Use `scriptedMock` + `setMockServiceClient` + `mock.module("../../../db/client", ...)` from `compoundAuthority.test.ts:78-143`. Cover §10.2: happy, supersede + evidence merge, no-match, removed, load-fail, insert-fail, all-fail; `getDiscoveriesForConversation` happy / empty / only-current.
- [x] 2.3.2 Import SUT via `../discoveryPersistence` (relative, matches `compoundAuthority.test.ts:146-159`).

### Phase 2.4: Route Tests

- [x] 2.4.1 Create `src/routes/deep-research/__tests__/discoveries.test.ts`. Mock `getServiceClient`, `getConversation`, `getDiscoveriesForConversation`. Cover §10.3: 200 happy (2 rows), 401 no auth, 404 unknown, 404 unowned, 500 DB fail, 200 empty.

### Phase 2.5: Agent Smoke Test

- [x] 2.5.1 Create `src/agents/discovery/__tests__/index.test.ts`. Mock `extractDiscoveries`, spy on `persistDiscoveriesToDb` via module mock. Assert: (a) spy called with right args + `threshold=0.7`, (b) spy throw does not break agent's return, (c) return's `discoveries` is post-`fixDiscoveryArtifactPaths`.

### PR #2 Verification

- [x] 2.6.1 `bun test` for all new test files passes.
- [x] 2.6.2 `bun run build` passes.
- [x] 2.6.3 `curl -H "Authorization: Bearer $JWT" .../discoveries` returns 200/401/404 as expected.

---

## Cross-PR Guardrails

- No `Discovery` type change. JSONB stays source of truth for planning/reply/paper.
- No backfill. Legacy conversations get rows only on next deep-research cycle.
- Soft-fail is mandatory. Event names in `design.md` §4.4 are the contract.
- Forward-compat hooks (`last_checked_at`, `reeval_status`, `idx_discoveries_reeval_due`, `research_discovery_reeval_audit`) are real in PR #1 even though v1 writes nothing to them.

## Relevant Files

- `proposal.md` — v1 scope, rollback
- `design.md` — authoritative technical design
- `specs/.../spec.md` — requirements + scenarios
- `src/agents/discovery/{index,utils}.ts` — agent main + match functions
- `src/services/researchBrain/discoveryPersistence.ts` — new service
- `src/services/researchBrain/{types,index}.ts` — types + barrel
- `src/services/queue/workers/deep-research.worker.ts:957-963` — worker hook
- `src/routes/deep-research/{start.ts:1783-1791, discoveries.ts}` — start hook + new route
- `src/index.ts:14-17, 320-323` — import + mount
- `supabase/migrations/20260616000300_create_discovery_persistence.sql` — new migration
