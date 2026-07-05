/**
 * Notification Helper for BullMQ Workers
 *
 * Publishes notifications via Redis Pub/Sub to notify the API server
 * (and connected WebSocket clients) about job progress.
 *
 * Follows "Notify + Fetch" pattern:
 * - Notifications are lightweight (just type + IDs)
 * - UI fetches actual data via HTTP after notification
 */

import { getPublisher } from "./connection";
import type { Notification, NotificationType, IngestionProgressNotification } from "./types";
import logger from "../../utils/logger";

/**
 * Publish a notification to Redis Pub/Sub
 *
 * @param notification - The notification to publish
 *
 * Note: This function catches errors internally to avoid crashing workers
 * if Redis is temporarily unavailable. Notifications are best-effort.
 */
export async function notify(notification: Notification): Promise<void> {
  try {
    const publisher = getPublisher();
    const channel = `conversation:${notification.conversationId}`;

    await publisher.publish(channel, JSON.stringify(notification));

    logger.info(
      {
        type: notification.type,
        jobId: notification.jobId,
        conversationId: notification.conversationId,
        channel,
      },
      "notification_published",
    );
  } catch (error) {
    // Log but don't throw - notification failure shouldn't fail the job
    logger.error(
      {
        err: error,
        notification,
      },
      "notification_publish_failed",
    );
  }
}

/**
 * Publish an ingestion notification to Redis Pub/Sub
 * Uses runId-based channel routing (not conversationId)
 */
export async function notifyIngestion(notification: IngestionProgressNotification): Promise<void> {
  try {
    const publisher = getPublisher();
    const channel = `run:${notification.runId}`;

    await publisher.publish(channel, JSON.stringify(notification));

    logger.info(
      {
        type: notification.type,
        runId: notification.runId,
        channel,
      },
      "ingestion_notification_published",
    );
  } catch (error) {
    logger.error(
      { err: error, notification },
      "ingestion_notification_publish_failed",
    );
  }
}

/**
 * Helper to create and send an ingestion:started notification
 */
export async function notifyIngestionStarted(runId: string, totalFiles: number): Promise<void> {
  await notifyIngestion({
    type: "ingestion:started",
    runId,
    progress: { processed: 0, skipped: 0, failed: 0, total: totalFiles },
  });
}

/**
 * Helper to create and send an ingestion:progress notification.
 *
 * The optional `apiCost?` / `apiCallsCount?` carry the cumulative
 * external-API spend (Mistral OCR + PubChem) for the run, mirroring
 * the `llmCost` / `llmCallsCount` fields. When undefined they are
 * omitted from the published payload — the dashboard treats absence
 * as "no external spend yet".
 */
export async function notifyIngestionProgress(
  runId: string,
  filePath: string,
  status: "processing" | "processed" | "skipped" | "failed",
  progress: { processed: number; skipped: number; failed: number; total: number },
  error?: string,
  options?: { apiCost?: number; apiCallsCount?: number },
): Promise<void> {
  await notifyIngestion({
    type: "ingestion:progress",
    runId,
    filePath,
    status,
    progress,
    error,
    apiCost: options?.apiCost,
    apiCallsCount: options?.apiCallsCount,
  });
}

/**
 * Helper to create and send an ingestion:completed notification
 */
export async function notifyIngestionCompleted(
  runId: string,
  progress: { processed: number; skipped: number; failed: number; total: number },
): Promise<void> {
  await notifyIngestion({
    type: "ingestion:completed",
    runId,
    status: "processed",
    progress,
  });
}

/**
 * Helper to create and send an ingestion:failed notification
 */
export async function notifyIngestionFailed(
  runId: string,
  error: string,
  progress?: { processed: number; skipped: number; failed: number; total: number },
): Promise<void> {
  await notifyIngestion({
    type: "ingestion:failed",
    runId,
    error,
    progress,
  });
}

/**
 * Helper to create and send a run:llm_call notification
 */
export async function notifyRunLlmCall(
  runId: string,
  llmCost: number,
  llmCallsCount: number,
): Promise<void> {
  await notifyIngestion({
    type: "run:llm_call",
    runId,
    llmCost,
    llmCallsCount,
  });
}

/**
 * Helper to create and send a `run:api_call` notification carrying
 * the cumulative external-API spend (Mistral OCR + PubChem) for a
 * run. Pairs with the `run:llm_call` event so the dashboard can
 * show both columns. Falsy values are forwarded as-is (the WebSocket
 * consumer skips undefined fields).
 */
export async function notifyRunApiCall(
  runId: string,
  apiCost: number,
  apiCallsCount: number,
): Promise<void> {
  await notifyIngestion({
    type: "run:api_call",
    runId,
    apiCost,
    apiCallsCount,
  });
}

/**
 * Helper to create and send a run:cancelled notification
 */
