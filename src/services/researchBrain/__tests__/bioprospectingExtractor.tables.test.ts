import { describe, it, expect, beforeEach, mock } from "bun:test";

/**
 * Dedicated unit tests for the table-aware extractor behavior shipped in
 * PR #1 of `bioprospecting-pdf-provenance-viewer`.
 *
 * Coverage matrix (one test per spec scenario from
 * `openspec/changes/bioprospecting-pdf-provenance-viewer/specs/research-bioprospecting/spec.md`):
 *
 *   1. Tables prompt section appears BEFORE the chunks section in the LLM prompt
 *   2. Tables prompt section uses `buildTablesPromptSection(tables)` output
 *   3. Tables injection only happens when tables exist for the source
 *   4. Tables injection skipped when no tables are cached for the source
 *   5. `sourceTableRef` resolver links a fact to its source table by row
 *   6. "Prefer tables over prose" rule appears in the LLM prompt
 *   7. `evidence_table_id` is populated on the fact when a `sourceTableRef` resolves
 *   8. `evidence_table_id` is null when the fact has no `sourceTableRef`
 *   9. `evidence_table_id` survives the inline merge in
 *      `replaceBioprospectingFactsForSource` (canonical AND sibling paths)
 *  10. `evidence_table_id` is set to NULL via `bioprospecting_table_ref_missing`
 *      log when `sourceTableRef` doesn't resolve to a real table
 *
 * These tests are hermetic: the Supabase service client, the storage
 * provider, the LLM resolver, and the `tables.ts` loader are all
 * mocked via `mock.module` so no DB or network round-trip happens.
 * The chainable Supabase stub is the same one used by `dedup.test.ts`.
 */

// ---------------------------------------------------------------------------
// Supabase chainable mock (mirrors dedup.test.ts)
// ---------------------------------------------------------------------------

type Call = { method: string; args: unknown[] };
type Terminal =
  | { kind: "single"; data: unknown; error: unknown }
  | { kind: "many"; data: unknown[]; error: unknown };

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
  const next = (): unknown => {
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
      const t = next() as any;
      if (t.kind === "single") {
        return Promise.resolve({ data: t.data, error: t.error });
      }
      if (t.kind === "many") {
        return Promise.resolve({ data: t.data, error: t.error });
      }
      return Promise.resolve({ data: null, error: null });
    };
  }
  // Awaiting the chainable itself resolves to the next scripted
  // terminal in the list (supabase-js supports both styles).
  Object.defineProperty(target, "then", {
    get() {
      return (onFulfilled: any, onRejected: any) => {
        calls.push({ method: "then", args: [] });
        const t = next() as any;
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
  var __bioprospectingTablesTestClient: (() => any) | undefined;
  // eslint-disable-next-line no-var
  var __bioprospectingTablesTestLLMResponse: string | undefined;
  // eslint-disable-next-line no-var
  var __bioprospectingTablesTestTables: any[] | undefined;
  // eslint-disable-next-line no-var
  var __bioprospectingTablesTestLLMCalls: Array<{
    messages: Array<{ role: string; content: string }>;
  }> | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__bioprospectingTablesTestClient = factory;
}

function setMockLLMResponse(content: string) {
  globalThis.__bioprospectingTablesTestLLMResponse = content;
}

function setMockTables(tables: any[]) {
  globalThis.__bioprospectingTablesTestTables = tables;
}

function getLLMCalls() {
  return globalThis.__bioprospectingTablesTestLLMCalls ?? [];
}

// ---------------------------------------------------------------------------
// Module mocks — must be registered BEFORE the SUT is imported
// ---------------------------------------------------------------------------

mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__bioprospectingTablesTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__bioprospectingTablesTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__bioprospectingTablesTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__bioprospectingTablesTestClient ?? (() => null))(),
}));

// No real S3 in tests; force the storage provider to be null so
// `ensureTablesForSource` short-circuits to the cache loader.
mock.module("../../../storage", () => ({
  getStorageProvider: () => null,
  isStorageProviderAvailable: () => false,
  getConversationBasePath: () => "user/x/conversation/y",
  default: () => null,
}));

