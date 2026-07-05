# Delta for research-brain

## ADDED Requirements

### Requirement: Document Ingestion Worker Pool

The system MUST replace the sequential `ingestDirectory()` method in `VectorSearchWithDocuments` with a BullMQ-based worker pool that processes document files in parallel.

The system SHALL operate two separate queues:
- `document-ingestion`: handles parse, chunk, and embed operations per file
- `bioprospecting`: handles downstream LLM extraction as a separate job type

#### Scenario: Happy path — all files processed successfully

- GIVEN a directory with 10 PDF files and `USE_JOB_QUEUE=true`
- WHEN a user calls `POST /api/research-brain/ingestion/start` with `{ "docsPath": "/data/papers" }`
- THEN the system creates a `research_ingestion_runs` record with status `running`
- AND enqueues 10 `DocumentIngestionJobData` jobs to the `document-ingestion` queue
- AND each worker processes files concurrently up to `DOCUMENT_INGESTION_CONCURRENCY` limit
- AND upon completion, run status is `completed` with accurate file counts

#### Scenario: Partial failure — some files fail after 3 retries

- GIVEN a directory with 5 files where 2 are corrupted
- WHEN processing completes with 3 succeeded and 2 failed
- THEN run status is `completed_with_errors`
- AND failed files are marked individually in `research_ingestion_runs`
- AND `extractBioprospectingFactsForSource` is NOT called for failed sources

#### Scenario: Full failure — directory not accessible

- GIVEN a non-existent or inaccessible `docsPath`
- WHEN the ingestion start endpoint is called
- THEN the system returns HTTP 400 with `{ "error": "Directory not accessible" }`
- AND no run record is created

### Requirement: Document Ingestion Job Data

The system MUST use the following job data structure for `document-ingestion` queue:

```typescript
interface DocumentIngestionJobData {
  runId: string;           // links to research_ingestion_runs.id
  filePath: string;        // absolute path
  options: {
    force?: boolean;       // skip dedupe check
    extractBioprospecting?: boolean; // enqueue bioprospecting job if true
  };
}

interface DocumentIngestionJobResult {
  filePath: string;
  status: "processed" | "skipped" | "failed";
  chunksInserted?: number;
  sourceId?: string;
  error?: string;
}
```

#### Scenario: Job with bioprospecting extraction

- GIVEN a file `/data/papers/seaweed-study.pdf` and `extractBioprospecting: true`
- WHEN the document-ingestion job completes successfully
- THEN the worker enqueues a `BioprospectingJobData` job to the `bioprospecting` queue
- AND the bioprospecting job references the newly created `sourceId`

### Requirement: Bioprospecting Job Data

The system MUST use the following job data structure for `bioprospecting` queue:

```typescript
interface BioprospectingJobData {
  runId: string;
  sourceId: string;
  options?: {
    maxChunks?: number;
    batchSize?: number;
  };
}
```

### Requirement: Queue Configuration

The system MUST configure BullMQ queues with the following settings:

| Queue | Default Concurrency | Retry Attempts | Backoff |
|-------|---------------------|----------------|---------|
| `document-ingestion` | 2 (via `DOCUMENT_INGESTION_CONCURRENCY`) | 3 | exponential 1s→2s→4s |
| `bioprospecting` | 1 (via `BIOPROSPECTING_CONCURRENCY`) | 3 | exponential 1s→2s→4s |

PDF parsing concurrency is controlled separately via `PDF_PARSE_CONCURRENCY` (default 1).

#### Scenario: Queue initialization when job queue is disabled

- GIVEN `USE_JOB_QUEUE=false`
- WHEN any queue getter function is called
- THEN the function MUST throw `Error("Job queue is not enabled")` matching existing pattern for other queues

### Requirement: Worker Behavior — Document Ingestion

The document-ingestion worker MUST process a single file as follows:

