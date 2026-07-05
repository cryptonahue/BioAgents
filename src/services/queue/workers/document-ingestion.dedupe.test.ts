import { describe, it, expect } from "bun:test";

/**
 * Tests for document ingestion worker dedupe logic.
 * These tests verify that the isKnownDocument function correctly identifies
 * documents that should be skipped based on title, filePath, or contentHash.
 */

interface DocumentIdentity {
  title: string;
  filePath: string;
  contentHash: string;
}

interface ExistingIdentity {
  titles: Set<string>;
  filePaths: Set<string>;
  contentHashes: Set<string>;
}

/**
 * Replicates the isKnownDocument logic from document-ingestion.worker.ts
 */
function isKnownDocument(
  doc: Pick<DocumentIdentity, "title" | "filePath" | "contentHash">,
  existing: {
    titles: Set<string>;
    filePaths: Set<string>;
    contentHashes: Set<string>;
  },
): boolean {
  return (
    existing.titles.has(doc.title) ||
    existing.filePaths.has(doc.filePath) ||
    existing.contentHashes.has(doc.contentHash)
  );
}

describe("Worker Dedup Logic", () => {
  describe("isKnownDocument", () => {
    it("should return true when title matches", () => {
      const existing: ExistingIdentity = {
        titles: new Set(["Seaweed Study 2024"]),
        filePaths: new Set<string>(),
        contentHashes: new Set<string>(),
      };

      const doc = {
        title: "Seaweed Study 2024",
        filePath: "/data/papers/new-file.pdf",
        contentHash: "abc123",
      };

      expect(isKnownDocument(doc, existing)).toBe(true);
    });

    it("should return true when filePath matches", () => {
      const existing: ExistingIdentity = {
        titles: new Set<string>(),
        filePaths: new Set(["/data/papers/seaweed-study.pdf"]),
        contentHashes: new Set<string>(),
      };

      const doc = {
        title: "Different Title",
        filePath: "/data/papers/seaweed-study.pdf",
        contentHash: "xyz789",
      };

      expect(isKnownDocument(doc, existing)).toBe(true);
    });

    it("should return true when contentHash matches", () => {
      const existing: ExistingIdentity = {
        titles: new Set<string>(),
        filePaths: new Set<string>(),
        contentHashes: new Set(["def456"]),
      };

      const doc = {
        title: "Yet Another Title",
        filePath: "/data/papers/new-path.pdf",
        contentHash: "def456",
      };

      expect(isKnownDocument(doc, existing)).toBe(true);
    });

    it("should return false when no match found", () => {
      const existing: ExistingIdentity = {
        titles: new Set(["Existing Title"]),
        filePaths: new Set(["/data/papers/existing.pdf"]),
        contentHashes: new Set(["existing-hash"]),
      };

      const doc = {
        title: "Completely New Title",
        filePath: "/data/papers/new-path.pdf",
        contentHash: "new-unique-hash",
      };

      expect(isKnownDocument(doc, existing)).toBe(false);
    });

    it("should return true when multiple attributes match", () => {
      const existing: ExistingIdentity = {
        titles: new Set(["Seaweed Study"]),
        filePaths: new Set(["/data/papers/seaweed.pdf"]),
        contentHashes: new Set(["hash123"]),
      };

      const doc = {
        title: "Seaweed Study",
        filePath: "/data/papers/seaweed.pdf",
        contentHash: "hash123",
      };

      expect(isKnownDocument(doc, existing)).toBe(true);
    });

    it("should handle empty existing sets", () => {
      const existing: ExistingIdentity = {
        titles: new Set<string>(),
        filePaths: new Set<string>(),
        contentHashes: new Set<string>(),
      };

      const doc = {
        title: "Any Title",
        filePath: "/data/papers/any.pdf",
        contentHash: "any-hash",
      };

      expect(isKnownDocument(doc, existing)).toBe(false);
    });

    it("should handle partial existing data", () => {
      const existing: ExistingIdentity = {
        titles: new Set(["Known Title"]),
        filePaths: new Set<string>(),
        contentHashes: new Set<string>(),
      };

      // filePath matches but title doesn't
      const doc1 = {
        title: "Unknown Title",
        filePath: "/data/papers/known.pdf",
        contentHash: "unknown-hash",
      };
      expect(isKnownDocument(doc1, existing)).toBe(false);

      // title matches
      const doc2 = {
        title: "Known Title",
        filePath: "/data/papers/unknown.pdf",
        contentHash: "unknown-hash",
      };
      expect(isKnownDocument(doc2, existing)).toBe(true);
    });
  });

  describe("loadExistingDocumentIdentity mock behavior", () => {
    it("should simulate loading identity from database", async () => {
      // This simulates the behavior of loadExistingDocumentIdentity
      // which loads from research_sources and documents tables
      const mockTitles = new Set(["Paper A", "Paper B", "Paper C"]);
      const mockFilePaths = new Set(["/docs/a.pdf", "/docs/b.pdf"]);
      const mockContentHashes = new Set(["hash-a", "hash-b"]);

      const existing = {
        titles: mockTitles,
        filePaths: mockFilePaths,
        contentHashes: mockContentHashes,
      };

      // Known document
      expect(
        isKnownDocument(
          { title: "Paper A", filePath: "/docs/new.pdf", contentHash: "new-hash" },
          existing,
        ),
      ).toBe(true);

      // Unknown document
      expect(
        isKnownDocument(
          { title: "Paper X", filePath: "/docs/x.pdf", contentHash: "hash-x" },
          existing,
        ),
      ).toBe(false);
    });
  });
});
