/**
 * BullMQ Job Types for Chat and Deep Research Queues
 *
 * These types define the data structures for jobs enqueued to BullMQ.
 * Job data must be serializable (no File objects, only IDs/references).
 */

import type { AuthMethod } from "../../types/auth";

/**
 * Job data for chat queue
 * Sent to /api/chat, processed by chat worker
 */
export interface ChatJobData {
  // Request context
  userId: string;
  conversationId: string;
  messageId: string;
  message: string;

  // Auth context (preserved for worker processing)
  authMethod: AuthMethod;

  // File references (files uploaded before enqueue, stored in conversationState)
  fileIds?: string[];

  // Metadata
  requestedAt: string;
}

/**
 * Job data for deep research queue
 * Sent to /api/deep-research/start, processed by deep-research worker
 *
 * Architecture: Iteration-per-job
 * Each job executes exactly ONE iteration. If the research should continue,
 * the worker enqueues the next iteration as a new job. This provides:
 * - Atomic iterations (either fully complete or never started)
 * - Better graceful shutdown (each job ~5-10 min instead of 20+ min)
 * - Natural retry on failure (no partial state to rollback)
 */
export interface DeepResearchJobData {
  // Same core fields as ChatJobData
  userId: string;
  conversationId: string;
  messageId: string; // The message THIS iteration writes to
  rootMessageId?: string; // Root user message for the full deep research session
  message: string;
  authMethod: AuthMethod;
  fileIds?: string[];
  requestedAt: string;

  // Deep research specific
  stateId: string;
  conversationStateId: string;

  // Research mode - determines iteration behavior
  // 'semi-autonomous' (default): Uses MAX_AUTO_ITERATIONS env var (default 5)
  // 'fully-autonomous': Continues until research is done or hard cap of 20 iterations
  // 'steering': Single iteration only, always asks user for feedback
  researchMode?: "semi-autonomous" | "fully-autonomous" | "steering";

  // Iteration tracking (for job chaining)
  iterationNumber: number; // 1, 2, 3... (starts at 1)
  rootJobId?: string; // Original job ID for tracking the chain
  isInitialIteration: boolean; // true for first iteration (runs planning), false for continuations (uses promoted tasks)
}

/**
 * Job progress tracking
 * Used with job.updateProgress() for real-time updates
 */
export interface JobProgress {
  stage: string;
  percent: number;
  message?: string;
}

/**
 * Result returned by chat worker on completion
 */
export interface ChatJobResult {
  text: string;
  userId: string;
  responseTime: number;
}

/**
 * Result returned by deep research worker on completion
 */
export interface DeepResearchJobResult {
  messageId: string;
  status: "completed" | "failed";
  responseTime: number;
}

/**
 * Job data for file process queue
 * Processes uploaded files (generates description, updates state)
 */
export interface FileProcessJobData {
  fileId: string;
  userId: string;
  conversationId: string;
  conversationStateId: string;
  s3Key: string;
  filename: string;
  contentType: string;
  size: number;
}

/**
 * Result returned by file process worker on completion
 */
export interface FileProcessJobResult {
  fileId: string;
  description: string;
}

/**
 * Job data for paper generation queue
 * Sent to /api/deep-research/conversations/:id/paper/async, processed by paper-generation worker
 */
export interface PaperGenerationJobData {
  paperId: string;
  userId: string;
  conversationId: string;
  authMethod: AuthMethod;
  requestedAt: string;
}

/**
 * Result returned by paper generation worker on completion
 */
export interface PaperGenerationJobResult {
  paperId: string;
  conversationId: string;
  pdfPath: string;
  pdfUrl?: string;
  rawLatexUrl?: string;
  status: "completed" | "failed";
  error?: string;
  responseTime: number;
}

/**
 * Paper generation progress stages
 */
export type PaperGenerationStage =
  | "validating"
  | "metadata"
  | "figures"
  | "discoveries"
  | "bibliography"
  | "latex_assembly"
  | "compilation"
  | "upload"
  | "cleanup";

/**
 * Notification types sent via Redis Pub/Sub
 */
export type NotificationType =
  | "job:started"
  | "job:progress"
  | "job:completed"
  | "job:failed"
  | "message:updated"
  | "state:updated"
  | "file:ready"
  | "file:error"
  | "paper:started"
  | "paper:progress"
  | "paper:completed"
  | "paper:failed"
  | "ingestion:started"
  | "ingestion:progress"
  | "ingestion:completed"
  | "ingestion:failed"
  | "agent:source_completed";

/**
 * Job data for document ingestion queue
 * Processes a single file: parse, chunk, embed, register with research brain
 */
export interface DocumentIngestionJobData {
  runId: string;
  filePath: string;
  options: {
    force?: boolean;
    extractBioprospecting?: boolean;
  };
}

/**
 * Result returned by document ingestion worker on completion
 */
export interface DocumentIngestionJobResult {
  filePath: string;
  status: "processed" | "skipped" | "failed";
  chunksInserted?: number;
  sourceId?: string;
  error?: string;
}