export async function notifyRunCancelled(
  runId: string,
  progress?: { processed: number; skipped: number; failed: number; total: number },
): Promise<void> {
  await notifyIngestion({
    type: "run:cancelled",
    runId,
    progress,
  });
}

/**
 * Helper to create and send a job:started notification
 */
export async function notifyJobStarted(
  jobId: string,
  conversationId: string,
  messageId?: string,
  stateId?: string,
): Promise<void> {
  await notify({
    type: "job:started",
    jobId,
    conversationId,
    messageId,
    stateId,
  });
}

/**
 * Helper to create and send a job:progress notification
 */
export async function notifyJobProgress(
  jobId: string,
  conversationId: string,
  stage: string,
  percent: number,
): Promise<void> {
  await notify({
    type: "job:progress",
    jobId,
    conversationId,
    progress: { stage, percent },
  });
}

/**
 * Helper to create and send a job:completed notification
 */
export async function notifyJobCompleted(
  jobId: string,
  conversationId: string,
  messageId?: string,
  stateId?: string,
): Promise<void> {
  await notify({
    type: "job:completed",
    jobId,
    conversationId,
    messageId,
    stateId,
  });
}

/**
 * Helper to create and send a job:failed notification
 */
export async function notifyJobFailed(
  jobId: string,
  conversationId: string,
  messageId?: string,
  stateId?: string,
): Promise<void> {
  await notify({
    type: "job:failed",
    jobId,
    conversationId,
    messageId,
    stateId,
  });
}

/**
 * Helper to create and send a message:updated notification
 * Use this after updating message content in the database
 */
export async function notifyMessageUpdated(
  jobId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  await notify({
    type: "message:updated",
    jobId,
    conversationId,
    messageId,
  });
}

/**
 * Helper to create and send a state:updated notification
 * Use this after updating conversation state in the database
 */
export async function notifyStateUpdated(
  jobId: string,
  conversationId: string,
  stateId: string,
): Promise<void> {
  await notify({
    type: "state:updated",
    jobId,
    conversationId,
    stateId,
  });
}

/**
 * Helper to create and send a file:ready notification
 * Use this after a file has been processed successfully
 */
export async function notifyFileReady(
  jobId: string,
  conversationId: string,
  fileId: string,
  description: string,
): Promise<void> {
  await notify({
    type: "file:ready",
    jobId,
    conversationId,
    fileId,
    description,
  });
}

/**
 * Helper to create and send a file:error notification
 * Use this when file processing fails
 */
export async function notifyFileError(
  jobId: string,
  conversationId: string,
  fileId: string,
  error: string,
): Promise<void> {
  await notify({
    type: "file:error",
    jobId,
    conversationId,
    fileId,
    error,
  });
}

/**
 * Helper to create and send a paper:started notification
 */
export async function notifyPaperStarted(
  jobId: string,
  conversationId: string,
  paperId: string,
): Promise<void> {
  await notify({
    type: "paper:started",
    jobId,
    conversationId,
    paperId,
  });
}

/**
 * Helper to create and send a paper:progress notification
 */
export async function notifyPaperProgress(
  jobId: string,
  conversationId: string,
  paperId: string,
  stage: string,
  percent: number,
): Promise<void> {
  await notify({
    type: "paper:progress",
    jobId,
    conversationId,
    paperId,
    progress: { stage, percent },
  });
}

/**
 * Helper to create and send a paper:completed notification
 */
export async function notifyPaperCompleted(
  jobId: string,
  conversationId: string,
  paperId: string,
): Promise<void> {
  await notify({
    type: "paper:completed",
    jobId,
    conversationId,
    paperId,
  });
}

/**
 * Helper to create and send a paper:failed notification
 */
export async function notifyPaperFailed(
  jobId: string,
  conversationId: string,
  paperId: string,
  error: string,
): Promise<void> {
  await notify({
    type: "paper:failed",
    jobId,
    conversationId,
    paperId,
    error,
  });
}

// Alias for backwards compatibility
export { notify as publishNotification };

/**
 * Emit a per-source completion event for a deep-research literature task.
 * Lets the UI render a per-source evidence panel as each source finishes
 * (OpenScholar, Edison, Knowledge) without waiting for the whole task.
 *
 * Worker code is responsible for calling this once per literature source
 * after it resolves (ok, empty, or failed).
 */
export async function notifyAgentSourceCompleted(
  jobId: string,
  conversationId: string,
  source: {
    sourceName:
      | "OPENSCHOLAR"
      | "KNOWLEDGE"
      | "EDISON"
      | "BIOLIT"
      | "BIOLITDEEP";
    status: "ok" | "empty" | "failed";
    count: number;
    durationMs: number;
    error?: string;
    iteration: number;
  },
): Promise<void> {
  await notify({
    type: "agent:source_completed",
    jobId,
    conversationId,
    source,
  });
}
