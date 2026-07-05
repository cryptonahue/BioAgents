/**
 * Unit tests for the PR #2 PDF provenance viewer endpoints in
 * `src/routes/research-brain.ts`. The three endpoints under test are:
 *
 *   1. GET /api/research-brain/sources/:sourceId/evidence
 *   2. GET /api/research-brain/sources/:sourceId/pdf
 *   3. GET /api/research-brain/facts/:factId/provenance
 *
 * Test strategy:
 *   - Mock the Supabase service client with the same chainable stub
 *     used by `dedup.test.ts`. The stub is registered BEFORE the
 *     route module is imported, so all Supabase calls in the route
 *     handler resolve through the mock.
 *   - Mock the storage provider via `globalThis` so the PDF endpoint
 *     can return either a buffer, throw an error, or be unset.
 *   - Drive the Elysia route through `route.handle(request)` which is
 *     the documented Elysia test entry point.
 *
 * These tests are pure route-level smoke tests — they assert the
 * contract the frontend lightbox depends on, not the underlying
 * Supabase semantics. Integration tests against the real DB are out
 * of scope here (the spec's Given/When/Then scenarios are covered
 * by manual review against the live viewer).
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock infrastructure — same pattern as dedup.test.ts
// ---------------------------------------------------------------------------

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
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "is",
  "not",
  "or",
  "and",
  "ilike",
  "match",
  "filter",
  "order",
  "limit",
  "range",
  "upsert",
];

const TERMINAL_METHODS = ["maybeSingle", "single"];

function scriptedMock(script: Terminal[], calls: Call[]) {
  let cursor = 0;
  const target: any = {};
  const next = (): Terminal => {
    if (cursor >= script.length) {
      return { kind: "many", data: [], error: null };
    }
    return script[cursor++];
  };
  for (const method of BUILDER_METHODS) {
    target[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return target;
    };
  }
  for (const method of TERMINAL_METHODS) {
    target[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      const t = next();
      if (t.kind === "single") {
        return Promise.resolve({ data: t.data, error: t.error });
      }
      return Promise.resolve({ data: t.data, error: t.error });
    };
  }
  Object.defineProperty(target, "then", {
    get() {
      return (onFulfilled: any, onRejected: any) => {
        calls.push({ method: "then", args: [] });
        const t = next();
        const data = t.kind === "single" ? t.data : t.data;
        const error = t.error;
        return Promise.resolve({ data, error }).then(onFulfilled, onRejected);
      };
    },
  });
  return target;
}

declare global {
  // eslint-disable-next-line no-var
  var __provenanceViewerTestClient: (() => any) | undefined;
  // eslint-disable-next-line no-var
  var __provenanceViewerTestStorage: any;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__provenanceViewerTestClient = factory;
}

function setMockStorage(storage: any) {
  globalThis.__provenanceViewerTestStorage = storage;
}

// Register the module mocks BEFORE importing the route. The Supabase
// client is consulted through `getServiceClient()`; the storage
// provider is consulted through `getStorageProvider()`. Both
// functions are exported from their respective index files.
//
// Path note: the test lives at
//   src/routes/__tests__/research-brain.provenance.test.ts
// so `../../db/client` reaches `src/db/client.ts` (the same module
// the route imports via `../db/client`) and `../../storage` reaches
// `src/storage/index.ts`. Using `../../../…` here would point above
// the repo root and silently miss the mock — the route would then
// fall through to the real Supabase / storage clients.
mock.module("../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__provenanceViewerTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__provenanceViewerTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__provenanceViewerTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__provenanceViewerTestClient ?? (() => null))(),
}));

mock.module("../../storage", () => ({
  getStorageProvider: () => globalThis.__provenanceViewerTestStorage ?? null,
  isStorageProviderAvailable: () =>
    globalThis.__provenanceViewerTestStorage != null,
  getConversationBasePath: () => "",
  getUploadPath: () => "",
  getFileUploadPath: () => "",
  getMimeTypeFromFilename: () => "application/octet-stream",
  default: {
    getStorageProvider: () => globalThis.__provenanceViewerTestStorage ?? null,
  },
}));

import { researchBrainRoute } from "../../routes/research-brain";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SOURCE_ID = "00000000-0000-0000-0000-00000000aaaa";
const OTHER_SOURCE_ID = "00000000-0000-0000-0000-000000000bbb";
const TABLE_ID = "00000000-0000-0000-0000-0000000000a1";
const FIGURE_ID = "00000000-0000-0000-0000-0000000000a2";
const FACT_ID_TABLE = "00000000-0000-0000-0000-0000000000f1";
const FACT_ID_FIGURE = "00000000-0000-0000-0000-0000000000f2";
const FACT_ID_CHUNK = "00000000-0000-0000-0000-0000000000f3";
const FACT_ID_TEXT_ONLY = "00000000-0000-0000-0000-0000000000f4";
const FACT_ID_MISSING = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const CHUNK_ID = "00000000-0000-0000-0000-00000000cccc";

function makeSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SOURCE_ID,
    source_kind: "paper",
    trust_tier: "internal",
    title: "Marine algae compounds as anticancer agents",
    doi: "10.1234/example",
    url: null,
    file_path: "sources/sample.pdf",
    extraction_status: "completed",
    extraction_error: null,
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeTableRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TABLE_ID,
    source_id: SOURCE_ID,
    page: 4,
    table_index: 0,
    headers: ["**Treatment** | Control [mg/mL]", "**Treatment** | Dose [mg/mL]"],
    rows: [
      ["0", "-", "1.2"],
      ["24", "3.1", "5.4"],
    ],
    markdown: "| **Treatment** | Control [mg/mL] | **Treatment** | Dose [mg/mL] |\n| --- | --- | --- | --- |\n| 0 | - | 1.2 |\n| 24 | 3.1 | 5.4 |",
    bbox: { x: 72, y: 144, w: 216, h: 180, page: 4, units: "pt" },
    extraction_provider: "local",
    extraction_confidence: 0.87,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeFigureRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FIGURE_ID,
    source_id: SOURCE_ID,
    page: 2,
    figure_index: 0,
    bbox: { x: 100, y: 200, w: 300, h: 220, page: 2, units: "pt" },
    caption: "Figure 3. Cell viability assay results.",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeChunkRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CHUNK_ID,
    source_id: SOURCE_ID,
    page: 3,
    chunk_index: 7,
    content: "Q. officinale extract inhibited cell proliferation...",
    ...overrides,
  };
}

function makeFactWithTable(): Record<string, unknown> {
  return {
    id: FACT_ID_TABLE,
    source_id: SOURCE_ID,
    chunk_id: CHUNK_ID,
    evidence_table_id: TABLE_ID,
    evidence_figure_id: null,
    species: "A. vera",
    result_summary: "IC50 5.4 μg/mL",
    doi: "10.1234/example",
    page: 4,
    source: makeSource(),
    chunk: makeChunkRow(),
    evidence_table: makeTableRow(),
    evidence_figure: null,
  };
}

function makeFactWithFigure(): Record<string, unknown> {
  return {
    id: FACT_ID_FIGURE,
    source_id: SOURCE_ID,
    chunk_id: null,
    evidence_table_id: null,
    evidence_figure_id: FIGURE_ID,
    species: null,
    result_summary: "See Figure 3",
    doi: null,
    page: 2,
    source: makeSource(),
    chunk: null,
    evidence_table: null,
    evidence_figure: makeFigureRow(),
  };
}

function makeFactWithChunk(): Record<string, unknown> {
  return {
    id: FACT_ID_CHUNK,
    source_id: SOURCE_ID,
    chunk_id: CHUNK_ID,
    evidence_table_id: null,
    evidence_figure_id: null,
    species: "Q. officinale",
    result_summary: "Inhibits proliferation",
    doi: null,
    page: 3,
    source: makeSource(),
    chunk: makeChunkRow(),
    evidence_table: null,
    evidence_figure: null,
  };
}

function makeFactTextOnly(): Record<string, unknown> {
  return {
    id: FACT_ID_TEXT_ONLY,
    source_id: SOURCE_ID,
    chunk_id: null,
    evidence_table_id: null,
    evidence_figure_id: null,
    species: "Unknown",
    result_summary: "Generic claim",
    doi: null,
    page: null,
    source: makeSource(),
    chunk: null,
    evidence_table: null,
    evidence_figure: null,
  };
}

// ---------------------------------------------------------------------------
// Per-test setup
// ---------------------------------------------------------------------------

let calls: Call[];
let client: any;

beforeEach(() => {
  calls = [];
  client = scriptedMock([], calls);
  setMockServiceClient(() => client);
  setMockStorage(null); // default: no storage provider
});

// ---------------------------------------------------------------------------
// 1. GET /api/research-brain/sources/:sourceId/evidence
// ---------------------------------------------------------------------------

describe("GET /api/research-brain/sources/:sourceId/evidence", () => {
  it("returns 404 for an unknown source", async () => {
    // Script: getSource lookup returns null → 404
    client = scriptedMock(
      [{ kind: "single", data: null, error: null }],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/sources/${FACT_ID_MISSING}/evidence`),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Source not found");
  });

  it("returns tables, figures, and chunks in (page, idx) order", async () => {
    // Script: 1× getSource single, 1× loadTables (many), 1× loadFigures (many),
    //         1× loadChunks (many — via the .then of the chainable)
    // The route issues the three in parallel via Promise.all, so the
    // order of scriptedMock consumption depends on microtask order.
    // All 4 terminals must return data; ordering is by table loaders
    // that have their own .order() clauses.
    client = scriptedMock(
      [
        { kind: "single", data: makeSource(), error: null }, // getSource
        { kind: "many", data: [makeTableRow()], error: null }, // loadTables
        { kind: "many", data: [makeFigureRow()], error: null }, // loadFigures
        { kind: "many", data: [makeChunkRow()], error: null }, // loadChunks
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/sources/${SOURCE_ID}/evidence`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sourceId).toBe(SOURCE_ID);
    expect(body.tables).toHaveLength(1);
    expect(body.figures).toHaveLength(1);
    expect(body.chunks).toHaveLength(1);

    // Table row shape
    expect(body.tables[0].id).toBe(TABLE_ID);
    expect(body.tables[0].page).toBe(4);
    expect(body.tables[0].tableIndex).toBe(0);
    expect(body.tables[0].bbox.units).toBe("pt");
    expect(body.tables[0].extractionProvider).toBe("local");
    expect(body.tables[0].extractionConfidence).toBeCloseTo(0.87);

    // Figure row shape
    expect(body.figures[0].id).toBe(FIGURE_ID);
    expect(body.figures[0].caption).toContain("Figure 3");

    // Chunk row shape
    expect(body.chunks[0].id).toBe(CHUNK_ID);
    expect(body.chunks[0].chunkIndex).toBe(7);
    expect(body.chunks[0].bbox).toBeNull();
  });

  it("returns empty arrays when the source has no extracted evidence", async () => {
    client = scriptedMock(
      [
        { kind: "single", data: makeSource(), error: null },
        { kind: "many", data: [], error: null },
        { kind: "many", data: [], error: null },
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/sources/${SOURCE_ID}/evidence`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.tables).toEqual([]);
    expect(body.figures).toEqual([]);
    expect(body.chunks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. GET /api/research-brain/sources/:sourceId/pdf
// ---------------------------------------------------------------------------

describe("GET /api/research-brain/sources/:sourceId/pdf", () => {
  it("returns 404 when the source does not exist", async () => {
    client = scriptedMock(
      [{ kind: "single", data: null, error: null }],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/sources/${FACT_ID_MISSING}/pdf`),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the source has no file_path", async () => {
    client = scriptedMock(
      [{ kind: "single", data: makeSource({ file_path: null }), error: null }],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/sources/${SOURCE_ID}/pdf`),
    );
    expect(res.status).toBe(404);
  });

  it("returns 502 when no storage provider is configured", async () => {
    client = scriptedMock(
      [{ kind: "single", data: makeSource(), error: null }],
      calls,
    );
    setMockServiceClient(() => client);
    setMockStorage(null); // no provider

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/sources/${SOURCE_ID}/pdf`),
    );
    expect(res.status).toBe(502);
  });

  it("returns the PDF bytes inline with correct headers", async () => {
    client = scriptedMock(
      [{ kind: "single", data: makeSource(), error: null }],
      calls,
    );
    setMockServiceClient(() => client);

    // 4 KB fake PDF body — large enough to exercise the buffer path
    // but well under the 50 MB cap.
    const fakePdf = Buffer.from("%PDF-1.4\nfake content\n%%EOF\n");
    setMockStorage({
      download: async (path: string) => {
        expect(path).toBe("sources/sample.pdf");
        return fakePdf;
      },
    });

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/sources/${SOURCE_ID}/pdf`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("inline;");
    expect(res.headers.get("Content-Disposition")).toContain(".pdf");
    expect(res.headers.get("Content-Length")).toBe(String(fakePdf.length));
    expect(res.headers.get("Cache-Control")).toContain("private");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(body).toString("utf8")).toContain("%PDF-1.4");
  });

  it("sanitizes the filename in Content-Disposition", async () => {
    client = scriptedMock(
      [
        {
          kind: "single",
          data: makeSource({ title: 'Malicious/Title\\With"Quotes\nand\tTabs' }),
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    setMockStorage({
      download: async () => Buffer.from("PDF"),
    });

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/sources/${SOURCE_ID}/pdf`),
    );
    expect(res.status).toBe(200);
    const disposition = res.headers.get("Content-Disposition") || "";
    // Path separators are stripped
    expect(disposition).not.toContain("/");
    expect(disposition).not.toContain("\\");
    // Control chars are not in the value
    expect(disposition).not.toContain("\n");
    expect(disposition).not.toContain("\t");
    // Always ends with .pdf
    expect(disposition).toMatch(/\.pdf"$/);
  });

  it("returns 413 when the PDF exceeds 50 MB", async () => {
    client = scriptedMock(
      [{ kind: "single", data: makeSource(), error: null }],
      calls,
    );
    setMockServiceClient(() => client);
    // 60 MB fake buffer
    const big = Buffer.alloc(60 * 1024 * 1024, 0);
    setMockStorage({
      download: async () => big,
    });

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/sources/${SOURCE_ID}/pdf`),
    );
    expect(res.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// 3. GET /api/research-brain/facts/:factId/provenance
// ---------------------------------------------------------------------------

describe("GET /api/research-brain/facts/:factId/provenance", () => {
  it("returns 404 for an unknown fact", async () => {
    client = scriptedMock(
      [{ kind: "single", data: null, error: null }],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/facts/${FACT_ID_MISSING}/provenance`),
    );
    expect(res.status).toBe(404);
  });

  it("resolves to type=table when evidence_table_id is set", async () => {
    client = scriptedMock(
      [{ kind: "single", data: makeFactWithTable(), error: null }],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/facts/${FACT_ID_TABLE}/provenance`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.factId).toBe(FACT_ID_TABLE);
    expect(body.sourceId).toBe(SOURCE_ID);
    expect(body.sourceTitle).toContain("Marine algae");
    expect(body.doi).toBe("10.1234/example");
    expect(body.provenance.type).toBe("table");
    expect(body.provenance.table).not.toBeNull();
    expect(body.provenance.table.id).toBe(TABLE_ID);
    expect(body.provenance.figure).toBeNull();
    expect(body.provenance.chunk).not.toBeNull();
    expect(body.provenance.chunk.id).toBe(CHUNK_ID);
    expect(body.provenance.bbox.units).toBe("pt");
    // bbox equals table.bbox per spec
    expect(body.provenance.bbox.x).toBe(72);
  });

  it("resolves to type=figure when only evidence_figure_id is set", async () => {
    client = scriptedMock(
      [{ kind: "single", data: makeFactWithFigure(), error: null }],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/facts/${FACT_ID_FIGURE}/provenance`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.provenance.type).toBe("figure");
    expect(body.provenance.figure).not.toBeNull();
    expect(body.provenance.figure.id).toBe(FIGURE_ID);
    expect(body.provenance.table).toBeNull();
    expect(body.provenance.bbox.x).toBe(100);
  });

  it("resolves to type=chunk with bbox=null when only chunk_id is set", async () => {
    client = scriptedMock(
      [{ kind: "single", data: makeFactWithChunk(), error: null }],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/facts/${FACT_ID_CHUNK}/provenance`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.provenance.type).toBe("chunk");
    expect(body.provenance.chunk).not.toBeNull();
    expect(body.provenance.chunk.chunkIndex).toBe(7);
    expect(body.provenance.table).toBeNull();
    expect(body.provenance.figure).toBeNull();
    expect(body.provenance.bbox).toBeNull();
  });

  it("resolves to type=text-only when nothing is resolvable", async () => {
    client = scriptedMock(
      [{ kind: "single", data: makeFactTextOnly(), error: null }],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/facts/${FACT_ID_TEXT_ONLY}/provenance`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.provenance.type).toBe("text-only");
    expect(body.provenance.table).toBeNull();
    expect(body.provenance.figure).toBeNull();
    expect(body.provenance.chunk).toBeNull();
    expect(body.provenance.bbox).toBeNull();
  });
});
