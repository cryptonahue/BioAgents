# Tasks: Document Ingestion Worker Pool

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 600-900 |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Foundation (types, queues, notify, migration) | PR 1 | Base work for workers and API |
| 2 | Workers (document-ingestion, bioprospecting) | PR 2 | Depends on PR 1 |
| 3 | API routes + CLI integration | PR 3 | Depends on PR 2 |

## Phase 1: Foundation (types, queues, notify, migration)

- [x] 1.1 Add job types to `src/services/queue/types.ts`: `DocumentIngestionJobData`, `DocumentIngestionJobResult`, `BioprospectingJobData`, `IngestionProgressNotification`, and `IngestionNotificationType` union
- [x] 1.2 Add notification types to `NotificationType` union in `src/services/queue/types.ts`: `ingestion:started`, `ingestion:progress`, `ingestion:completed`, `ingestion:failed`
- [x] 1.3 Add queue getters to `src/services/queue/queues.ts`: `getDocumentIngestionQueue()` and `getBioprospectingQueue()` with 3 retries, exponential backoff 1s→2s→4s; throw on `!isJobQueueEnabled()`
- [x] 1.4 Add notification helpers to `src/services/queue/notify.ts`: `notifyIngestionStarted()`, `notifyIngestionProgress()`, `notifyIngestionCompleted()`, `notifyIngestionFailed()` — use `runId` not `conversationId` for channel routing
- [x] 1.5 Create Supabase migration `supabase/migrations/<timestamp>_add_file_statuses_jsonb.sql` adding `file_statuses JSONB NOT NULL DEFAULT '[]'` and index `idx_ingestion_runs_status` on `status`

## Phase 2: Workers (document-ingestion, bioprospecting)

- [x] 2.1 Create `src/services/queue/workers/document-ingestion.worker.ts` — replicate `file-process.worker.ts` pattern; concurrency from `DOCUMENT_INGESTION_CONCURRENCY` (default 2); lockDuration 120000; processFile→chunk→addChunks→registerWithResearchBrain→enqueueBioprospecting if needed→atomic counter update→notify
- [x] 2.2 Create `src/services/queue/workers/bioprospecting.worker.ts` — concurrency from `BIOPROSPECTING_CONCURRENCY` (default 1); call `extractBioprospectingFactsForSource(sourceId)`; update run counters and notify on completion
- [x] 2.3 Register workers in `src/worker.ts`: import and start `createDocumentIngestionWorker()` and `createBioprospectingWorker()`; add to graceful shutdown handler

## Phase 3: API Routes (ingestion endpoints)

- [x] 3.1 Add `POST /api/research-brain/ingestion/start` — validate `docsPath`, create run record (status=running, total_files=count), enqueue N `DocumentIngestionJobData` jobs, return `{runId, status, totalFiles}`
- [x] 3.2 Add `GET /api/research-brain/ingestion/runs/:id` — return run status with aggregate progress from `research_ingestion_runs`
- [x] 3.3 Add `GET /api/research-brain/ingestion/runs/:id/files` — return per-file status list from `file_statuses` JSONB column
- [x] 3.4 Add `POST /api/research-brain/ingestion/runs/:id/retry-failed` — filter `file_statuses` for failed entries, re-enqueue jobs, update run status to `running`

## Phase 4: CLI Integration (scripts/ingest-docs.ts refactor)

- [x] 4.1 Refactor `scripts/ingest-docs.ts` — when `USE_JOB_QUEUE=true`, import `getDocumentIngestionQueue()` and enqueue jobs instead of calling `ingestDirectory()`; when `USE_JOB_QUEUE=false`, keep existing direct call behavior

## Phase 5: Testing and Validation

- [x] 5.1 Write unit test for `DocumentIngestionJobData` serialization and queue enqueue behavior
- [x] 5.2 Write unit test for worker dedupe logic (skip known documents via `loadExistingDocumentIdentity()` mock)
- [x] 5.3 Write integration test for full flow: start run → enqueue → process → notify
- [ ] 5.4 Verify API endpoints with `bun test` using temp directory fixture
- [ ] 5.5 Run existing tests to ensure no regressions in `vectorSearchWithDocs.ts` and `research-brain.ts`

## Implementation Notes

- Workers follow `file-process.worker.ts` pattern: constructor with `connection`, `concurrency`, `lockDuration`; event handlers for `completed`, `failed`, `error`
- Job data types must be serializable (no File objects — only `runId`, `filePath`, `options`)
- Atomic counter updates use Supabase `update()` on `research_ingestion_runs` by `runId`
- Notification channel pattern: `run:${runId}` (not `conversation:${conversationId}`)
- Environment variables to validate: `DOCUMENT_INGESTION_CONCURRENCY` (default 2), `BIOPROSPECTING_CONCURRENCY` (default 1)
