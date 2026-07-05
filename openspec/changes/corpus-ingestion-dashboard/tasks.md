# Tasks: Corpus Ingestion Dashboard

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~650-800 |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Full feature | PR 1 | All phases; maintainer review acceptable |

## Phase 1: Database& Auth (Foundation)

- [ ] 1.1 Create `supabase/migrations/YYYYMMDDHHMMSS_add_llm_cost_calls.sql` with: `llm_cost NUMERIC(10,6) DEFAULT 0`, `llm_calls JSONB DEFAULT '[]'`, `cancelled_at TIMESTAMPTZ`, `idx_ingestion_runs_status` index, and `record_llm_call` RPC function
- [ ] 1.2 Extend `src/middleware/authResolver.ts` to accept `role` parameter (add `role?: 'admin'` to `AuthResolverOptions`); check `claims.role === 'admin'` when role is required
- [ ] 1.3 Verify migration runs against Supabase schema; confirm new columns appear on `research_ingestion_runs`

## Phase 2: API Routes

- [ ] 2.1 Add `GET /api/research-brain/ingestion/runs` in `src/routes/research-brain.ts` with: query params `status`, `limit` (default 20, max 100), `offset`; returns `{ runs[], total, limit, offset }`; admin auth via `authResolver({ required: true, role: 'admin' })`
- [ ] 2.2 Add `POST /api/research-brain/ingestion/runs/:id/cancel` in `src/routes/research-brain.ts`; sets `cancelled_at` and `status='cancelled'`; returns 409 if already completed; admin auth
- [ ] 2.3 Update `GET /ingestion/runs/:id` response to include `llmCost` and `llmCallsCount` from new columns
- [ ] 2.4 Update `GET /ingestion/runs/:id/files` `beforeHandle` to use `authResolver({ required: true, role: 'admin' })`
- [ ] 2.5 Update `GET /ingestion/runs/:id` `beforeHandle` to use `authResolver({ required: true, role: 'admin' })`

## Phase 3: LLM Cost Tracking

- [ ] 3.1 Create `src/services/researchBrain/llm-cost.ts` with: provider pricing map (OpenAI gpt-4o at $0.003/1K in, $0.012/1K out), `calculateCost(provider, model, inputTokens, outputTokens)` returning USD, `recordLlmCall(runId, entry)` calling Supabase RPC
- [ ] 3.2 Add `run:progress`, `run:llm_call`, `run:cancelled` to `IngestionNotificationType` in `src/services/queue/types.ts`; extend `IngestionProgressNotification` with `llmCost`, `llmCallsCount` fields
- [ ] 3.3 Add `notifyRunProgress`, `notifyRunLlmCall`, `notifyRunCancelled` helpers in `src/services/queue/notify.ts`
- [ ] 3.4 Instrument `src/services/queue/workers/document-ingestion.worker.ts`: call `recordLlmCall` after each LLM invocation; check `cancelled_at` before enqueuing bioprospecting job
- [ ] 3.5 Instrument `src/services/queue/workers/bioprospecting.worker.ts`: call `recordLlmCall` after LLM extraction; check `cancelled_at` on job start; call `notifyRunCancelled` when cancellation detected

## Phase 4: WebSocket

- [ ] 4.1 Add `broadcastToRun(runId, notification)` function in `src/services/websocket/handler.ts` (mirrors `broadcastToConversation` pattern but for `runClients` map)
- [ ] 4.2 Extend `src/services/websocket/subscribe.ts`: add `psubscribe("run:*")` alongside existing `conversation:*` subscription; route messages via `broadcastToRun`
- [ ] 4.3 Update `src/services/websocket/handler.ts` message handler to support `subscribe` with `channel: "run:{id}"` (not conversationId); maintain `runClients` map analogous to `conversationClients`
- [ ] 4.4 Test: connect WS client, subscribe to `run:uuid`, emit notification, verify client receives it

## Phase 5: UI Dashboard

- [ ] 5.1 Create `client/src/hooks/useIngestionRuns.ts` with typed `IngestionRun` interface; exports `listRuns(status?, limit?, offset?)` and `cancelRun(id)` functions calling the new API endpoints
- [ ] 5.2 Create `client/src/hooks/useIngestionWebSocket.ts` subscribing to `run:{id}` channels; returns real-time `IngestionProgressNotification` stream
- [ ] 5.3 Create `client/src/pages/CorpusDashboardPage.tsx` at `/corpus`; fetches runs list on mount; selects first running run if any; wires all sub-components
- [ ] 5.4 Create `client/src/components/ingestion/IngestionRunList.tsx`: dropdown of last 20 runs, filter buttons (All/Running/Completed/Failed/Cancelled), selected run highlighted
- [ ] 5.5 Create `client/src/components/ingestion/IngestionProgressBar.tsx`: processed/total percentage bar, color-coded (green=running, blue=completed, red=failed)
- [ ] 5.6 Create `client/src/components/ingestion/IngestionMetricsBar.tsx`: speed (files/min), failure rate, total cost (`$${llmCost}`), elapsed time (HH:MM:SS)
- [ ] 5.7 Create `client/src/components/ingestion/IngestionFileList.tsx`: sortable table columns (File Path, Status, Chunks, Source ID, Error); status icons (✓ ⊘ ✗ ⟳); filter by status; search by path
- [ ] 5.8 Create `client/src/components/ingestion/IngestionActions.tsx`: "Retry Failed" and "Cancel Run" buttons with confirmation dialogs; disabled states per run status
- [ ] 5.9 Add `.corpus-*` and `.ingestion-*` CSS classes to `client/src/styles/library.css` (empty state, layout, component styles)

## Phase 6: Testing

- [ ] 6.1 Unit test for `calculateCost()` in `src/services/researchBrain/llm-cost.ts` with known token counts → expected USD
- [ ] 6.2 Integration test for `GET /ingestion/runs` with admin auth and without; verify401/403 responses
- [ ] 6.3 Integration test for `POST /ingestion/runs/:id/cancel` on running vs completed run; verify 409 on completed
- [ ] 6.4 Integration test for WebSocket `run:*` subscription: connect WS, subscribe to run channel, trigger notification, assert receipt
- [ ] 6.5 E2E cancel flow: start run, call cancel API, verify `cancelled_at` set in DB, verify worker stops enqueuing bioprospecting jobs
