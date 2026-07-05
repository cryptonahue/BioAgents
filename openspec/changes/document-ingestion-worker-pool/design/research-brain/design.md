# Design: Document Ingestion Worker Pool

## Technical Approach

Replace the sequential `for` loop in `VectorSearchWithDocuments.ingestDirectory()` with a BullMQ worker pool that processes files in parallel. The pattern mirrors `file-process.worker.ts` — each file becomes a job enqueued to a dedicated `document-ingestion` queue, with workers updating run progress atomically via Supabase.

## Architecture Decisions

### Decision: Two-queue architecture (document-ingestion + bioprospecting)

**Choice**: Separate queues for file processing and bioprospecting extraction.
**Alternatives**: Single queue with job type discrimination; inline bioprospecting in document worker.
**Rationale**: Bioprospecting is I/O-bound LLM calls with different concurrency needs (default 1) vs document processing (default 2). Separate queues allow independent scaling and retry policies.

### Decision: Per-file JSONB status array in existing table

**Choice**: Add `file_statuses JSONB NOT NULL DEFAULT '[]'` column to `research_ingestion_runs`.
**Alternatives**: New `research_ingestion_file_status` table with foreign key.
**Rationale**: Single atomic update per file avoids JOIN complexity; JSONB array matches the spec's proposed structure and enables efficient progress queries with `->`.

### Decision: Sequential fallback when `USE_JOB_QUEUE=false`

**Choice**: `ingestDirectory()` throws `Error("Job queue is not enabled")` when queue mode is disabled.
**Alternatives**: Reimplement sequential processing as fallback.
**Rationale**: The spec explicitly requires this behavior. Production deployments should use queue mode; development can use sequential via direct `VectorSearchWithDocuments` instantiation.

## Data Flow

```
API Server                      Workers (separate process)
     │                                   │
     ▼                                   │
POST /start ──► Create run record ──► Enqueue N jobs
                    (status=running)      │
                    (total_files=N)       │
                                          ▼
                               Worker pool (concurrency=2)
                                          │
         ┌───────────────────────────────┼───────────────────────────────┐
         │                               │                               │
         ▼                               ▼                               ▼
    File A job                      File B job                      File C job
    (parse+chunk+embed)            (parse+chunk+embed)            (parse+chunk+embed)
         │                               │                               │
         └───────────────────────────────┼───────────────────────────────┘
                                         │
                                         ▼
                              Atomic counter update:
                              processed_files +1, file_statuses += {file, status}
                                         │
                                         ▼ (if extractBioprospecting=true)
                              Enqueue BioprospectingJobData to bioprospecting queue
                                         │
                                         ▼
                              Redis Pub/Sub: ingestion:progress notification
                                         │
                                         ▼
                              WebSocket clients receive real-time updates
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/services/queue/queues.ts` | Modify | Add `getDocumentIngestionQueue()` and `getBioprospectingQueue()` |
| `src/services/queue/types.ts` | Modify | Add `DocumentIngestionJobData`, `DocumentIngestionJobResult`, `BioprospectingJobData`, `IngestionProgressNotification` |
| `src/services/queue/workers/document-ingestion.worker.ts` | Create | Worker processing single files; handles dedupe, parse, chunk, embed, bioprospecting enqueue |
| `src/services/queue/workers/bioprospecting.worker.ts` | Create | Worker for LLM-based extraction from processed sources |
| `src/services/queue/notify.ts` | Modify | Add `notifyIngestionStarted`, `notifyIngestionProgress`, `notifyIngestionCompleted`, `notifyIngestionFailed` helpers |
| `src/routes/research-brain.ts` | Modify | Add 4 ingestion endpoints under `/api/research-brain/ingestion/` |
| `src/embeddings/vectorSearchWithDocs.ts` | Modify | `ingestDirectory()` enqueues jobs instead of sequential loop |
| `src/worker.ts` | Modify | Register new workers; add graceful shutdown for document-ingestion and bioprospecting workers |
| `scripts/ingest-docs.ts` | Modify | Enqueue jobs when `USE_JOB_QUEUE=true`, else call `ingestDirectory()` directly |
| `supabase/migrations/` | Create | Add `file_statuses JSONB` column to `research_ingestion_runs` |

## Interfaces / Contracts

### Queue Definitions

```typescript
// In queues.ts
export function getDocumentIngestionQueue(): Queue<DocumentIngestionJobData, DocumentIngestionJobResult> {
  if (!isJobQueueEnabled()) {
    throw new Error("Job queue is not enabled");
  }
  // Returns queue with 3 retries, exponential backoff 1s→2s→4s
}

export function getBioprospectingQueue(): Queue<BioprospectingJobData, any> {
  if (!isJobQueueEnabled()) {
    throw new Error("Job queue is not enabled");
  }
  // Returns queue with 3 retries, exponential backoff 1s→2s→4s
}
```

### Job Data Types

```typescript
interface DocumentIngestionJobData {
  runId: string;
  filePath: string;
  options: {
    force?: boolean;
    extractBioprospecting?: boolean;
  };
}

interface DocumentIngestionJobResult {
  filePath: string;
  status: "processed" | "skipped" | "failed";
  chunksInserted?: number;
  sourceId?: string;
  error?: string;
}

interface BioprospectingJobData {
  runId: string;
  sourceId: string;
  options?: { maxChunks?: number; batchSize?: number };
}
```

### Pub/Sub Notifications

```typescript
type IngestionNotificationType =
  | "ingestion:started"
  | "ingestion:progress"
  | "ingestion:completed"
  | "ingestion:failed";

interface IngestionProgressNotification {
  type: "ingestion:progress";
  runId: string;
  filePath: string;
  status: "processing" | "processed" | "skipped" | "failed";
  progress?: { processed: number; skipped: number; failed: number; total: number };
  error?: string;
}
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/research-brain/ingestion/start` | Start ingestion run, returns `{runId, status, totalFiles}` |
| GET | `/api/research-brain/ingestion/runs/:id` | Get run status with aggregate progress |
| GET | `/api/research-brain/ingestion/runs/:id/files` | Get per-file status list |
| POST | `/api/research-brain/ingestion/runs/:id/retry-failed` | Retry failed files |

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `DocumentIngestionJobData` serialization | `bun test` with mock BullMQ |
| Unit | Worker dedupe logic (skip known docs) | Mock `loadExistingDocumentIdentity()` |
| Unit | Atomic counter updates | Mock Supabase client |
| Integration | Full flow: enqueue → process → notify | Test with Redis + Supabase |
| E2E | API endpoints with real files | `bun test` with temp directory |

## Migration / Rollout

1. Create Supabase migration adding `file_statuses JSONB` column
2. Deploy API server with new queue types (backward compatible)
3. Deploy workers with `createDocumentIngestionWorker()` and `createBioprospectingWorker()`
4. Existing `ingestDirectory()` calls continue working in sequential mode when `USE_JOB_QUEUE=false`
5. No data migration needed — `file_statuses` defaults to `[]`

## Open Questions

- [ ] Should `retry-failed` reset `failed_files` counter or keep it as cumulative?
- [ ] Do we need a TTL on `file_statuses` entries to prevent unbounded growth for very large runs?
- [ ] Should bioprospecting workers publish to a different Redis channel (e.g., `bioprospecting:progress`) or reuse `ingestion:*`?