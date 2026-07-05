/**
 * Structured-log coverage for the PR #2 PDF provenance viewer
 * endpoints in `src/routes/research-brain.ts`.
 *
 * Why a sibling file?
 *   The existing `research-brain.provenance.test.ts` mocks the
 *   Supabase client and the storage provider, but does NOT touch the
 *   logger. For these three tests we need to mock `../../utils/logger`
 *   with a spy that captures the structured `(payload, message)`
 *   arguments passed to `logger.error`. Replacing the logger at the
 *   module level would alter the noise floor for the 14 existing
 *   tests in the sibling file, so we keep the new behavior isolated
 *   here.
 *
 * Why no `services/researchBrain` mock?
 *   Bun's `mock.module` is process-scoped: once we register a mock
 *   for `../../services/researchBrain` in this file it would also
 *   override the real module for the sibling test file when both
 *   run in the same process. Instead we drive the failure by
 *   poisoning the scriptable Supabase chain — see
 *   `withThrowingFrom()` below.
 *
 * Test coverage (per design §6.4):
 *   1. `research_brain_evidence_failed`     — /evidence endpoint
 *   2. `research_brain_pdf_failed`          — /pdf endpoint
 *   3. `research_brain_provenance_failed`   — /provenance endpoint
 *
 * Each test forces the handler's `catch` block to fire by making the
 * underlying Supabase or storage call reject, then asserts:
 *   - `logger.error` was called exactly once
 *   - the message string equals the documented log event name
 *   - the payload carries the right id (sourceId | factId)
 *   - the payload's `err` field preserves the original error
 *   - the HTTP response surfaces the 5xx status
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Logger spy — captured BEFORE the route module is imported.
// ---------------------------------------------------------------------------

type LogCall = { message: string; payload: Record<string, unknown> | undefined };

const errorCalls: LogCall[] = [];
const warnCalls: LogCall[] = [];
const infoCalls: LogCall[] = [];

function resetLogCalls() {
  errorCalls.length = 0;
  warnCalls.length = 0;
  infoCalls.length = 0;
}

mock.module("../../utils/logger", () => {
  const makeRecorder = (sink: LogCall[]) =>
    mock((payload?: Record<string, unknown>, message?: string) => {
      sink.push({ message: String(message ?? ""), payload: payload });
      return undefined;
    });
  return {
    default: {
      error: makeRecorder(errorCalls),
      warn: makeRecorder(warnCalls),
      info: makeRecorder(infoCalls),
      debug: makeRecorder([] as LogCall[]),
      trace: makeRecorder([] as LogCall[]),
      fatal: makeRecorder([] as LogCall[]),
    },
  };
});

// ---------------------------------------------------------------------------
// Scriptable Supabase client — same shape as the sibling test, with a
// small extension that lets a per-test builder method reject instead
// of returning the chainable. That rejection is what surfaces in the
// route handler's catch block.
// ---------------------------------------------------------------------------

type Call = { method: string; args: unknown[] };
type Terminal =
  | { kind: "single"; data: unknown; error: unknown }
  | { kind: "many"; data: unknown[]; error: null }
  | { kind: "throw"; error: unknown };

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
      if (t.kind === "throw") {
        return Promise.reject(t.error);
      }
      return Promise.resolve({ data: t.data, error: t.error });
    };
  }
  Object.defineProperty(target, "then", {
    get() {
      return (onFulfilled: any, onRejected: any) => {
        calls.push({ method: "then", args: [] });
        const t = next();
        if (t.kind === "throw") {
          return Promise.reject(t.error).then(onFulfilled, onRejected);
        }
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
  var __provenanceLoggingTestClient: (() => any) | undefined;
  // eslint-disable-next-line no-var
  var __provenanceLoggingTestStorage: any;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__provenanceLoggingTestClient = factory;
}

function setMockStorage(storage: any) {
  globalThis.__provenanceLoggingTestStorage = storage;
}

mock.module("../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__provenanceLoggingTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__provenanceLoggingTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__provenanceLoggingTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__provenanceLoggingTestClient ?? (() => null))(),
}));

mock.module("../../storage", () => ({
  getStorageProvider: () => globalThis.__provenanceLoggingTestStorage ?? null,
  isStorageProviderAvailable: () =>
    globalThis.__provenanceLoggingTestStorage != null,
  getConversationBasePath: () => "",
  getUploadPath: () => "",
  getFileUploadPath: () => "",
  getMimeTypeFromFilename: () => "application/octet-stream",
  default: {
    getStorageProvider: () => globalThis.__provenanceLoggingTestStorage ?? null,
  },
}));

// Route import MUST come AFTER the module mocks so the route picks up
// the mocked logger, db client, and storage provider.
import { researchBrainRoute } from "../../routes/research-brain";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCE_ID = "00000000-0000-0000-0000-00000000aaaa";
const FACT_ID = "00000000-0000-0000-0000-0000000000f1";

const STORAGE_THREW = new Error("synthetic storage failure for log test");

let calls: Call[];
let client: any;

beforeEach(() => {
  resetLogCalls();
  calls = [];
  client = scriptedMock([], calls);
  setMockServiceClient(() => client);
  setMockStorage(null);
});

// ---------------------------------------------------------------------------
// 1. /evidence → research_brain_evidence_failed
// ---------------------------------------------------------------------------

describe("GET /api/research-brain/sources/:sourceId/evidence — logging", () => {
  it("logs research_brain_evidence_failed with sourceId and the underlying error when the chunks query throws", async () => {
    // Script:
    //   - getSource (.single)         → source row
    //   - loadTables  (.then on chain) → [] (we don't need tables for this test)
    //   - loadFigures (.then on chain) → [] (we don't need figures for this test)
    //   - loadChunks  (.then on chain) → THROW ← this is what surfaces in the catch
    //
    // The route runs the three listers in parallel via Promise.all, so
    // the order in which the script is consumed depends on microtask
    // order. We seed two safe "many" responses for tables/figures and
    // one "throw" for chunks.
    client = scriptedMock(
      [
        { kind: "single", data: { id: SOURCE_ID, title: "Sample source" }, error: null },
        { kind: "many", data: [], error: null }, // loadTables
        { kind: "many", data: [], error: null }, // loadFigures
        { kind: "throw", error: STORAGE_THREW }, // loadChunks → catch
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(
        `http://test/api/research-brain/sources/${SOURCE_ID}/evidence`,
      ),
    );

    // The handler should surface a 500 — the documented failure mode.
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Failed to load source evidence");

    // The structured log event MUST fire exactly once with the right
    // event name and the right payload.
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].message).toBe("research_brain_evidence_failed");

    // The payload carries the sourceId and the original error.
    const payload = errorCalls[0].payload ?? {};
    expect(payload.sourceId).toBe(SOURCE_ID);
    expect(payload.err).toBe(STORAGE_THREW);
  });
});

// ---------------------------------------------------------------------------
// 2. /pdf → research_brain_pdf_failed
// ---------------------------------------------------------------------------

describe("GET /api/research-brain/sources/:sourceId/pdf — logging", () => {
  it("logs research_brain_pdf_failed with sourceId and the underlying error when storage.download throws", async () => {
    // The /pdf handler calls getSource FIRST, then storage.download.
    // getSource must succeed (returns a source with file_path) so the
    // handler reaches the download() call. The download itself throws
    // → that throw propagates up to the route's catch block.
    client = scriptedMock(
      [
        {
          kind: "single",
          data: {
            id: SOURCE_ID,
            title: "Sample source",
            file_path: "sources/sample.pdf",
          },
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    setMockStorage({
      download: async () => {
        throw STORAGE_THREW;
      },
    });

    const res = await researchBrainRoute.handle(
      new Request(
        `http://test/api/research-brain/sources/${SOURCE_ID}/pdf`,
      ),
    );

    // /pdf maps to 502 on any thrown error from the catch block.
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Failed to proxy source PDF");

    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].message).toBe("research_brain_pdf_failed");
    const payload = errorCalls[0].payload ?? {};
    expect(payload.sourceId).toBe(SOURCE_ID);
    expect(payload.err).toBe(STORAGE_THREW);
  });
});

// ---------------------------------------------------------------------------
// 3. /provenance → research_brain_provenance_failed
// ---------------------------------------------------------------------------

describe("GET /api/research-brain/facts/:factId/provenance — logging", () => {
  it("logs research_brain_provenance_failed with factId and the underlying error when getBioprospectingFact throws", async () => {
    // The /provenance handler delegates to getBioprospectingFact,
    // which under the hood issues a `.single()` call on the Supabase
    // chain. We script that single() call to reject so the route's
    // catch block fires with a deterministic error.
    client = scriptedMock(
      [{ kind: "throw", error: STORAGE_THREW }],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(
        `http://test/api/research-brain/facts/${FACT_ID}/provenance`,
      ),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Failed to load fact provenance");

    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].message).toBe("research_brain_provenance_failed");
    const payload = errorCalls[0].payload ?? {};
    expect(payload.factId).toBe(FACT_ID);
    expect(payload.err).toBe(STORAGE_THREW);
  });
});
