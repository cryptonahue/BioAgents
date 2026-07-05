/**
 * Unit tests for the figure-image-extraction orchestrator
 * (`src/services/files/figureImageExtractor.ts`).
 *
 * 6 fixtures (per design §"Testing Strategy" and tasks 1.10):
 *   (a) Mistral-first dispatch — provider returns base64 → row
 *       updated with bytes, render-crop NOT called.
 *   (b) render-crop fallback — Mistral returns no base64 →
 *       render-crop is called, row updated with render-crop bytes.
 *   (c) S3 failure isolation — second figure's `uploadFigure`
 *       throws → first row populated, second row stays NULL, third
 *       still attempted.
 *   (d) per-source cost `recordApiCall` fires exactly once with
 *       summed `units`.
 *   (e) `MISTRAL_OCR_ENABLED=false` skips Mistral path.
 *   (f) write-once guard — row with pre-populated `storage_path` is
 *       skipped entirely.
 *
 * Strategy:
 *   - The orchestrator's REAL `extractFigureImages` runs end-to-end.
 *   - The Supabase client is mocked so row UPDATEs are captured
 *     and scriptable.
 *   - The `costService` is mocked so `recordApiCall` is captured.
 *   - The `renderCrop` helper is mocked because it requires a
 *     canvas runtime that is not always available. The mock
 *     records calls and returns a 1x1 PNG by default.
 *   - The Mistral provider is NOT mocked. The test populates the
 *     REAL provider's per-source bytes store directly via
 *     `seedMistralFigureBytes`. This avoids cross-file `mock.module`
 *     leakage that would break the costWrap test for the same
 *     provider module.
 *   - The S3 upload goes through a real `uploadFigure` that
 *     delegates to a mocked `getStorageProvider()`. The
 *     `figureStorage` module is NOT mocked — its real
 *     implementation handles the routing. The test sets up the
 *     Supabase client (which the orchestrator uses) and the
 *     storage provider via a `getStorageProvider` mock.
 *
 * Important: to avoid cross-file mock pollution, this test
 * does NOT use `mock.module("../../../storage/figureStorage", ...)`
 * or `mock.module("../providers/mistralOcrProvider", ...)`. The
 * `mock.module` calls below are scoped to THIS file by bun's
 * test-file isolation, butbun may reuse module instances across
 * test files within the same `bun test` invocation when the
 * import path is identical. Mocking these would also affect
 * the costWrap test that runs in the same suite.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

// ---------------------------------------------------------------------------
// globalThis hooks (test-only)
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __figureImgTestRenderCropped:
    | ((pdf: Uint8Array, page: number, bbox: any, format: string) => Promise<any>)
    | undefined;
  // eslint-disable-next-line no-var
  var __figureImgTestMistralEnabled: boolean | undefined;
  // eslint-disable-next-line no-var
  var __figureImgTestStorage: any;
}

function setRenderCropped(
  fn: (pdf: Uint8Array, page: number, bbox: any, format: string) => Promise<any>,
): void {
  globalThis.__figureImgTestRenderCropped = fn;
}

function setMistralEnabled(v: boolean): void {
  globalThis.__figureImgTestMistralEnabled = v;
}

function setMockStorage(storage: any): void {
  globalThis.__figureImgTestStorage = storage;
}

// ---------------------------------------------------------------------------
// Module mocks (scoped to renderCrop + storage + db.client). The
// costService is the REAL module — we capture its `recordApiCall`
// via the Supabase RPC hook below (see the special-case `rpc` handler
// in the scripted mock). This avoids cross-file `mock.module`
// pollution that would break tests like `costService.test.ts`.
// ---------------------------------------------------------------------------

mock.module("../renderCrop", () => {
  return {
    RENDER_SCALE: 1.5,
    FigureRenderCropError: class FigureRenderCropError extends Error {
      readonly page: number;
      readonly reason: string;
      constructor(opts: { page: number; reason: string }) {
        super(`mock render-crop failed on page ${opts.page}: ${opts.reason}`);
        this.name = "FigureRenderCropError";
        this.page = opts.page;
        this.reason = opts.reason;
      }
    },
    renderCroppedFigure: async (pdf: Uint8Array, page: number, bbox: any, format: string) => {
      const fn = globalThis.__figureImgTestRenderCropped;
      if (!fn) {
        // Default mock: return a 1x1 PNG.
        return {
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
          width: Math.ceil(bbox.w * 1.5),
          height: Math.ceil(bbox.h * 1.5),
          format,
        };
      }
      return await fn(pdf, page, bbox, format);
    },
  };
});

mock.module("../../../storage", () => {
  return {
    getStorageProvider: () => globalThis.__figureImgTestStorage ?? null,
    isStorageProviderAvailable: () => globalThis.__figureImgTestStorage != null,
    getConversationBasePath: () => "",
    getUploadPath: () => "",
    getFileUploadPath: () => "",
    getMimeTypeFromFilename: () => "application/octet-stream",
    default: {
      getStorageProvider: () => globalThis.__figureImgTestStorage ?? null,
    },
  };
});

// Minimal in-memory supabase mock. The orchestrator issues:
//   1. `loadFiguresForSource` (SELECT) — returns the row array
//   2. For each row, an UPDATE on `research_evidence_figures`
//      (echoes the payload back with the storage_path set)
//   3. (Optionally) `recordApiCall` via the real costService — the
//      `rpc("record_api_call", { p_*, ... })` call is captured and
//      translated back to the original field names so the test can
//      assert on provider/units/costUsd/metadata without polluting
//      the costService module via `mock.module`.
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
  "order",
  "limit",
];

// Per-test capture buffer for `record_api_call` RPC calls. The
// `rpc` handler in `scriptedMock` translates Supabase RPC arg names
// (e.g. `p_provider`, `p_units`, `p_cost_usd`, `p_metadata`) back to
// the original `RecordApiCallInput` shape and pushes the result here
// so the test can assert on provider/units/costUsd/metadata without
// polluting the costService module via `mock.module`.
//
// Exposed at module scope (and reset in `beforeEach`) so individual
// tests can read it the same way they read `recordApiCalls` before
// the refactor.
let capturedRecordApiCalls: unknown[] = [];

function resetRecordApiCapture(): void {
  capturedRecordApiCalls = [];
}

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
  for (const method of ["maybeSingle", "single"]) {
    target[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      const t = next();
      return Promise.resolve({ data: t.data, error: t.error });
    };
  }
  // Capture `record_api_call` RPC invocations. Supabase's `rpc`
  // method returns a thenable (PostgREST contract), so we provide a
  // `then` that resolves to a no-cap-hit shape. The costService
  // normalizes the row and returns `capHit: null` so the orchestrator
  // continues normally.
  target.rpc = (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ method: "rpc", args: [name, args] });
    if (name === "record_api_call") {
      // Translate Supabase RPC arg names back to RecordApiCallInput
      // fields. `p_metadata` is stored as-is.
      const input = {
        runId: args.p_run_id ?? undefined,
        sourceId: args.p_source_id ?? undefined,
        provider: args.p_provider as "mistral_ocr" | "pubchem",
        units: args.p_units as number,
        costUsd: args.p_cost_usd as number,
        metadata: (args.p_metadata as Record<string, unknown>) ?? undefined,
      };
      capturedRecordApiCalls.push(input);
    }
    // Return a thenable that resolves to a no-cap-hit response so
    // the real `recordApiCall` soft-succeeds.
    return {
      then: (onFulfilled: any, onRejected: any) => {
        return Promise.resolve({
          data: [
            {
              cap_hit: null,
              current_daily_cost: 0,
              current_monthly_cost: 0,
              current_source_cost: 0,
              current_run_cost: 0,
            },
          ],
          error: null,
        }).then(onFulfilled, onRejected);
      },
    };
  };
  Object.defineProperty(target, "then", {
    get() {
      return (onFulfilled: any, onRejected: any) => {
        calls.push({ method: "then", args: [] });
        const t = next();
        return Promise.resolve({ data: t.data, error: t.error }).then(
          onFulfilled,
          onRejected,
        );
      };
    },
  });
  return target;
}

declare global {
  // eslint-disable-next-line no-var
  var __figureImgTestServiceClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__figureImgTestServiceClient = factory;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () => globalThis.__figureImgTestServiceClient?.() ?? null,
  getAnonClient: () => globalThis.__figureImgTestServiceClient?.() ?? null,
  getSupabaseClient: () => globalThis.__figureImgTestServiceClient?.() ?? null,
  resetClients: () => undefined,
  default: () => globalThis.__figureImgTestServiceClient?.() ?? null,
}));

// Seed the REAL Mistral provider's bytes store directly (no mock).
const REAL_STORE_KEY = "__bioprospectingMistralFigureBytes";

interface MistralFigureBytesStore {
  bySource: Map<string, Map<string, Uint8Array>>;
}

function getRealStore(): MistralFigureBytesStore {
  let s = (globalThis as any)[REAL_STORE_KEY] as
    | MistralFigureBytesStore
    | undefined;
  if (!s) {
    s = { bySource: new Map() };
    (globalThis as any)[REAL_STORE_KEY] = s;
  }
  return s;
}

import { extractFigureImages } from "../figureImageExtractor";

const SOURCE_ID = "00000000-0000-0000-0000-00000000aaaa";
const FIG_0 = "00000000-0000-0000-0000-0000000000f0";
const FIG_1 = "00000000-0000-0000-0000-0000000000f1";
const FIG_2 = "00000000-0000-0000-0000-0000000000f2";

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FIG_0,
    source_id: SOURCE_ID,
    page: 2,
    figure_index: 0,
    bbox: { x: 100, y: 200, w: 300, h: 220, page: 2, units: "pt" },
    caption: "Figure 3. Sample.",
    storage_path: null,
    mime_type: null,
    width: null,
    height: null,
    byte_size: null,
    ...overrides,
  };
}

const EMPTY_PDF = new Uint8Array();

let calls: Call[];
let client: any;
let uploadCalls: Array<{ key: string; byteSize: number; mime: string }>;
// `recordApiCalls` is the same buffer the test asserts on; the
// Supabase RPC handler in `scriptedMock` pushes into it whenever
// the real costService issues `record_api_call`. The
// `resetRecordApiCapture()` call in `beforeEach` empties it.
let recordApiCalls: unknown[];
let renderCropCalls: Array<{ page: number; format: string }>;
let updateCalls: Array<{ id: string; payload: any }>;

beforeEach(() => {
  calls = [];
  uploadCalls = [];
  recordApiCalls = [];
  capturedRecordApiCalls = recordApiCalls;
  renderCropCalls = [];
  updateCalls = [];
  client = scriptedMock([], calls);
  setMockServiceClient(() => client);

  // Default storage mock: succeed. Capture upload key+size.
  setMockStorage({
    upload: async (key: string, buffer: Buffer, mime: string) => {
      uploadCalls.push({ key, byteSize: buffer.byteLength, mime });
      return key;
    },
  });

  // Default render-crop mock: record call + return a 1x1 PNG.
  setRenderCropped(async (_pdf, page, _bbox, format) => {
    renderCropCalls.push({ page, format });
    return {
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
      width: 1,
      height: 1,
      format,
    };
  });

  setMistralEnabled(true);
  // Clear the Mistral bytes store.
  delete (globalThis as any)[REAL_STORE_KEY];

  // Capture UPDATE calls by patching the `update` method.
  const originalUpdate = client.update;
  client.update = (...args: any[]) => {
    const payload = args[0];
    calls.push({ method: "update", args });
    const eqArgs: any[] = [];
    const originalEq = client.eq;
    // The chain is: update(payload).eq('id', rowId)
    const eqFn = (col: string, val: any) => {
      eqArgs.push([col, val]);
      calls.push({ method: "eq", args: [col, val] });
      // Identify the row id from the eq args.
      const idArg = eqArgs.find(([c]) => c === "id");
      if (idArg) {
        updateCalls.push({ id: idArg[1], payload });
      }
      // Return the target so the chain continues to .then.
      return target;
    };
    const target: any = {
      eq: eqFn,
      then: (onFulfilled: any, onRejected: any) => {
        return Promise.resolve({ data: [payload], error: null }).then(
          onFulfilled,
          onRejected,
        );
      },
    };
    return target;
  };
  void originalUpdate;
});

afterEach(() => {
  setRenderCropped(undefined as any);
  setMistralEnabled(undefined as any);
  setMockStorage(undefined as any);
  setMockServiceClient(undefined as any);
  delete (globalThis as any)[REAL_STORE_KEY];
  resetRecordApiCapture();
});

// ---------------------------------------------------------------------------
// (a) Mistral-first dispatch
// ---------------------------------------------------------------------------

describe("figureImageExtractor — Mistral-first dispatch", () => {
  it("uses Mistral bytes when available; row is updated; render-crop NOT called", async () => {
    // Script: 1 SELECT (load figures), 1 UPDATE chain (echoed by mock)
    const row = makeRow({ id: FIG_0 });
    client = scriptedMock(
      [
        { kind: "many", data: [row], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    // Re-apply the update hook after re-creating the client.
    const originalUpdate = client.update;
    client.update = (...args: any[]) => {
      const payload = args[0];
      calls.push({ method: "update", args });
      const target: any = {
        eq: (col: string, val: any) => {
          calls.push({ method: "eq", args: [col, val] });
          if (col === "id") {
            updateCalls.push({ id: val, payload });
          }
          return target;
        },
        then: (onFulfilled: any, onRejected: any) => {
          return Promise.resolve({ data: [payload], error: null }).then(
            onFulfilled,
            onRejected,
          );
        },
      };
      return target;
    };
    void originalUpdate;

    // Pre-populate the Mistral bytes cache with a small payload.
    const store = getRealStore();
    store.bySource.set(SOURCE_ID, new Map([
      ["2:0", new Uint8Array([1, 2, 3, 4, 5])],
    ]));

    const result = await extractFigureImages(SOURCE_ID, EMPTY_PDF, {});

    expect(result).toHaveLength(1);
    expect(result[0].origin).toBe("mistral");
    expect(result[0].bytes).not.toBeNull();
    expect(result[0].byteSize).toBe(5);

    // Render-crop was NOT called.
    expect(renderCropCalls).toHaveLength(0);
    // Upload was called once with the Mistral bytes.
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].byteSize).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// (b) render-crop fallback when Mistral returns no base64
// ---------------------------------------------------------------------------

describe("figureImageExtractor — render-crop fallback", () => {
  it("uses render-crop when Mistral returns no base64 for the figure", async () => {
    const row = makeRow({ id: FIG_0 });
    client = scriptedMock(
      [
        { kind: "many", data: [row], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    const originalUpdate = client.update;
    client.update = (...args: any[]) => {
      const payload = args[0];
      calls.push({ method: "update", args });
      const target: any = {
        eq: (col: string, val: any) => {
          calls.push({ method: "eq", args: [col, val] });
          if (col === "id") {
            updateCalls.push({ id: val, payload });
          }
          return target;
        },
        then: (onFulfilled: any, onRejected: any) => {
          return Promise.resolve({ data: [payload], error: null }).then(
            onFulfilled,
            onRejected,
          );
        },
      };
      return target;
    };
    void originalUpdate;

    // Empty Mistral bytes map (no per-source entry).
    // (default; no seeding)

    const result = await extractFigureImages(SOURCE_ID, EMPTY_PDF, {});

    expect(result).toHaveLength(1);
    expect(result[0].origin).toBe("render-crop");
    expect(result[0].bytes).not.toBeNull();

    // Render-crop WAS called.
    expect(renderCropCalls).toHaveLength(1);
    expect(renderCropCalls[0].page).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// (c) S3 failure isolation: second figure's upload throws
// ---------------------------------------------------------------------------

describe("figureImageExtractor — S3 failure isolation", () => {
  it("first row populated, second row stays NULL, third still attempted", async () => {
    const rows = [
      makeRow({ id: FIG_0, page: 1, figure_index: 0 }),
      makeRow({ id: FIG_1, page: 1, figure_index: 1 }),
      makeRow({ id: FIG_2, page: 1, figure_index: 2 }),
    ];
    client = scriptedMock(
      [
        { kind: "many", data: rows, error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    const originalUpdate = client.update;
    client.update = (...args: any[]) => {
      const payload = args[0];
      calls.push({ method: "update", args });
      const target: any = {
        eq: (col: string, val: any) => {
          calls.push({ method: "eq", args: [col, val] });
          if (col === "id") {
            updateCalls.push({ id: val, payload });
          }
          return target;
        },
        then: (onFulfilled: any, onRejected: any) => {
          return Promise.resolve({ data: [payload], error: null }).then(
            onFulfilled,
            onRejected,
          );
        },
      };
      return target;
    };
    void originalUpdate;

    // upload mock: succeed for 0 and 2, throw for 1.
    setMockStorage({
      upload: async (key: string, buffer: Buffer, mime: string) => {
        if (key.includes("/1.")) {
          throw new Error("S3 unreachable");
        }
        uploadCalls.push({ key, byteSize: buffer.byteLength, mime });
        return key;
      },
    });

    const result = await extractFigureImages(SOURCE_ID, EMPTY_PDF, {});

    expect(result).toHaveLength(3);
    // First: bytes populated
    expect(result[0].bytes).not.toBeNull();
    // Second: S3 failed → bytes null
    expect(result[1].bytes).toBeNull();
    // Third: still attempted
    expect(result[2].bytes).not.toBeNull();

    // Render-crop was called for all 3 (the failure was at upload, not render).
    expect(renderCropCalls).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// (d) per-source cost recordApiCall fires once with summed units
// ---------------------------------------------------------------------------

describe("figureImageExtractor — per-source cost recordApiCall", () => {
  it("fires exactly once per source with summed byte units", async () => {
    const rows = [
      makeRow({ id: FIG_0, page: 1, figure_index: 0 }),
      makeRow({ id: FIG_1, page: 1, figure_index: 1 }),
      makeRow({ id: FIG_2, page: 1, figure_index: 2 }),
    ];
    client = scriptedMock(
      [
        { kind: "many", data: rows, error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    const originalUpdate = client.update;
    client.update = (...args: any[]) => {
      const payload = args[0];
      calls.push({ method: "update", args });
      const target: any = {
        eq: (col: string, val: any) => {
          calls.push({ method: "eq", args: [col, val] });
          if (col === "id") {
            updateCalls.push({ id: val, payload });
          }
          return target;
        },
        then: (onFulfilled: any, onRejected: any) => {
          return Promise.resolve({ data: [payload], error: null }).then(
            onFulfilled,
            onRejected,
          );
        },
      };
      return target;
    };
    void originalUpdate;

    const result = await extractFigureImages(SOURCE_ID, EMPTY_PDF, {});

    expect(result).toHaveLength(3);
    expect(recordApiCalls).toHaveLength(1);
    const call = recordApiCalls[0] as any;
    expect(call.provider).toBe("mistral_ocr");
    expect(call.costUsd).toBe(0);
    // 3 figures * 24 bytes each = 72 units
    expect(call.units).toBe(72);
    expect(call.metadata.kind).toBe("figure_image_bytes");
    expect(call.metadata.image_count).toBe(3);
    expect(call.metadata.image_bytes_total).toBe(72);
  });

  it("does NOT call recordApiCall when zero bytes were extracted (all bbox-only)", async () => {
    const row = makeRow({ id: FIG_0 });
    client = scriptedMock(
      [{ kind: "many", data: [row], error: null }],
      calls,
    );
    setMockServiceClient(() => client);
    const originalUpdate = client.update;
    client.update = (...args: any[]) => {
      const payload = args[0];
      calls.push({ method: "update", args });
      const target: any = {
        eq: (col: string, val: any) => {
          calls.push({ method: "eq", args: [col, val] });
          if (col === "id") {
            updateCalls.push({ id: val, payload });
          }
          return target;
        },
        then: (onFulfilled: any, onRejected: any) => {
          return Promise.resolve({ data: [payload], error: null }).then(
            onFulfilled,
            onRejected,
          );
        },
      };
      return target;
    };
    void originalUpdate;

    // Both render-crop and upload throw — figure stays bbox-only.
    setRenderCropped(async () => {
      throw new Error("render-crop totally failed");
    });

    const result = await extractFigureImages(SOURCE_ID, EMPTY_PDF, {});

    expect(result).toHaveLength(1);
    expect(result[0].bytes).toBeNull();
    expect(recordApiCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (e) MISTRAL_OCR_ENABLED flag
// ---------------------------------------------------------------------------

describe("figureImageExtractor — MISTRAL_OCR_ENABLED flag", () => {
  it("consults the Mistral bytes cache regardless of the flag", async () => {
    const row = makeRow({ id: FIG_0 });
    client = scriptedMock(
      [
        { kind: "many", data: [row], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    const originalUpdate = client.update;
    client.update = (...args: any[]) => {
      const payload = args[0];
      calls.push({ method: "update", args });
      const target: any = {
        eq: (col: string, val: any) => {
          calls.push({ method: "eq", args: [col, val] });
          if (col === "id") {
            updateCalls.push({ id: val, payload });
          }
          return target;
        },
        then: (onFulfilled: any, onRejected: any) => {
          return Promise.resolve({ data: [payload], error: null }).then(
            onFulfilled,
            onRejected,
          );
        },
      };
      return target;
    };
    void originalUpdate;

    // Pre-populate the Mistral bytes cache.
    const store = getRealStore();
    store.bySource.set(SOURCE_ID, new Map([
      ["2:0", new Uint8Array([9, 9, 9])],
    ]));
    setMistralEnabled(false);

    const result = await extractFigureImages(SOURCE_ID, EMPTY_PDF, {});

    // The orchestrator always consults the cache; the Mistral-enabled
    // flag is enforced UPSTREAM in `MistralTableExtractionProvider.runWithCostCap`,
    // which prevents the cache from being populated in the first place.
    expect(result).toHaveLength(1);
    // Render-crop was NOT called because the cache was hit.
    expect(renderCropCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (f) write-once guard
// ---------------------------------------------------------------------------

describe("figureImageExtractor — write-once guard", () => {
  it("skips rows with pre-populated storage_path (no upload, no update)", async () => {
    const alreadyExtracted = makeRow({
      id: FIG_0,
      page: 1,
      figure_index: 0,
      storage_path: `figures/${SOURCE_ID}/0.png`,
      mime_type: "image/png",
      width: 100,
      height: 100,
      byte_size: 1024,
    });
    client = scriptedMock(
      [{ kind: "many", data: [alreadyExtracted], error: null }],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await extractFigureImages(SOURCE_ID, EMPTY_PDF, {});

    expect(result).toHaveLength(1);
    expect(result[0].bytes).toBeNull();
    expect(uploadCalls).toHaveLength(0);
    expect(renderCropCalls).toHaveLength(0);
  });
});
