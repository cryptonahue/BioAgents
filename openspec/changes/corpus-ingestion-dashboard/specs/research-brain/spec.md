# Delta for research-brain

## ADDED Requirements

### Requirement: Ingestion Run Listing API

The system MUST expose `GET /api/research-brain/ingestion/runs` to list recent ingestion runs with pagination and filtering.

**Query Parameters:**
- `status` (optional): Filter by `running`, `completed`, `failed`, `cancelled`
- `limit` (optional): Number of results, default 20, max 100
- `offset` (optional): Pagination offset

**Response:**
```json
{
  "runs": [
    {
      "runId": "uuid",
      "docsPath": "/data/papers",
      "status": "running",
      "totalFiles": 25,
      "processedFiles": 20,
      "skippedFiles": 3,
      "failedFiles": 2,
      "llmCost": 0.45,
      "startedAt": "2026-06-08T10:00:00Z",
      "finishedAt": null,
      "cancelledAt": null
    }
  ],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

#### Scenario: List last 20 runs with running filter

- GIVEN admin user is authenticated
- WHEN GET `/api/research-brain/ingestion/runs?status=running` is called
- THEN returns runs with status `running` only, up to 20 results

#### Scenario: Empty result with no matching runs

- GIVEN no runs match the filter criteria
- WHEN the endpoint is called
- THEN returns `{ "runs": [], "total": 0, "limit": 20, "offset": 0 }`

### Requirement: Run Cancellation API

The system MUST expose `POST /api/research-brain/ingestion/runs/:id/cancel` to cancel an in-progress run.

**Response (200 OK):**
```json
{
  "runId": "uuid",
  "status": "cancelled",
  "cancelledAt": "2026-06-08T10:15:00Z"
}
```

The system MUST:
1. Set `cancelled_at` timestamp on the run record
2. Set run `status` to `cancelled`
3. Signal workers to stop enqueuing new jobs for this run
4. Allow currently processing jobs to complete gracefully

#### Scenario: Cancel a running ingestion

- GIVEN a run with `status: "running"` and 10 files in queue
- WHEN POST `/api/research-brain/ingestion/runs/:id/cancel` is called
- THEN run status becomes `cancelled`
- AND `cancelled_at` is set to current timestamp
- AND workers stop enqueuing new jobs for this run
- AND currently processing jobs complete normally

#### Scenario: Cancel already completed run

- GIVEN a run with `status: "completed"`
- WHEN POST `/api/research-brain/ingestion/runs/:id/cancel` is called
- THEN returns HTTP 409 Conflict with `{ "error": "Cannot cancel completed run" }`

### Requirement: LLM Cost Tracking

The system MUST track LLM usage and cost for each ingestion run.

**Database columns on `research_ingestion_runs`:**
- `llm_cost` (NUMERIC(10,6)): Accumulated USD cost estimate, updated atomically
- `llm_calls` (JSONB): Array of per-call log entries

**LLM call log entry structure:**
```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "inputTokens": 1500,
  "outputTokens": 350,
  "costUsd": 0.0235,
  "latencyMs": 890,
  "timestamp": "2026-06-08T10:00:00Z"
}
```

The system SHOULD calculate cost using provider-specific pricing (e.g., OpenAI $0.003/1K input tokens, $0.012/1K output tokens).

#### Scenario: LLM call cost accumulation

- GIVEN a running ingestion with `llm_cost: 0.10` and `llm_calls: []`
- WHEN a bioprospecting LLM call costs $0.0235
- THEN the worker's post-call handler atomically increments `llm_cost` to `0.1235`
- AND appends the call log entry to `llm_calls` array

#### Scenario: Run completion with full cost summary

- GIVEN a run that used 3 LLM calls totaling $0.067
- WHEN the run transitions to `completed`
- THEN `llm_cost` reflects the final accumulated value
- AND `llm_calls` contains all 3 call entries

### Requirement: WebSocket Run Channel Subscriptions

The system MUST extend the WebSocket subscription handler to support `run:{runId}` channels for real-time run progress.

**Subscribe message:**
```json
{ "action": "subscribe", "channel": "run:uuid-here" }
```

**Notification format:**
```json
{
  "type": "run:progress",
  "runId": "uuid",
  "status": "running",
  "processedFiles": 20,
  "totalFiles": 25,
  "llmCost": 0.45,
  "llmCallsCount": 12
}
```

The system MUST emit `run:progress` notifications on:
- File completion (processed/skipped/failed)
- LLM call completion (cost update)
- Run status change (completed/failed/cancelled)

#### Scenario: Client subscribes to run channel

- GIVEN a WebSocket client connected to `/ws`
- WHEN client sends `{ "action": "subscribe", "channel": "run:abc-123" }`
- THEN server confirms subscription with `{ "type": "subscribed", "channel": "run:abc-123" }`
- AND client receives real-time progress updates

#### Scenario: WebSocket disconnect and reconnect

- GIVEN a client was subscribed to `run:abc-123` and disconnects
- WHEN the client reconnects and resubscribes to `run:abc-123`
- THEN the client receives the current run state via REST API
- AND continues receiving real-time updates from the reconnection point

### Requirement: CorpusDashboardPage

The system MUST provide a dashboard page at `/corpus` with the following components:

**Run Selector:**
- Dropdown listing last 20 runs (most recent first)
- Filter buttons: All | Running | Completed | Failed | Cancelled
- Selected run highlighted

**IngestionProgressBar:**
- Displays processed/total with percentage
- Visual progress bar with color coding (green: running, blue: completed, red: failed)

**IngestionMetricsBar:**
- Speed: files/minute calculated over last minute
- Failure rate: `(failed / total) * 100%`
- Total cost: `$` + accumulated `llm_cost`
- Elapsed time: `HH:MM:SS` since run start

**IngestionFileList:**
- Sortable table with columns: File Path, Status, Chunks, Source ID, Error
- Status icons: ✓ processed, ⊘ skipped, ✗ failed, ⟳ processing
- Filter by status
- Search by file path

**IngestionActions:**
- "Retry Failed" button (enabled when run has failed files)
- "Cancel Run" button (enabled when run is running)
- Confirmation dialog before destructive actions

#### Scenario: View running ingestion dashboard

- GIVEN a user navigates to `/corpus` with an active ingestion running
- THEN the dashboard shows the running run pre-selected
- AND progress bar updates in real-time via WebSocket
- AND metrics show current speed, cost, and elapsed time

#### Scenario: Empty state with no runs

- GIVEN no ingestion runs exist
- WHEN user navigates to `/corpus`
- THEN display message: "No ingestion runs yet. Start one by uploading documents to your research brain."
- AND the run selector shows empty state

### Requirement: Admin Authorization for Dashboard Endpoints

All dashboard API endpoints MUST require admin role authentication.

**Required on all new endpoints:**
- `GET /api/research-brain/ingestion/runs`
- `POST /api/research-brain/ingestion/runs/:id/cancel`

**Existing endpoints requiring updated auth:**
- `GET /api/research-brain/ingestion/runs/:id` (add llm_cost to response)
- `GET /api/research-brain/ingestion/runs/:id/files` (unchanged behavior)

All endpoints MUST use `authResolver({ required: true, role: 'admin' })`.

#### Scenario: Non-admin user denied access

- GIVEN a user without admin role
- WHEN any dashboard endpoint is called
- THEN returns HTTP 403 with `{ "error": "Admin role required" }`

### Requirement: Database Schema Changes

The system MUST add the following columns to `research_ingestion_runs`:

```sql
ALTER TABLE public.research_ingestion_runs
  ADD COLUMN IF NOT EXISTS llm_cost NUMERIC(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS llm_calls JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_status ON public.research_ingestion_runs (status);
```

**`llm_cost`**: Accumulated USD estimate across all LLM calls for this run
**`llm_calls`**: JSONB array of per-call log entries (provider, model, tokens, cost, latency, timestamp)
**`cancelled_at`**: Timestamp when run was cancelled (null if not cancelled)

## MODIFIED Requirements

### Requirement: Ingestion API Endpoints

The `GET /api/research-brain/ingestion/runs/:id` endpoint SHALL include `llm_cost` and `llm_calls_count` in the response:

**Response:**
```json
{
  "runId": "uuid",
  "docsPath": "/data/papers",
  "status": "completed",
  "totalFiles": 25,
  "processedFiles": 22,
  "skippedFiles": 1,
  "failedFiles": 2,
  "llmCost": 0.067,
  "llmCallsCount": 8,
  "startedAt": "2026-06-08T10:00:00Z",
  "finishedAt": "2026-06-08T10:15:00Z"
}
```

(Previously: Response did not include llm_cost or llm_calls_count)

#### Scenario: Get run with full metrics

- GIVEN a completed run with accumulated LLM costs
- WHEN GET `/api/research-brain/ingestion/runs/:id` is called
- THEN response includes `llmCost` and `llmCallsCount` fields

### Requirement: Real-time Notifications via Redis Pub/Sub

The system MUST emit additional notification types for the dashboard:

- `run:progress` — aggregated run progress (processed, failed, cost updates)
- `run:llm_call` — individual LLM call completed with cost details
- `run:cancelled` — run was cancelled

(Previously: Only ingestion:started, ingestion:progress, ingestion:completed, ingestion:failed were defined)

#### Scenario: LLM call notification on bioprospecting extraction

- GIVEN a bioprospecting job completes an LLM call
- WHEN the call finishes
- THEN `run:llm_call` notification is published with cost and latency
- AND `run:progress` is published with updated total cost