/**
 * Job data for bioprospecting queue
 * Extracts bioprospecting facts from a processed source
 */
export interface BioprospectingJobData {
  runId: string;
  sourceId: string;
  options?: {
    maxChunks?: number;
    batchSize?: number;
  };
}

/**
 * Job data for compound-authority queue
 * A scheduled tick that drives the PubChem backfill pass. The job
 * carries no per-tick data — the worker reads the eligible fact set
 * from the DB on each invocation. Kept as an explicit interface
 * (rather than `{}`) so future enhancements (e.g. forcing a specific
 * subset) can be added without breaking BullMQ's repeat registration.
 */
export type CompoundAuthorityJobData = Record<string, never>;

/**
 * Result returned by the compound-authority worker on completion.
 * Mirrors the design's "run summary" log line; the worker emits this
 * as a structured logger event so operators can grep
 * `compound_authority_run_summary` during rollout.
 *
 * `capHit` is set when the worker aborts cleanly on a daily/monthly
 * cost cap; the operator can see why facts were not resolved this
 * cycle. Values mirror the `api-cost-guard-rails` spec scope enum.
 */
export type CompoundAuthorityJobResult = {
  scannedFacts: number;
  aliasHits: number;
  pubchemHits: number;
  pubchemMisses: number;
  retriesScheduled: number;
  failed: number;
  elapsed: number;
  capHit?: "day" | "month";
};

/**
 * Job data for the discovery-reeval queue.
 * A scheduled tick that drives the "is this discovery still alive?"
 * pass. v1 (this PR) is LLM-free — the verdict is derived from SQL
 * joins against the existing fact and contradiction tables. The job
 * carries no per-tick data; the worker pulls the due set from the
 * DB. Kept as an explicit interface so future enhancements (e.g.
 * forcing a specific discovery or a forced full re-eval) can be
 * added without breaking BullMQ's repeat registration.
 */
export type DiscoveryReevalJobData = Record<string, never>;

/**
 * Result returned by the discovery-reeval worker on completion.
 * Mirrors the `ReevalRunSummary` shape from
 * `services/researchBrain/discoveryReeval.ts`. The worker emits
 * this as a structured logger event under the name
 * `discovery_reeval_run_summary` so operators can grep during
 * rollout.
 *
 * `pendingRetained` is the count of due rows that were claimed
 * (`* -> pending`) but the verdict write failed. They stay in
 * `pending` until the next tick; this is how the system
 * self-heals from transient DB errors without manual
 * intervention.
 */
export type DiscoveryReevalJobResult = {
  scanned: number;
  clean: number;
  extended: number;
  contradicted: number;
  errors: number;
  pendingRetained: number;
  elapsed: number;
};

/**
 * Job data for contradiction detection (manual re-run via queue).
 * Same queue as bioprospecting; worker routes by shape detection.
 * If maxChunks/batchSize are absent, it's a contradiction detection job.
 */
export interface ContradictionDetectionJobData {
  runId: string;
  sourceId: string;
  options?: {
    force?: boolean;
  };
}

/**
 * Ingestion notification types sent via Redis Pub/Sub
 */
export type IngestionNotificationType =
  | "ingestion:started"
  | "ingestion:progress"
  | "ingestion:completed"
  | "ingestion:failed"
  | "run:llm_call"
  | "run:api_call"
  | "run:cancelled";

/**
 * Ingestion progress notification payload
 */
export interface IngestionProgressNotification {
  type: IngestionNotificationType;
  runId: string;
  filePath?: string;
  status?: "processing" | "processed" | "skipped" | "failed";
  progress?: {
    processed: number;
    skipped: number;
    failed: number;
    total: number;
  };
  error?: string;
  llmCost?: number;
  llmCallsCount?: number;
  apiCost?: number;
  apiCallsCount?: number;
}

/**
 * Notification payload structure
 * Sent from workers to API server via Redis Pub/Sub
 */
export interface Notification {
  type: NotificationType;
  jobId: string;
  conversationId: string;
  messageId?: string;
  stateId?: string;
  fileId?: string;
  paperId?: string;
  runId?: string;
  progress?: { stage: string; percent: number };
  description?: string;
  error?: string;
  /**
   * Per-source provenance payload (only present on agent:source_completed).
   * Lets the UI render a real-time per-source evidence panel even before
   * the full task completes.
   */
  source?: {
    /** Matches LiteratureType: OPENSCHOLAR | KNOWLEDGE | EDISON | BIOLIT | BIOLITDEEP */
    sourceName: "OPENSCHOLAR" | "KNOWLEDGE" | "EDISON" | "BIOLIT" | "BIOLITDEEP";
    /** "ok" | "empty" | "failed" — see LiteratureSourceStatus */
    status: "ok" | "empty" | "failed";
    /** Number of papers/chunks returned (0 when status !== "ok"). */
    count: number;
    /** Wall-clock duration in ms. Always recorded. */
    durationMs: number;
    /** Human-readable error message when status === "failed". */
    error?: string;
    /** Iteration number inside the deep-research run (1-based). */
    iteration: number;
  };
}
