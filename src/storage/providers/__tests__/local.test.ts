/**
 * Tests for LocalStorageProvider — read-only disk proxy used in
 * dev / single-node deployments.
 *
 * Covers: download success, empty file, missing file, escape-via-`..`
 * refusal, delete, exists, downloadRange, and the no-op upload/presigned
 * surface (must throw).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { LocalStorageProvider } from "../local";

let tmpDir: string;
let provider: LocalStorageProvider;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "local-storage-"));
  provider = new LocalStorageProvider({ rootDir: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("LocalStorageProvider.download", () => {
  it("reads a file inside the root", async () => {
    const payload = Buffer.from("hello world", "utf8");
    writeFileSync(path.join(tmpDir, "paper.pdf"), payload);

    const got = await provider.download("paper.pdf");
    expect(got.toString("utf8")).toBe("hello world");
  });

  it("accepts absolute paths that are inside the root", async () => {
    const absolute = path.join(tmpDir, "nested", "doc.pdf");
    require("node:fs").mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, "PDF-bytes");

    const got = await provider.download(absolute);
    expect(got.toString("utf8")).toBe("PDF-bytes");
  });

  it("rejects paths that escape the root via ..", async () => {
    await expect(provider.download("../escaped.pdf")).rejects.toThrow(
      /escapes root/,
    );
  });

  it("tolerates relative paths that already include the root prefix", async () => {
    // Real-world shape: in production the worker CWD is `/app` and
    // `KNOWLEDGE_DOCS_PATH=docs` resolves to `/app/docs`. The stored
    // `file_path` (e.g. `docs/marinedrugs/foo.pdf`) resolves to
    // `/app/docs/marinedrugs/foo.pdf`. The provider must NOT
    // double-prefix into `/app/docs/docs/...`.
    const nested = path.join(tmpDir, "papers", "doc.pdf");
    require("node:fs").mkdirSync(path.dirname(nested), { recursive: true });
    writeFileSync(nested, "PDF-bytes");

    // Re-root the provider so its rootDir basename matches the
    // stored path prefix, simulating the production CWD layout.
    const realRoot = path.dirname(tmpDir);
    const rootBasename = path.basename(tmpDir);
    const localProvider = new LocalStorageProvider({
      rootDir: path.join(realRoot, rootBasename),
    });

    // chdir so `path.resolve(stored)` lands inside rootDir.
    const originalCwd = process.cwd();
    process.chdir(realRoot);
    try {
      const stored = `${rootBasename}/papers/doc.pdf`;
      const got = await localProvider.download(stored);
      expect(got.toString("utf8")).toBe("PDF-bytes");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("throws on missing files", async () => {
    await expect(provider.download("does-not-exist.pdf")).rejects.toThrow(
      /file not found/,
    );
  });

  it("throws on empty files", async () => {
    writeFileSync(path.join(tmpDir, "empty.pdf"), "");
    await expect(provider.download("empty.pdf")).rejects.toThrow(/empty file/);
  });
});

describe("LocalStorageProvider.exists", () => {
  it("returns true for existing files", async () => {
    writeFileSync(path.join(tmpDir, "x.pdf"), "x");
    expect(await provider.exists("x.pdf")).toBe(true);
  });

  it("returns false for missing files", async () => {
    expect(await provider.exists("nope.pdf")).toBe(false);
  });
});

describe("LocalStorageProvider.delete", () => {
  it("removes the file from disk", async () => {
    const target = path.join(tmpDir, "to-delete.pdf");
    writeFileSync(target, "bye");
    await provider.delete("to-delete.pdf");
    expect(await provider.exists("to-delete.pdf")).toBe(false);
  });

  it("is a no-op for missing files", async () => {
    await expect(provider.delete("never-existed.pdf")).resolves.toBeUndefined();
  });
});

describe("LocalStorageProvider.downloadRange", () => {
  it("returns the requested byte slice", async () => {
    const data = Buffer.from("0123456789ABCDEF", "utf8");
    writeFileSync(path.join(tmpDir, "range.bin"), data);

    const slice = await provider.downloadRange("range.bin", 4, 9);
    expect(slice.toString("utf8")).toBe("456789");
  });

  it("rejects invalid ranges", async () => {
    writeFileSync(path.join(tmpDir, "r.bin"), "abc");
    await expect(provider.downloadRange("r.bin", 5, 2)).rejects.toThrow(
      /invalid range/,
    );
  });
});

describe("LocalStorageProvider unsupported methods", () => {
  it("upload() throws a clear error", async () => {
    await expect(provider.upload("x", Buffer.from("y"), "application/pdf")).rejects.toThrow(
      /not supported/,
    );
  });

  it("getPresignedUrl() throws a clear error", async () => {
    await expect(provider.getPresignedUrl("x")).rejects.toThrow(/not supported/);
  });

  it("getPresignedUploadUrl() throws a clear error", async () => {
    await expect(provider.getPresignedUploadUrl("x", "application/pdf")).rejects.toThrow(
      /not supported/,
    );
  });
});