1. Validate file exists and is accessible
2. Check dedupe via `loadExistingDocumentIdentity()` unless `force: true`
3. Process file via `DocumentProcessor.processFile()`
4. Chunk document via `TextChunker.chunkDocument()`
5. Insert chunks via `addChunkBatchForDocument()`
6. Register with Research Brain via `registerInsertedChunksWithResearchBrain()`
7. If `extractBioprospecting: true`, enqueue bioprospecting job
8. Update `research_ingestion_runs` counters atomically
9. Emit progress notification via Redis Pub/Sub

#### Scenario: Worker skips known document

- GIVEN a file whose title, path, and content_hash all exist in the database
- WHEN the worker processes the file
- THEN status is `skipped` and chunks are NOT re-inserted
- AND `skipped_files` counter is incremented

### Requirement: Retry Behavior

Failed jobs MUST be retried up to 3 times with exponential backoff (1s → 2s → 4s).

After all retries are exhausted:
- The worker MUST update `research_ingestion_runs` to increment `failed_files`
- The worker MUST publish a `job:failed` notification with error details
- The run status MUST be updated to `completed_with_errors` if not already terminal
- Processing of other files MUST continue (no hard stop)

#### Scenario: Retry exhaustion on transient error

- GIVEN a file that fails 3 times due to a temporary database connection issue
- WHEN the third retry also fails
- THEN the job is marked as failed
- AND `failed_files` in the run is incremented
- AND other files continue processing

### Requirement: Progress Tracking

The system MUST track progress per-file and per-run in `research_ingestion_runs`:

- `total_files`: set when run is created (count of discovered files)
- `processed_files`: incremented atomically when a job completes with `status: "processed"`
- `skipped_files`: incremented atomically when a job completes with `status: "skipped"`
- `failed_files`: incremented atomically when a job exhausts all retries

The system SHOULD emit real-time progress via Redis Pub/Sub with the following notification structure:

```typescript
interface IngestionProgressNotification {
  type: "ingestion:progress";
  runId: string;
  filePath: string;
  status: "processing" | "processed" | "skipped" | "failed";
  progress?: { processed: number; skipped: number; failed: number; total: number };
  error?: string;
}
```

#### Scenario: Real-time progress during large ingestion

- GIVEN a run with 100 files currently processing
- WHEN file #50 completes successfully
- THEN a notification is published with `{ type: "ingestion:progress", runId: "...", status: "processed", progress: { processed: 50, skipped: 0, failed: 0, total: 100 } }`

### Requirement: Ingestion API Endpoints

The system MUST expose the following endpoints under `/api/research-brain/ingestion`:

#### `POST /api/research-brain/ingestion/start`

Starts a new ingestion run.

**Request:**
```json
{
  "docsPath": "/absolute/path/to/docs",
  "options": {
    "force": false,
    "extractBioprospecting": true
  }
}
```

**Response (202 Accepted):**
```json
{
  "runId": "uuid",
  "status": "running",
  "totalFiles": 25
}
```

#### `GET /api/research-brain/ingestion/runs/:id`

Returns run status with aggregate progress.

**Response:**
```json
{
  "runId": "uuid",
  "docsPath": "/data/papers",
  "status": "running | completed | completed_with_errors | failed",
  "totalFiles": 25,
  "processedFiles": 20,
  "skippedFiles": 3,
  "failedFiles": 2,
  "startedAt": "2026-06-08T10:00:00Z",
  "finishedAt": null
}
```

#### `GET /api/research-brain/ingestion/runs/:id/files`

Returns per-file status list.

**Response:**
```json
{
  "runId": "uuid",
  "files": [
    { "filePath": "/data/papers/a.pdf", "status": "processed", "chunksInserted": 12, "sourceId": "uuid" },
    { "filePath": "/data/papers/b.pdf", "status": "skipped", "reason": "already exists" },
    { "filePath": "/data/papers/c.pdf", "status": "failed", "error": "PDF parse error" }
  ]
}
```

