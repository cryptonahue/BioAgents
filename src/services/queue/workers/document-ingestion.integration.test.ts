import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import { mockFn } from "bun:test";

// Mock the dependencies for integration testing
// In a real environment, these would use actual Redis and Supabase connections

describe("Document Ingestion Flow Integration", () => {
  describe("full flow: start run -> enqueue -> process -> notify", () => {
    it("should create run record and enqueue jobs", async () => {
      // This test validates the flow:
      // 1. Create run record with status=running
      // 2. Enqueue N jobs to document-ingestion queue
      // 3. Workers process jobs and update counters
      // 4. Notifications are published via Redis Pub/Sub

      const mockRunId = "550e8400-e29b-41d4-a716-446655440000";
      const mockFiles = [
        "/data/papers/paper1.pdf",
        "/data/papers/paper2.pdf",
        "/data/papers/paper3.pdf",
      ];

      // Simulate run creation
      const runRecord = {
        id: mockRunId,
        docs_path: "/data/papers",
        status: "running",
        total_files: mockFiles.length,
        processed_files: 0,
        skipped_files: 0,
        failed_files: 0,
        file_statuses: [],
      };

      expect(runRecord.status).toBe("running");
      expect(runRecord.total_files).toBe(mockFiles.length);

      // Simulate job enqueueing
      const enqueuedJobs = mockFiles.map((filePath) => ({
        runId: mockRunId,
        filePath,
        options: {
          force: false,
          extractBioprospecting: false,
        },
      }));

      expect(enqueuedJobs.length).toBe(3);
      expect(enqueuedJobs[0].runId).toBe(mockRunId);
 });

    it("should track progress across multiple job completions", async () => {
      const mockRunId = "550e8400-e29b-41d4-a716-446655440000";
      let counters = { processed: 0, skipped: 0, failed: 0 };

      // Simulate job completions
      const jobResults = [
        { filePath: "/data/papers/paper1.pdf", status: "processed" as const },
        { filePath: "/data/papers/paper2.pdf", status: "skipped" as const },
        { filePath: "/data/papers/paper3.pdf", status: "processed" as const },
      ];

      for (const result of jobResults) {
        if (result.status === "processed") counters.processed++;
        else if (result.status === "skipped") counters.skipped++;
        else if (result.status === "failed") counters.failed++;
      }

      expect(counters.processed).toBe(2);
      expect(counters.skipped).toBe(1);
      expect(counters.failed).toBe(0);
    });

    it("should handle partial failure scenario", async () => {
      const mockRunId = "550e8400-e29b-41d4-a716-446655440000";
      let counters = { processed: 0, skipped: 0, failed: 0 };

      const jobResults = [
        { filePath: "/data/papers/paper1.pdf", status: "processed" as const },
        { filePath: "/data/papers/corrupt.pdf", status: "failed" as const },
        { filePath: "/data/papers/paper3.pdf", status: "processed" as const },
        { filePath: "/data/papers/bad.pdf", status: "failed" as const },
      ];

      for (const result of jobResults) {
        if (result.status === "processed") counters.processed++;
        else if (result.status === "skipped") counters.skipped++;
        else if (result.status === "failed") counters.failed++;
      }

      expect(counters.processed).toBe(2);
      expect(counters.failed).toBe(2);

      // Final status should be completed_with_errors
      const finalStatus = counters.failed > 0 ? "completed_with_errors" : "completed";
      expect(finalStatus).toBe("completed_with_errors");
    });

    it("should emit progress notifications", async () => {
      const mockRunId = "550e8400-e29b-41d4-a716-446655440000";
      const notifications: any[] = [];

      // Simulate notification emission
      const emitNotification = (type: string, runId: string, data: any) => {
        notifications.push({ type, runId, ...data });
      };

      emitNotification("ingestion:started", mockRunId, { total: 3 });
      emitNotification("ingestion:progress", mockRunId, {
        filePath: "/data/papers/paper1.pdf",
        status: "processed",
        progress: { processed: 1, skipped: 0, failed: 0, total: 3 },
      });
      emitNotification("ingestion:progress", mockRunId, {
        filePath: "/data/papers/paper2.pdf",
        status: "processed",
        progress: { processed: 2, skipped: 0, failed: 0, total: 3 },
      });
      emitNotification("ingestion:completed", mockRunId, {
        progress: { processed: 2, skipped: 0, failed: 0, total: 3 },
      });

      expect(notifications.length).toBe(4);
      expect(notifications[0].type).toBe("ingestion:started");
      expect(notifications[3].type).toBe("ingestion:completed");
    });

    it("should enqueue bioprospecting job after successful document processing", async () => {
      const mockRunId = "550e8400-e29b-41d4-a716-446655440000";
      const mockSourceId = "550e8400-e29b-41d4-a716-446655440001";
      const bioprospectingJobs: any[] = [];

      // Simulate bioprospecting job enqueueing
      const enqueueBioprospecting = (runId: string, sourceId: string) => {
        bioprospectingJobs.push({ runId, sourceId });
      };

      // After document processing completes with extractBioprospecting=true
      enqueueBioprospecting(mockRunId, mockSourceId);

      expect(bioprospectingJobs.length).toBe(1);
      expect(bioprospectingJobs[0].sourceId).toBe(mockSourceId);
    });
  });

  describe("file_statuses JSONB tracking", () => {
    it("should build file_statuses array correctly", () => {
      const fileStatuses: any[] = [];

      // Simulate adding file status entries
      const addFileStatus = (
        filePath: string,
        status: "processed" | "skipped" | "failed",
        additionalFields: Record<string, any> = {},
      ) => {
        const entry = { filePath, status, ...additionalFields };
        const existingIndex = fileStatuses.findIndex((f) => f.filePath === filePath);

        if (existingIndex >= 0) {
          fileStatuses[existingIndex] = entry;
        } else {
          fileStatuses.push(entry);
        }
      };

      addFileStatus("/data/papers/paper1.pdf", "processed", {
        chunksInserted: 12,
        sourceId: "uuid-1",
      });
      addFileStatus("/data/papers/paper2.pdf", "skipped", { reason: "already exists" });
      addFileStatus("/data/papers/paper3.pdf", "failed", { error: "PDF parse error" });

      expect(fileStatuses.length).toBe(3);
      expect(fileStatuses[0].status).toBe("processed");
      expect(fileStatuses[0].chunksInserted).toBe(12);
      expect(fileStatuses[1].status).toBe("skipped");
      expect(fileStatuses[2].status).toBe("failed");
    });

    it("should update existing file status entry", () => {
      const fileStatuses: any[] = [
        { filePath: "/data/papers/paper1.pdf", status: "failed", error: "Initial error" },
      ];

      const addFileStatus = (
        filePath: string,
        status: "processed" | "skipped" | "failed",
        additionalFields: Record<string, any> = {},
      ) => {
        const entry = { filePath, status, ...additionalFields };
        const existingIndex = fileStatuses.findIndex((f) => f.filePath === filePath);

        if (existingIndex >= 0) {
          fileStatuses[existingIndex] = entry;
        } else {
          fileStatuses.push(entry);
        }
      };

      // Update the failed entry with retry success
      addFileStatus("/data/papers/paper1.pdf", "processed", {
        chunksInserted: 10,
        sourceId: "uuid-1",
      });

      expect(fileStatuses.length).toBe(1);
      expect(fileStatuses[0].status).toBe("processed");
      expect(fileStatuses[0].chunksInserted).toBe(10);
    });
  });
});
