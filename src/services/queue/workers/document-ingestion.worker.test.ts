import { describe, it, expect, beforeEach, vi } from "bun:test";
import type { DocumentIngestionJobData, DocumentIngestionJobResult } from "./types";

describe("DocumentIngestionJobData", () => {
  describe("serialization", () => {
    it("should serialize job data with all fields", () => {
      const jobData: DocumentIngestionJobData = {
        runId: "550e8400-e29b-41d4-a716-446655440000",
        filePath: "/data/papers/seaweed-study.pdf",
        options: {
          force: true,
          extractBioprospecting: true,
        },
      };

      const serialized = JSON.stringify(jobData);
      const deserialized = JSON.parse(serialized) as DocumentIngestionJobData;

      expect(deserialized.runId).toBe(jobData.runId);
      expect(deserialized.filePath).toBe(jobData.filePath);
      expect(deserialized.options.force).toBe(true);
      expect(deserialized.options.extractBioprospecting).toBe(true);
    });

    it("should serialize job data with minimal options", () => {
      const jobData: DocumentIngestionJobData = {
        runId: "550e8400-e29b-41d4-a716-446655440000",
        filePath: "/data/papers/test.pdf",
        options: {},
      };

      const serialized = JSON.stringify(jobData);
      const deserialized = JSON.parse(serialized) as DocumentIngestionJobData;

      expect(deserialized.runId).toBe(jobData.runId);
      expect(deserialized.filePath).toBe(jobData.filePath);
      expect(deserialized.options.force).toBeUndefined();
      expect(deserialized.options.extractBioprospecting).toBeUndefined();
    });

    it("should handle special characters in file paths", () => {
      const jobData: DocumentIngestionJobData = {
        runId: "550e8400-e29b-41d4-a716-446655440000",
        filePath: "/data/papers/With Spaces (Parens) [Brackets].pdf",
        options: { force: false },
      };

      const serialized = JSON.stringify(jobData);
      const deserialized = JSON.parse(serialized) as DocumentIngestionJobData;

      expect(deserialized.filePath).toBe(jobData.filePath);
    });
  });

  describe("queue enqueue behavior", () => {
    it("should create valid job data structure for BullMQ", () => {
      const jobData: DocumentIngestionJobData = {
        runId: "550e8400-e29b-41d4-a716-446655440000",
        filePath: "/data/papers/test.pdf",
        options: {
          force: false,
          extractBioprospecting: false,
        },
      };

      // Verify structure matches what BullMQ expects
      expect(typeof jobData.runId).toBe("string");
      expect(typeof jobData.filePath).toBe("string");
      expect(typeof jobData.options).toBe("object");
      expect(typeof jobData.options.force).toBe("boolean");
      expect(typeof jobData.options.extractBioprospecting).toBe("boolean");
    });
  });
});

describe("DocumentIngestionJobResult", () => {
  describe("serialization", () => {
    it("should serialize processed result", () => {
      const result: DocumentIngestionJobResult = {
        filePath: "/data/papers/test.pdf",
        status: "processed",
        chunksInserted: 12,
        sourceId: "550e8400-e29b-41d4-a716-446655440001",
      };

      const serialized = JSON.stringify(result);
      const deserialized = JSON.parse(serialized) as DocumentIngestionJobResult;

      expect(deserialized.status).toBe("processed");
      expect(deserialized.chunksInserted).toBe(12);
      expect(deserialized.sourceId).toBe("550e8400-e29b-41d4-a716-446655440001");
    });

    it("should serialize skipped result", () => {
      const result: DocumentIngestionJobResult = {
        filePath: "/data/papers/existing.pdf",
        status: "skipped",
      };

      const serialized = JSON.stringify(result);
      const deserialized = JSON.parse(serialized) as DocumentIngestionJobResult;

      expect(deserialized.status).toBe("skipped");
      expect(deserialized.chunksInserted).toBeUndefined();
    });

    it("should serialize failed result with error", () => {
      const result: DocumentIngestionJobResult = {
        filePath: "/data/papers/corrupt.pdf",
        status: "failed",
        error: "PDF parse error: Invalid header",
      };

      const serialized = JSON.stringify(result);
      const deserialized = JSON.parse(serialized) as DocumentIngestionJobResult;

      expect(deserialized.status).toBe("failed");
      expect(deserialized.error).toBe("PDF parse error: Invalid header");
    });
  });
});
