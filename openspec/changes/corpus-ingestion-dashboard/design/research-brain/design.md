# Design: Corpus Ingestion Dashboard

## Technical Approach

Extend the existing Research Brain ingestion system with a dashboard for monitoring run progress, LLM costs, and file-level status. Workers emit `run:*` Pub/Sub notifications (already partially wired via `notifyIngestion`). The API gets two new admin-only endpoints (list runs, cancel run), the single-run endpoint gains `llm_cost`/`llm_calls_count`, and the client gets a new `/corpus` page with real-time WebSocket updates.

## Architecture Decisions

### Decision: Run-state cancellation via database flag

**Choice**: Set `cancelled_at` on the run row; workers poll this field before enqueuing child jobs.
**Alternatives considered**: Redis-based signalling (adds dependency), BullMQ job removal (unreliable).
**Rationale**: Workers already poll the run on each file; adding a cancelled_at check is a single cheap query that works across all concurrency levels and survives worker restarts.

### Decision: LLM cost tracking via atomic DB increment

**Choice**: Workers call `recordLlmCall(runId, entry)` after each LLM invocation, which appends to `llm_calls` JSONB and increments `llm_cost` in a single Supabase RPC.
**Alternatives considered**: In-memory accumulator (lost on crash), separate LLM call table (more schema complexity).
**Rationale**: JSONB append + numeric increment in one RPC is atomic and survives worker restarts. The JSONB array won't grow unbounded in practice (typical run: dozens of calls).

### Decision: WebSocket `run:{id}` pattern subscription

**Choice**: Extend `subscribe.ts` to also `psubscribe("run:*")` alongside `conversation:*`; route by channel prefix.
**Alternatives considered**: Separate WebSocket namespace `/ws/runs` (requires separate connection), query param `/ws?channels=run:*` (more complex client).
**Rationale**: Matches the existing dual-prefix pattern already in `notify.ts` (`run:{id}` channel). Single WebSocket connection, server-side channel routing.

### Decision: Admin auth via `authResolver({ required: true, role: 'admin' })`

**Choice**: Use `role: 'admin'` check on all new endpoints. Existing `beforeHandle` patterns use `authResolver({ required: false/true })` only; extend to accept `role`.
**Alternatives considered**: Separate admin guard middleware (creates two auth patterns), JWT claim check inline (scattered logic).
**Rationale**: Centralized; the `role` field already exists in JWT payload per `authResolver.ts` line 195 (`claims: ...`).

## Data Flow

