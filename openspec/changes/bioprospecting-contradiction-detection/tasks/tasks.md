# Tasks: bioprospecting-contradiction-detection

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~650–800 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | 3-PR chain |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Migration + types + DB layer | PR 1 | Base: main; self-contained foundation |
| 2 | Detection logic + worker integration | PR 2 | Base: PR 1; core detection engine |
| 3 | Search integration + API endpoints + tests | PR 3 | Base: PR 2; wiring + verification |

## Phase 1: Infrastructure (Migration + Types + DB Layer)

- [x] 1.1 Create `supabase/migrations/YYYYMMDDHHMMSS_create_bioprospecting_contradictions.sql` with the `research_bioprospecting_contradictions` table, 5 indexes, trigger, and grants as defined in design §3
- [x] 1.2 Add `ResearchBioprospectingContradiction` type to `src/services/researchBrain/types.ts`
- [x] 1.3 Add `EvidencePackContradiction` type to `src/services/researchBrain/types.ts`
- [x] 1.4 Extend `EvidencePack` type in `src/services/researchBrain/types.ts` to include `contradictionWarnings: EvidencePackContradiction[]`
- [x] 1.5 Create `src/services/researchBrain/contradictionDb.ts` with `upsertBioprospectingContradiction()`, `searchBioprospectingContradictions()`, `resolveBioprospectingContradiction()`, and `getContradictionsForSource()` functions

## Phase 2: Detection Engine (Rule-Based + LLM Pass)

- [x] 2.1 Create `src/services/researchBrain/contradictionDetector.ts` — export `runRuleBasedDetection(facts, sourceId, runId)` — pure function implementing `measurement_direction` and `relation_type` opposites matching from design §4
- [x] 2.2 Add `normalizeForMatch()` import or re-export in `contradictionDetector.ts` (reuse from `search.ts`)
- [x] 2.3 Add deduplication check before insert: skip if identical `source_fact_id + conflicting_fact_id + contradiction_type` row exists
- [x] 2.4 Create `src/services/researchBrain/contradictionLlM.ts` — export `runLLMDetection(facts, sourceId)` with flag guard on `BIOPROSPECTING_CONTRADICTION_DETECTION` and LLM availability check via `resolveResearchBrainLLM()`, implementing prompt from design §5
- [x] 2.5 Export `runContradictionDetection({ sourceId, runId, options? })` from `src/services/researchBrain/index.ts` — orchestrates rule-based pass then LLM pass

## Phase 3: Worker Integration + Search Wiring

- [ ] 3.1 Add `ContradictionDetectionJobData` interface to `src/services/queue/types.ts`
- [ ] 3.2 Extend `src/services/queue/workers/bioprospecting.worker.ts` — add shape-based job routing: if `job.data.maxChunks === undefined && job.data.batchSize === undefined`, route to contradiction detection handler
- [ ] 3.3 Add `processBioprospectingJob()` post-extraction call to `runContradictionDetection()` guarded by `BIOPROSPECTING_CONTRADICTION_DETECTION === "true"` (design §2.A)
- [ ] 3.4 Add `GET /api/research-brain/sources/:sourceId/contradictions` endpoint in `src/routes/research-brain.ts` — query param `?status=unresolved|resolved|dismissed|all`, default `all`; uses `getContradictionsForSource()`
- [ ] 3.5 Extend `src/services/researchBrain/search.ts` — in `researchBrainSearch()`, after fetching facts, call `searchBioprospectingContradictions({ factIds })` and map results to `contradictionWarnings` in the returned `EvidencePack` (design §6)
- [ ] 3.6 Add `contradictionToWarning()` mapper in `search.ts` to transform `ResearchBioprospectingContradiction` → `EvidencePackContradiction`

## Phase 4: API Endpoints + Manual Trigger

- [ ] 4.1 Add `POST /api/research-brain/contradictions/:id/resolve` endpoint in `src/routes/research-brain.ts` — body `{ resolutionStatus: "resolved" | "dismissed", resolvedBy?: string }`; updates `resolution_status`, `resolved_by`, `resolved_at`
- [ ] 4.2 Add `POST /api/research-brain/sources/:sourceId/contradictions/detect` endpoint in `src/routes/research-brain.ts` — enqueues a `ContradictionDetectionJobData` job to the `bioprospecting` queue for manual re-run
- [ ] 4.3 Verify `contradictionWarnings` field is never omitted from `EvidencePack` — always return `[]` when empty (design §7)

## Phase 5: Testing

- [ ] 5.1 Write unit tests for `runRuleBasedDetection` in `src/services/researchBrain/__tests__/contradictionDetector.test.ts` — cover agonist/antagonist, activator/inhibitor, activates/inhibits, no-match, and deduplication scenarios
- [ ] 5.2 Write unit tests for `searchBioprospectingContradictions` in `src/services/researchBrain/__tests__/contradictionDb.test.ts` — cover empty factIds, single fact match, and both directions
- [ ] 5.3 Write integration test for `GET /api/research-brain/sources/:id/contradictions` — mock DB response, verify status filtering
- [ ] 5.4 Write integration test for `POST /api/research-brain/contradictions/:id/resolve` — verify status update and timestamp
- [ ] 5.5 Write test for EvidencePack `contradictionWarnings` field presence — verify the field is always included, never undefined

## Implementation Order

1. **Phase 1 first** — migration must run before any code that touches the table. Types and DB functions are prerequisites for everything else.
2. **Phase 2 second** — detection logic is self-contained and independently testable; no worker changes needed to validate it.
3. **Phase 3 third** — worker needs detection functions from Phase 2; search needs DB functions from Phase 1 and types from Phase 1.
4. **Phase 4 fourth** — API endpoints depend on Phase 1 DB functions.
5. **Phase 5 last** — tests verify all integration points.

## Flag Gates

The following tasks are conditionally gated behind `BIOPROSPORTING_CONTRADICTION_DETECTION=true`:

- Task 3.3 (worker post-extraction call)
- Task 2.4 (LLM detection pass)
- Task 2.5 (orchestration function — guards both passes internally)

All other tasks implement the data layer, types, and API endpoints which are unconditional (the feature is opt-in via flag, but the code is always present).