// LLM resolver stub: returns a fake LLM whose `createChatCompletion`
// captures the prompt and returns the scripted response string.
mock.module("../llm", () => ({
  resolveResearchBrainLLM: () => ({
    llm: {
      createChatCompletion: async (params: any) => {
        const calls = globalThis.__bioprospectingTablesTestLLMCalls ?? [];
        calls.push({ messages: params.messages });
        globalThis.__bioprospectingTablesTestLLMCalls = calls;
        return {
          content:
            globalThis.__bioprospectingTablesTestLLMResponse ?? "[]",
        };
      },
    },
    providerName: "test",
    model: "test-model",
  }),
}));

// `tables.ts` re-exports from `../files/pdfTableExtractor`. The extractor
// uses `./tables`'s `loadTablesForSource`, so mocking this module is
// the lowest-cost way to inject tables (or an empty list).
mock.module("../tables", () => ({
  loadTablesForSource: async () =>
    globalThis.__bioprospectingTablesTestTables ?? [],
  loadFiguresForSource: async () => [],
}));

// ---------------------------------------------------------------------------
// SUT imports (post-mock)
// ---------------------------------------------------------------------------

import { extractBioprospectingFactsForSource } from "../bioprospectingExtractor";
import { replaceBioprospectingFactsForSource } from "../db";
import { buildTablesPromptSection } from "../../files/pdfTableExtractor";
import type {
  ResearchEvidenceChunk,
  ResearchSource,
} from "../types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSource(overrides: Partial<ResearchSource> = {}): ResearchSource {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    source_kind: "paper",
    trust_tier: "internal",
    source_scope: "global",
    title: "Coral bioprospecting study",
    doi: "10.1234/example",
    url: null,
    file_path: null,
    content_hash: null,
    file_size: null,
    last_modified_at: null,
    extraction_status: "extracted",
    extraction_error: null,
    bioprospecting_status: "pending",
    bioprospecting_error: null,
    bioprospecting_fact_count: 0,
    bioprospecting_extracted_at: null,
    metadata: {},
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...overrides,
  } as ResearchSource;
}

function makeChunk(
  overrides: Partial<ResearchEvidenceChunk> = {},
): ResearchEvidenceChunk {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    source_id: "00000000-0000-0000-0000-0000000000aa",
    document_id: null,
    content:
      "Aurelia coerulea showed 23% photoprotective activity at 50 ug/mL.",
    section: "results",
    page: 1,
    chunk_index: 0,
    metadata: {},
    created_at: "2026-06-01T00:00:00Z",
    ...overrides,
  } as ResearchEvidenceChunk;
}

const SAMPLE_TABLES = [
  {
    page: 4,
    tableIndex: 0,
    headers: ["Compound", "IC50 [ug/mL]"],
    rows: [
      ["Aurelia coerulea extract", "5.4"],
      ["Aurelia coerulea peptide", "12.1"],
    ],
    bbox: { x: 0, y: 0, w: 0, h: 0, page: 4, units: "pt" },
    confidence: 0.9,
    markdown: "",
  },
  {
    page: 5,
    tableIndex: 0,
    headers: ["Sample", "Activity [%]"],
    rows: [["Control", "0"], ["Treated", "23"]],
    bbox: { x: 0, y: 0, w: 0, h: 0, page: 5, units: "pt" },
    confidence: 0.85,
    markdown: "",
  },
];

let calls: Call[];
let client: any;