#### `POST /api/research-brain/ingestion/runs/:id/retry-failed`

Retries all files that previously failed.

**Response (202 Accepted):**
```json
{
  "runId": "uuid",
  "retriedFiles": 2,
  "status": "running"
}
```

### Requirement: Environment Variables

The system MUST support the following environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCUMENT_INGESTION_CONCURRENCY` | 2 | Worker concurrency for document-ingestion queue |
| `PDF_PARSE_CONCURRENCY` | 1 | Concurrent PDF parse operations |
| `BIOPROSPECTING_CONCURRENCY` | 1 | Worker concurrency for bioprospecting queue |

### Requirement: Database Changes

The system MUST add the following column to `research_ingestion_runs` to support per-file tracking:

```sql
ALTER TABLE public.research_ingestion_runs
  ADD COLUMN IF NOT EXISTS file_statuses JSONB NOT NULL DEFAULT '[]';
```

This column stores an array of per-file status objects:
```json
[
  { "filePath": "/data/papers/a.pdf", "status": "processed", "chunksInserted": 12, "sourceId": "uuid" },
  { "filePath": "/data/papers/b.pdf", "status": "failed", "error": "PDF parse error", "attempts": 3 }
]
```

The system SHOULD add an index for efficient status queries:
```sql
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_status ON public.research_ingestion_runs (status);
```

### Requirement: Real-time Notifications via Redis Pub/Sub

The system MUST emit the following notification types for ingestion events:

- `ingestion:started` — when a run begins
- `ingestion:progress` — per-file completion
- `ingestion:completed` — when run completes (all files processed or failed)
- `ingestion:failed` — when run fails entirely

Notifications MUST be published using the existing `publishNotification()` pattern from `src/services/queue/notify.ts`.

#### Scenario: WebSocket client receives real-time progress

- GIVEN a WebSocket client subscribed to a run's progress
- WHEN file processing completes
- THEN the client receives a notification with `type: "ingestion:progress"` and updated counts

## MODIFIED Requirements

### Requirement: VectorSearchWithDocuments.ingestDirectory — Sequential to Parallel

The `ingestDirectory()` method in `VectorSearchWithDocuments` SHALL be modified to:
1. Create a `research_ingestion_runs` record (already implemented)
2. List all files in the directory (already implemented)
3. Enqueue each file as a separate `DocumentIngestionJobData` job to the `document-ingestion` queue
4. Return immediately with runId and preliminary counts (do NOT wait for completion)

(Previously: Sequential for-loop processing each file to completion before moving to next)

#### Scenario: Backward compatibility for in-process mode

- GIVEN `USE_JOB_QUEUE=false`
- WHEN `ingestDirectory()` is called
- THEN the system SHOULD fall back to the original sequential processing behavior
- OR return an error indicating job queue mode is required for this operation

### Requirement: loadDocsOnStartup — Worker Pool Integration

The `loadDocsOnStartup()` method SHALL continue to call `ingestDirectory()` but the behavior depends on `USE_JOB_QUEUE`:
- If `USE_JOB_QUEUE=true`: jobs are enqueued and processed by workers asynchronously
- If `USE_JOB_QUEUE=false`: sequential processing (existing behavior)

(Previously: Always sequential, blocking until all files processed)

## REMOVED Requirements

### Requirement: Sequential File Processing Loop

The sequential `for (const filePath of files)` loop inside `ingestDirectory()` that processes each file one-by-one is REMOVED.

(Reason: Replaced by BullMQ worker pool for parallel processing. Migration: Existing calls to `ingestDirectory()` work unchanged — the BullMQ layer handles parallelization transparently when `USE_JOB_QUEUE=true`.)

### Requirement: Per-File Blocking Updates

The inline per-file `await this.updateIngestionRun(runId, {...})` calls during processing are REMOVED from the hot path.

(Reason: Progress updates are now handled by the worker upon job completion. Migration: Workers update run progress asynchronously via the queue job handler.)