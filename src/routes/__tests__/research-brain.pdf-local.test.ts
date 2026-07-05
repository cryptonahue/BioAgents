/**
 * Integration tests for GET /api/research-brain/sources/:sourceId/pdf
 * when backed by LocalStorageProvider. Verifies that:
 *
 *   - Real disk files are read through the provider and returned
 *     with the correct Content-Type / Content-Disposition headers.
 *   - Missing files on disk surface as 502 (matching the S3 contract).
 *   - Path-escape attempts against the configured root are rejected
 *     before reaching the filesystem.
 *
 * The Supabase client and storage provider are mocked through the
 * same globalThis indirection used by the provenance tests — see
 * `research-brain.provenance.test.ts` for the pattern.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { LocalStorageProvider } from "../../storage/providers/local";

type Call = { method: string; args: unknown[] };
type Terminal =
  | { kind: "single"; data: unknown; error: unknown }
  | { kind: "many"; data: unknown[]; error: null };

const BUILDER_METHODS = [
  "from",
  "select",
  "insert",
  "update",
  "delete",
  "eq",
  "neq",
  "in",
  "is",
  "or",
  "and",
  "order",
  "limit",
  "range",
];
const TERMINAL_METHODS = ["maybeSingle", "single"];

function scriptedMock(script: Terminal[], calls: Call[]) {
  let cursor = 0;
  const target: any = {};
  const next = (): Terminal =>
    cursor >= script.length
      ? { kind: "many", data: [], error: null }
      : script[cursor++];
  for (const m of BUILDER_METHODS) {
    target[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return target;
    };
  }
  for (const m of TERMINAL_METHODS) {
    target[m] = () => {
      calls.push({ method: m, args: [] });
      const t = next();
      return Promise.resolve({ data: t.data, error: t.error });
    };
  }
  return target;
}

declare global {
  // eslint-disable-next-line no-var
  var __pdfLocalRouteTestClient: (() => any) | undefined;
  // eslint-disable-next-line no-var
  var __pdfLocalRouteTestStorage: any;
}

function setMockClient(factory: () => any) {
  globalThis.__pdfLocalRouteTestClient = factory;
}

function setMockStorage(storage: any) {
  globalThis.__pdfLocalRouteTestStorage = storage;
}

mock.module("../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__pdfLocalRouteTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__pdfLocalRouteTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__pdfLocalRouteTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__pdfLocalRouteTestClient ?? (() => null))(),
}));

mock.module("../../storage", () => ({
  getStorageProvider: () => globalThis.__pdfLocalRouteTestStorage ?? null,
  isStorageProviderAvailable: () =>
    globalThis.__pdfLocalRouteTestStorage != null,
  getConversationBasePath: () => "",
  getUploadPath: () => "",
  getFileUploadPath: () => "",
  getMimeTypeFromFilename: () => "application/octet-stream",
  default: {
    getStorageProvider: () => globalThis.__pdfLocalRouteTestStorage ?? null,
  },
}));

const { researchBrainRoute } = await import("../../routes/research-brain");

const SOURCE_ID = "00000000-0000-0000-0000-00000000a1a1";
let calls: Call[];
let tmpDir: string;
let provider: LocalStorageProvider;

beforeEach(() => {
  calls = [];
  tmpDir = mkdtempSync(path.join(tmpdir(), "pdf-local-"));
  provider = new LocalStorageProvider({ rootDir: tmpDir });
  setMockStorage(provider);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  setMockStorage(null);
});

function mockSource(overrides: Record<string, unknown> = {}) {
  setMockClient(() =>
    scriptedMock(
      [
        {
          kind: "single",
          data: {
            id: SOURCE_ID,
            title: "Sample paper",
            file_path: "papers/sample.pdf",
            ...overrides,
          },
          error: null,
        },
      ],
      calls,
    ),
  );
}

describe("GET /api/research-brain/sources/:sourceId/pdf (LocalStorageProvider)", () => {
  it("serves the PDF bytes from disk", async () => {
    const pdfBytes = Buffer.from("%PDF-1.4\nlocal file content\n%%EOF\n", "utf8");
    const onDisk = path.join(tmpDir, "papers", "sample.pdf");
    require("node:fs").mkdirSync(path.dirname(onDisk), { recursive: true });
    writeFileSync(onDisk, pdfBytes);

    mockSource({ title: "Marine algae" });

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/sources/${SOURCE_ID}/pdf`),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Length")).toBe(String(pdfBytes.length));
    expect(res.headers.get("Content-Disposition")).toContain("inline;");
    expect(res.headers.get("Content-Disposition")).toContain("Marine algae");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(pdfBytes)).toBe(true);
  });

  it("returns 502 when the file is missing on disk", async () => {
    // Nothing written to tmpDir.
    mockSource();

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/sources/${SOURCE_ID}/pdf`),
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("proxy");
  });

  it("returns 404 when the source has no file_path", async () => {
    setMockClient(() =>
      scriptedMock(
        [
          {
            kind: "single",
            data: {
              id: SOURCE_ID,
              title: "No file",
              file_path: null,
            },
            error: null,
          },
        ],
        calls,
      ),
    );

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/sources/${SOURCE_ID}/pdf`),
    );

    expect(res.status).toBe(404);
  });

  it("returns 502 when the stored path escapes the storage root", async () => {
    // Provider refuses `../`; the handler maps the throw to 502.
    mockSource({ file_path: "../escaped.pdf" });

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/sources/${SOURCE_ID}/pdf`),
    );

    expect(res.status).toBe(502);
    // The file must not have been created at the parent location.
    expect(existsSync(path.join(path.dirname(tmpDir), "escaped.pdf"))).toBe(
      false,
    );
  });
});