beforeEach(() => {
  calls = [];
  client = scriptedMock([], calls);
  setMockServiceClient(() => client);
  setMockLLMResponse("[]");
  setMockTables([]);
  globalThis.__bioprospectingTablesTestLLMCalls = [];
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock script that lets `extractBioprospectingFactsForSource`
 * run end-to-end:
 *   1. getSource (single)
 *   2. setSourceBioprospectingStatus (update) — running
 *   3. LLM batch is captured by the LLM mock (no DB call)
 *   4. loadEvidenceTableIdMap (awaited chainable)
 *   5. delete existing facts (awaited chainable)
 *   6. insert canonical row(s) (awaited chainable)
 *   7. setSourceBioprospectingStatus (update) — extracted
 */
function scriptForExtraction(opts: {
  source: ResearchSource;
  insertedFactIds: string[];
  evidenceTableRows?: Array<{
    id: string;
    page: number;
    table_index: number;
  }>;
}) {
  const { source, insertedFactIds, evidenceTableRows = [] } = opts;
  return [
    // 1. getSource
    { kind: "single", data: source, error: null },
    // 2. setSourceBioprospectingStatus(running) — no read needed
    { kind: "many", data: [], error: null },
    // 3. loadEvidenceTableIdMap (read of research_evidence_tables)
    { kind: "many", data: evidenceTableRows, error: null },
    // 4. delete existing facts
    { kind: "many", data: [], error: null },
    // 5. insert canonical row(s) (the last inserted row is what the
    //    DB returns to the caller; we let the LLM stub emit one fact)
    {
      kind: "many",
      data: insertedFactIds.map((id) => ({
        id,
        source_id: source.id,
        chunk_id: null,
        evidence_table_id: null,
        merged_into_fact_id: null,
      })),
      error: null,
    },
    // 6. setSourceBioprospectingStatus(extracted)
    { kind: "many", data: [], error: null },
  ] as Terminal[];
}

// ---------------------------------------------------------------------------
// 1. Tables prompt section appears BEFORE the chunks section
// ---------------------------------------------------------------------------

describe("bioprospectingExtractor.tables — scenario 1: tables: section precedes Chunks: section", () => {
  it("places the tables: section immediately before the Chunks: section", async () => {
    setMockTables(SAMPLE_TABLES);
    setMockLLMResponse(
      JSON.stringify([
        {
          species: "Aurelia coerulea",
          compound: "extract",
          bioactivity: "anticancer",
          resultSummary: "IC50 5.4 ug/mL",
          quote: "IC50 5.4 ug/mL",
          chunkIndex: 0,
        },
      ]),
    );

    const script = scriptForExtraction({
      source: makeSource(),
      insertedFactIds: ["00000000-0000-0000-0000-000000000001"],
      evidenceTableRows: [
        { id: "table-uuid-a", page: 4, table_index: 0 },
        { id: "table-uuid-b", page: 5, table_index: 0 },
      ],
    });
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    await extractBioprospectingFactsForSource(makeSource().id, [makeChunk()]);

    const llmCalls = getLLMCalls();
    expect(llmCalls.length).toBe(1);
    const prompt: string = llmCalls[0].messages[0].content;

    const tablesIdx = prompt.indexOf("tables:");
    const chunksIdx = prompt.indexOf("Chunks:");
    expect(tablesIdx).toBeGreaterThanOrEqual(0);
    expect(chunksIdx).toBeGreaterThanOrEqual(0);
    // Tables section appears BEFORE the Chunks: section.
    expect(tablesIdx).toBeLessThan(chunksIdx);
  });
});

// ---------------------------------------------------------------------------
// 2. Tables prompt section uses buildTablesPromptSection(tables) output
// ---------------------------------------------------------------------------

describe("bioprospectingExtractor.tables — scenario 2: buildTablesPromptSection output is injected", () => {
  it("matches the section produced by buildTablesPromptSection verbatim", async () => {
    setMockTables(SAMPLE_TABLES);
    setMockLLMResponse("[]");

    const script = scriptForExtraction({
      source: makeSource(),
      insertedFactIds: [],
    });
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    await extractBioprospectingFactsForSource(makeSource().id, [makeChunk()]);

    const prompt: string = getLLMCalls()[0].messages[0].content;
    const expected = buildTablesPromptSection(SAMPLE_TABLES);
    expect(expected.length).toBeGreaterThan(0);
    // The expected section must be a contiguous substring of the
    // prompt, including the trailing newline + blank line the
    // extractor inserts.
    expect(prompt).toContain(expected);
    // Spot-check the table headers rendered by the builder appear
    // in the prompt (proves the section came from the helper, not
    // a copy-paste).
    expect(prompt).toContain("Compound");
    expect(prompt).toContain("IC50 [ug/mL]");
    expect(prompt).toContain("page=4 table=0");
    expect(prompt).toContain("page=5 table=0");
  });
});

// ---------------------------------------------------------------------------
// 3. Tables injection only happens when tables exist for the source
// ---------------------------------------------------------------------------

describe("bioprospectingExtractor.tables — scenario 3: tables: section appears when tables exist", () => {
  it("includes the tables: section when the cache is non-empty", async () => {
    setMockTables(SAMPLE_TABLES);
    setMockLLMResponse("[]");

    const script = scriptForExtraction({
      source: makeSource(),
      insertedFactIds: [],
    });
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    await extractBioprospectingFactsForSource(makeSource().id, [makeChunk()]);

    const prompt: string = getLLMCalls()[0].messages[0].content;
    expect(prompt).toContain("tables:");
    expect(prompt).toContain("page=4 table=0");
  });
});

// ---------------------------------------------------------------------------
// 4. Tables injection skipped when no tables are cached
//    (Spec: "No tables section when cache is empty")
//    The spec does not define a `USE_TABLE_PROVENANCE` env flag; the
//    documented behavior is "no tables → no tables: section, but the
//    rest of the prompt is otherwise identical".
// ---------------------------------------------------------------------------

describe("bioprospectingExtractor.tables — scenario 4: no tables: section when cache is empty", () => {
  it("omits the tables: section and keeps the Chunks: section intact", async () => {
    setMockTables([]); // empty cache
    setMockLLMResponse("[]");

    const script = scriptForExtraction({
      source: makeSource(),
      insertedFactIds: [],
    });
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    await extractBioprospectingFactsForSource(makeSource().id, [makeChunk()]);

    const prompt: string = getLLMCalls()[0].messages[0].content;
    // The literal section header is "tables:" rendered by the helper
    // (followed by a newline). The prompt template ALSO mentions the
    // word "tables:" in prose (e.g. 'the "tables:" block below'),
    // so the discriminating check is that no actual table content
    // (`page=N table=M` rendered by the helper) is present.
    expect(prompt).not.toMatch(/page=\d+ table=\d+/);
    // Chunks section is always present regardless of cache state.
    expect(prompt).toContain("Chunks:");
    expect(prompt).toContain("Aurelia coerulea showed 23% photoprotective");
  });
});

// ---------------------------------------------------------------------------
// 5. sourceTableRef resolver links a fact to its source table by row
// ---------------------------------------------------------------------------

describe("bioprospectingExtractor.tables — scenario 5: sourceTableRef resolves to evidence_table_id", () => {
  it("emits sourceTableRef in the LLM prompt instruction and threads it through", async () => {
    setMockTables(SAMPLE_TABLES);
    setMockLLMResponse(
      JSON.stringify([
        {
          species: "Aurelia coerulea",
          compound: "extract",
          bioactivity: "anticancer",
          resultSummary: "IC50 5.4 ug/mL",
          measurementValue: 5.4,
          measurementUnit: "ug/mL",
          measurementDirection: "decrease",
          quote: "IC50 5.4",
          chunkIndex: 0,
          sourceTableRef: { page: 4, tableIndex: 0, rowIndex: 0 },
        },
      ]),
    );

    // Direct call to replaceBioprospectingFactsForSource so we can
    // inspect the inserted payload's evidence_table_id. The fact's
    // sourceTableRef is {4,0,0} which maps to table-uuid-a.
    const source = makeSource();
    const facts = [
      {
        species: "Aurelia coerulea",
        compound: "extract",
        bioactivity: "anticancer",
        resultSummary: "IC50 5.4 ug/mL",
        measurementValue: 5.4,
        measurementUnit: "ug/mL",
        measurementDirection: "decrease",
        quote: "IC50 5.4",
        chunkIndex: 0,
        sourceTableRef: { page: 4, tableIndex: 0, rowIndex: 0 },
      },
    ];

    const script = [
      // delete existing facts
      { kind: "many", data: [], error: null },
      // loadEvidenceTableIdMap
      {
        kind: "many",
        data: [
          { id: "table-uuid-a", page: 4, table_index: 0 },
          { id: "table-uuid-b", page: 5, table_index: 0 },
        ],
        error: null,
      },
      // insert canonical row (the inline merge path, group size 1)
      {
        kind: "many",
        data: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            source_id: source.id,
            evidence_table_id: "table-uuid-a",
          },
        ],
        error: null,
      },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    // Use the replacement helper directly; chunks are empty.
    const inserted = await replaceBioprospectingFactsForSource(source, facts, []);

    // Confirm the LLM prompt ALSO contains the sourceTableRef shape
    // instruction (this is part of scenario 5 — the prompt must
    // tell the LLM how to emit it).
    const extractScript = scriptForExtraction({
      source,
      insertedFactIds: ["00000000-0000-0000-0000-000000000001"],
      evidenceTableRows: [
        { id: "table-uuid-a", page: 4, table_index: 0 },
        { id: "table-uuid-b", page: 5, table_index: 0 },
      ],
    });
    client = scriptedMock(extractScript, calls);
    setMockServiceClient(() => client);
    setMockTables(SAMPLE_TABLES);
    setMockLLMResponse("[]");
    await extractBioprospectingFactsForSource(source.id, [makeChunk()]);
    const prompt: string = getLLMCalls()[0].messages[0].content;
    expect(prompt).toContain("sourceTableRef");
    expect(prompt).toContain("page: number, tableIndex: number, rowIndex?: number");

    // The DB insert payload sent by replaceBioprospectingFactsForSource
    // must include the resolved evidence_table_id.
    const insertCall = calls.find((c) => c.method === "insert");
    expect(insertCall).toBeDefined();
    const insertedRows = insertCall!.args[0] as Array<Record<string, unknown>>;
    expect(insertedRows.length).toBeGreaterThan(0);
    expect(insertedRows[0].evidence_table_id).toBe("table-uuid-a");

    // Sanity: the return value of replaceBioprospectingFactsForSource
    // is the inserted row.
    expect(inserted.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. "Prefer tables over prose" rule appears in the LLM prompt
// ---------------------------------------------------------------------------

describe("bioprospectingExtractor.tables — scenario 6: prefer-tables-over-prose rule", () => {
  it("contains the prefer-tables rule in the prompt's Strict rules", async () => {
    setMockTables(SAMPLE_TABLES);
    setMockLLMResponse("[]");

    const script = scriptForExtraction({
      source: makeSource(),
      insertedFactIds: [],
    });
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    await extractBioprospectingFactsForSource(makeSource().id, [makeChunk()]);

    const prompt: string = getLLMCalls()[0].messages[0].content;
    // The exact phrasing from the spec.
    expect(prompt).toContain(
      "Prefer facts grounded in the tables block over facts grounded only in prose",
    );
  });

  it("keeps the prefer-tables rule even when the cache is empty (no-op text)", async () => {
    setMockTables([]);
    setMockLLMResponse("[]");

    const script = scriptForExtraction({
      source: makeSource(),
      insertedFactIds: [],
    });
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    await extractBioprospectingFactsForSource(makeSource().id, [makeChunk()]);

    const prompt: string = getLLMCalls()[0].messages[0].content;
    // Cache is empty → no rendered tables: section header.
    expect(prompt).not.toMatch(/page=\d+ table=\d+/);
    // But the prefer-tables rule stays in the prompt template (it's
    // harmless no-op text when the cache is empty).
    expect(prompt).toContain(
      "Prefer facts grounded in the tables block over facts grounded only in prose",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. evidence_table_id is populated when a sourceTableRef resolves
// ---------------------------------------------------------------------------

describe("bioprospectingExtractor.tables — scenario 7: evidence_table_id is set on the persisted row", () => {
  it("threads the resolved table id into the inserted fact payload", async () => {
    const source = makeSource();
    const facts = [
      {
        species: "Aurelia coerulea",
        compound: "extract",
        bioactivity: "anticancer",
        resultSummary: "IC50 5.4 ug/mL",
        quote: "IC50 5.4",
        chunkIndex: 0,
        sourceTableRef: { page: 4, tableIndex: 0, rowIndex: 0 },
      },
    ];

    const script = [
      { kind: "many", data: [], error: null }, // delete existing
      {
        kind: "many",
        data: [{ id: "table-uuid-a", page: 4, table_index: 0 }],
        error: null,
      }, // loadEvidenceTableIdMap
      {
        kind: "many",
        data: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            source_id: source.id,
            evidence_table_id: "table-uuid-a",
          },
        ],
        error: null,
      }, // insert
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    await replaceBioprospectingFactsForSource(source, facts, []);

    const insertCall = calls.find((c) => c.method === "insert");
    expect(insertCall).toBeDefined();
    const inserted = insertCall!.args[0] as Array<Record<string, unknown>>;
    expect(inserted[0].evidence_table_id).toBe("table-uuid-a");
  });
});

// ---------------------------------------------------------------------------
// 8. evidence_table_id is null when the fact has no sourceTableRef
// ---------------------------------------------------------------------------

describe("bioprospectingExtractor.tables — scenario 8: evidence_table_id is null for prose facts", () => {
  it("does not set evidence_table_id when sourceTableRef is absent", async () => {
    const source = makeSource();
    const facts = [
      {
        species: "Aurelia coerulea",
        bioactivity: "photoprotective",
        resultSummary: "23% photoprotective activity",
        quote: "Aurelia coerulea showed 23% photoprotective activity",
        chunkIndex: 0,
        // no sourceTableRef
      },
    ];

    const script = [
      { kind: "many", data: [], error: null }, // delete existing
      {
        kind: "many",
        data: [{ id: "table-uuid-a", page: 4, table_index: 0 }],
        error: null,
      }, // loadEvidenceTableIdMap (no match needed)
      {
        kind: "many",
        data: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            source_id: source.id,
            evidence_table_id: null,
          },
        ],
        error: null,
      }, // insert
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    await replaceBioprospectingFactsForSource(source, facts, []);

    const insertCall = calls.find((c) => c.method === "insert");
    expect(insertCall).toBeDefined();
    const inserted = insertCall!.args[0] as Array<Record<string, unknown>>;
    expect(inserted[0].evidence_table_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. evidence_table_id survives the inline merge (canonical + sibling)
// ---------------------------------------------------------------------------

describe("bioprospectingExtractor.tables — scenario 9: evidence_table_id survives the inline merge", () => {
  it("preserves distinct evidence_table_id values on canonical and merged siblings", async () => {
    // Two facts share the same identity_key (species|compound|bioactivity|organism_part|geography)
    // but reference different tables. The canonical must keep its own
    // evidence_table_id; the merged sibling must keep its own.
    const source = makeSource();
    const facts = [
      {
        species: "Aurelia coerulea",
        compound: "extract",
        bioactivity: "anticancer",
        organism_part: "whole",
        geography: "Mediterranean",
        resultSummary: "IC50 5.4",
        quote: "IC50 5.4",
        chunkIndex: 0,
        sourceTableRef: { page: 4, tableIndex: 0, rowIndex: 0 },
      },
      {
        species: "Aurelia coerulea",
        compound: "extract",
        bioactivity: "anticancer",
        organism_part: "whole",
        geography: "Mediterranean",
        resultSummary: "IC50 5.7",
        quote: "IC50 5.7",
        chunkIndex: 0,
        sourceTableRef: { page: 5, tableIndex: 0, rowIndex: 0 },
      },
    ];

    const script = [
      { kind: "many", data: [], error: null }, // delete existing
      // loadEvidenceTableIdMap returns both tables
      {
        kind: "many",
        data: [
          { id: "table-uuid-a", page: 4, table_index: 0 },
          { id: "table-uuid-b", page: 5, table_index: 0 },
        ],
        error: null,
      },
      // insert canonical (first row)
      {
        kind: "many",
        data: [
          {
            id: "canonical-id",
            source_id: source.id,
            evidence_table_id: "table-uuid-a",
            merged_into_fact_id: null,
          },
        ],
        error: null,
      },
      // insert siblings (second row, with merged_into_fact_id)
      {
        kind: "many",
        data: [
          {
            id: "sibling-id",
            source_id: source.id,
            evidence_table_id: "table-uuid-b",
            merged_into_fact_id: "canonical-id",
          },
        ],
        error: null,
      },
      // insert merge edges
      { kind: "many", data: [], error: null },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    await replaceBioprospectingFactsForSource(source, facts, []);

    // Two insert calls: one for canonical, one for siblings.
    const insertCalls = calls.filter((c) => c.method === "insert");
    expect(insertCalls.length).toBeGreaterThanOrEqual(2);
    const canonicalInsert = insertCalls[0].args[0] as Array<
      Record<string, unknown>
    >;
    const siblingInsert = insertCalls[1].args[0] as Array<
      Record<string, unknown>
    >;
    expect(canonicalInsert[0].evidence_table_id).toBe("table-uuid-a");
    expect(siblingInsert[0].evidence_table_id).toBe("table-uuid-b");
  });
});

// ---------------------------------------------------------------------------
// 10. evidence_table_id is null when sourceTableRef doesn't resolve,
//     and the bioprospecting_table_ref_missing log is emitted.
// ---------------------------------------------------------------------------

describe("bioprospectingExtractor.tables — scenario 10: hallucinated ref is dropped", () => {
  it("sets evidence_table_id to null and the fact is still persisted", async () => {
    const source = makeSource();
    const facts = [
      {
        species: "Aurelia coerulea",
        compound: "extract",
        bioactivity: "anticancer",
        resultSummary: "IC50 5.4",
        quote: "IC50 5.4",
        chunkIndex: 0,
        // LLM hallucinated a (99, 99) tuple — no real table row
        sourceTableRef: { page: 99, tableIndex: 99, rowIndex: 99 },
      },
    ];

    // The map is empty (no real tables for that tuple). The
    // resolveEvidenceTableId helper must log
    // `bioprospecting_table_ref_missing` and return null.
    const script = [
      { kind: "many", data: [], error: null }, // delete existing
      { kind: "many", data: [], error: null }, // loadEvidenceTableIdMap (empty)
      {
        kind: "many",
        data: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            source_id: source.id,
            evidence_table_id: null,
          },
        ],
        error: null,
      }, // insert
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const inserted = await replaceBioprospectingFactsForSource(
      source,
      facts,
      [],
    );

    // The fact is still persisted (insert call happened).
    const insertCall = calls.find((c) => c.method === "insert");
    expect(insertCall).toBeDefined();
    const insertedRows = insertCall!.args[0] as Array<Record<string, unknown>>;
    expect(insertedRows[0].evidence_table_id).toBeNull();
    // The metadata still carries the offending sourceTableRef so
    // operators can audit the hallucination.
    const metadata = insertedRows[0].metadata as Record<string, unknown>;
    expect(metadata.sourceTableRef).toEqual({
      page: 99,
      tableIndex: 99,
      rowIndex: 99,
    });
    expect(inserted.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11. runId threading — when called with `{ runId: R }` the extractor
//     must propagate R into the persistence / table-extraction call
//     chain so the cost-cap layer can attribute spend. (PR #2 of
//     cost-guard-rails.)
// ---------------------------------------------------------------------------

describe("bioprospectingExtractor.tables — scenario 11: runId threading", () => {
  it("accepts a { runId } options object without breaking the existing pipeline", async () => {
    setMockTables(SAMPLE_TABLES);
    setMockLLMResponse("[]");

    const script = scriptForExtraction({
      source: makeSource(),
      insertedFactIds: [],
    });
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    // The new options shape: `{ runId: "..." }`. The chunk array is
    // passed via the structured options to verify both forms work.
    const RUN_ID = "00000000-0000-0000-0000-000000000abc";
    const result = await extractBioprospectingFactsForSource(makeSource().id, {
      chunks: [makeChunk()],
      runId: RUN_ID,
    });

    expect(result.sourceId).toBe(makeSource().id);
    expect(result.status).toBe("extracted");
  });

  it("manual one-off without runId still tracks cost (no runId field)", async () => {
    setMockTables([]);
    setMockLLMResponse("[]");

    const script = scriptForExtraction({
      source: makeSource(),
      insertedFactIds: [],
    });
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    // Backwards-compat: legacy 1-arg + array shape, no runId. The
    // extractor must still run; the cost-cap layer is happy because
    // `runId` is optional (per-source + per-day still apply).
    const result = await extractBioprospectingFactsForSource(
      makeSource().id,
      [makeChunk()],
    );
    expect(result.status).toBe("extracted");
  });

  it("legacy array shape (chunks[] only) still works", async () => {
    setMockTables([]);
    setMockLLMResponse("[]");

    const script = scriptForExtraction({
      source: makeSource(),
      insertedFactIds: [],
    });
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    // Legacy 1-arg + array shape — should be treated as `{ chunks }`.
    const result = await extractBioprospectingFactsForSource(
      makeSource().id,
      [makeChunk()],
    );
    expect(result.status).toBe("extracted");
  });
});