```
Worker finishes LLM call
  → recordLlmCall(runId, entry)  [Supabase RPC]
  → notifyIngestion({ type: "run:llm_call", runId, cost })  [Redis Pub/Sub]
  → subscribe.ts receives on "run:*" pattern
  → broadcastToRun(runId, notification)
  → WebSocket clients subscribed to "run:{id}" receive real-time cost update
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `supabase/migrations/YYYYMMDDHHMMSS_add_llm_cost_calls.sql` | Create | Migration for llm_cost, llm_calls, cancelled_at, status index |
| `src/routes/research-brain.ts` | Modify | Add `GET /ingestion/runs` (list), `POST /ingestion/runs/:id/cancel`, update `GET /ingestion/runs/:id` response |
| `src/services/queue/notify.ts` | Modify | Add `notifyRunProgress`, `notifyRunLlmCall`, `notifyRunCancelled` helpers; extend `IngestionNotificationType` |
| `src/services/queue/types.ts` | Modify | Add `run:progress`, `run:llm_call`, `run:cancelled` to `IngestionNotificationType`; extend `IngestionProgressNotification` |
| `src/services/websocket/subscribe.ts` | Modify | Add `psubscribe("run:*")`; route messages via `broadcastToRun` |
| `src/services/websocket/handler.ts` | Modify | Add `broadcastToRun(runId, notification)` function |
| `src/services/queue/workers/document-ingestion.worker.ts` | Modify | Call `recordLlmCall` after each LLM invocation; check `cancelled_at` before enqueuing bioprospecting |
| `src/services/queue/workers/bioprospecting.worker.ts` | Modify | Call `recordLlmCall` after LLM extraction; check `cancelled_at` on start |
| `src/services/researchBrain/llm-cost.ts` | Create | Provider pricing map + `calculateCost()` + `recordLlmCall()` RPC wrapper |
| `client/src/hooks/useIngestionRuns.ts` | Create | API client for runs list, cancel; types for `IngestionRun` |
| `client/src/hooks/useIngestionWebSocket.ts` | Create | WebSocket hook subscribing to `run:{id}` channels |
| `client/src/pages/CorpusDashboardPage.tsx` | Create | Dashboard page at `/corpus` |
| `client/src/components/ingestion/IngestionRunList.tsx` | Create | Run selector + filter buttons |
| `client/src/components/ingestion/IngestionProgressBar.tsx` | Create | Progress bar with color coding |
| `client/src/components/ingestion/IngestionMetricsBar.tsx` | Create | Speed, failure rate, cost, elapsed time |
| `client/src/components/ingestion/IngestionFileList.tsx` | Create | Sortable table with status icons |
| `client/src/components/ingestion/IngestionActions.tsx` | Create | Retry failed, cancel run buttons |
| `client/src/styles/library.css` | Modify | Add `.corpus-*`, `.ingestion-*` CSS classes |

## Interfaces / Contracts

### Database: `research_ingestion_runs` additions

```sql
ALTER TABLE public.research_ingestion_runs
  ADD COLUMN IF NOT EXISTS llm_cost NUMERIC(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS llm_calls JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_status ON public.research_ingestion_runs (status);
```

### Supabase RPC: `record_llm_call`

```sql
CREATE OR REPLACE FUNCTION record_llm_call(
  p_run_id UUID,
  p_provider TEXT,
  p_model TEXT,
  p_input_tokens INT,
  p_output_tokens INT,
  p_cost_usd NUMERIC(10,6),
  p_latency_ms INT
) RETURNS VOID AS $$
  UPDATE research_ingestion_runs
  SET
    llm_cost = llm_cost + p_cost_usd,
    llm_calls = llm_calls || jsonb_build_object(
      'provider', p_provider,
      'model', p_model,
      'inputTokens', p_input_tokens,
      'outputTokens', p_output_tokens,
      'costUsd', p_cost_usd,
      'latencyMs', p_latency_ms,
      'timestamp', now()
    )
  WHERE id = p_run_id;
$$ LANGUAGE sql SECURITY DEFINER;
```

### API: GET /api/research-brain/ingestion/runs

Query params: `status`, `limit` (default 20, max 100), `offset`
Response: `{ runs: IngestionRun[], total: number, limit: number, offset: number }`

### API: POST /api/research-brain/ingestion/runs/:id/cancel

Response 200: `{ runId, status: "cancelled", cancelledAt }`
Response 409: `{ error: "Cannot cancel completed run" }`

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | LLM cost calculation | `bun test` with known token counts → expected USD |
| Unit | recordLlmCall RPC | Direct postgres call with mock |
| Integration | New endpoints with auth | `bun test` using `supertest` against live routes |
| Integration | WebSocket run:* subscription | Connect WS client, enqueue job, assert notification received |
| E2E | Cancel flow | Start run, cancel, verify cancelled_at set, worker stops enqueuing |

## Migration / Rollout

No phased rollout needed. Migration is additive (new columns with defaults). Existing code continues working; `llm_cost` defaults to 0, `llm_calls` defaults to `[]`.

## Open Questions

- [ ] Should `cancelled_at` also mark the run status as `cancelled`, or keep status as `running` until workers drain? Spec says set status to `cancelled`. Clarify: workers check `cancelled_at` not status.
- [ ] LLM pricing table — hardcode known prices (OpenAI $0.003/1K in, $0.012/1K out) or make configurable via env? Recommend env var `LLM_PRICING_OPENAI_GPT4O_INPUT` / `LLM_PRICING_OPENAI_GPT4O_OUTPUT`.