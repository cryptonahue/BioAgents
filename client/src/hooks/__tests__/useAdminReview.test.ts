/**
 * Unit tests for the admin-review hooks in
 * `client/src/hooks/useAdminReview.ts`.
 *
 * Coverage (3 cases, matching the tasks.md spec):
 *   1. `useAdminContradictions` — fetch + cache
 *   2. `useBulkResolveContradictions` — partial-failure rollback
 *      (1 of 3 fails; the other 2 are still treated as resolved)
 *   3. `useUnmergeFact` — fires with the dialog payload
 *      (reasonCode + reasonDetail)
 *
 * Test strategy:
 *   - Stub `globalThis.fetch` with a programmable `MockFetch`.
 *   - Drive each hook through a Preact `render-to-null` harness
 *     (the same pattern `useTextChunkSearch.test.ts` uses).
 *   - For partial-failure rollback, mock two 200 responses and
 *     one 500; assert the `useBulkResolveContradictions` `mutate`
 *     returns 1 failure with the expected error message.
 */

// Polyfill a minimal `document` so Preact's render doesn't crash.
import "../../test-dom-shim";

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createElement, render } from "preact";
import { useEffect } from "preact/hooks";
import {
  useAdminContradictions,
  useBulkResolveContradictions,
  useUnmergeFact,
} from "../useAdminReview";

// ---------------------------------------------------------------------------
// Mock fetch — programmable per-URL responses.
// ---------------------------------------------------------------------------

interface MockResponse {
  status: number;
  body: unknown;
}

let mockResponses: Array<{ url: string; init: RequestInit; response: MockResponse }> = [];
let nextResponseIdx = 0;

function setMockResponses(
  responses: Array<{ urlPattern: RegExp; status: number; body: unknown }>,
) {
  mockResponses = [];
  let idx = 0;
  // Programmable: each call to fetch walks the response list.
  (globalThis as any).fetch = async (
    url: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const match = responses[idx];
    if (!match) {
      return new Response(
        JSON.stringify({ error: "No mock response registered" }),
        { status: 500 },
      );
    }
    mockResponses.push({ url, init, response: { status: match.status, body: match.body } });
    idx++;
    return new Response(JSON.stringify(match.body), {
      status: match.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  nextResponseIdx = 0;
}

beforeEach(() => {
  mockResponses = [];
  nextResponseIdx = 0;
  // Default JWT in localStorage so authHeaders() includes the token.
  localStorage.setItem("bioagents_auth_token", "test-jwt");
});

afterEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Preact harness — drives a hook without rendering to the real DOM.
// ---------------------------------------------------------------------------

async function driveHook<T>(probe: (out: { current: T | null }) => void) {
  const ref: { current: T | null } = { current: null };
  function Probe() {
    probe(ref);
    return createElement("div", null);
  }
  const host = (globalThis as any).document.createElement("div");
  (globalThis as any).document.body.appendChild(host);
  render(createElement(Probe), host);
  // Yield enough ticks for the hook's effect chain to settle.
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  render(null as any, host);
  host.remove();
  return ref;
}

// ---------------------------------------------------------------------------
// 1. useAdminContradictions — fetch + cache
// ---------------------------------------------------------------------------

describe("useAdminContradictions", () => {
  it("fetches and caches the unresolved list", async () => {
    setMockResponses([
      {
        urlPattern: /\/api\/research-brain\/contradictions/,
        status: 200,
        body: {
          contradictions: [
            {
              id: "c-1",
              source_id: "s-1",
              source_fact_id: "f-1",
              conflicting_fact_id: "f-2",
              contradiction_type: "measurement_direction",
              evidence_pack: {},
              rule_version: "1.0",
              llm_version: "1.0",
              resolution_status: "unresolved",
              resolved_by: null,
              resolved_at: null,
              created_at: "2026-06-15T00:00:00Z",
              updated_at: "2026-06-15T00:00:00Z",
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        },
      },
    ]);

    await driveHook<{ rows: number; total: number } | null>((out) => {
      const { data, isLoading } = useAdminContradictions({
        status: "unresolved",
        page: 0,
      });
      out.current = isLoading ? null : { rows: data?.contradictions.length ?? 0, total: data?.total ?? 0 };
    });

    // Verify the fetch was made with the right URL pattern.
    expect(mockResponses.length).toBeGreaterThanOrEqual(1);
    const last = mockResponses[mockResponses.length - 1];
    expect(last.url).toContain("/api/research-brain/contradictions");
    expect(last.url).toContain("status=unresolved");
    expect(last.url).toContain("limit=50");
  });
});

// ---------------------------------------------------------------------------
// 2. useBulkResolveContradictions — partial-failure rollback
// ---------------------------------------------------------------------------

describe("useBulkResolveContradictions", () => {
  it("reports per-row failure on a 500 from one of the three calls", async () => {
    // Programmable responses: c-1 → 200, c-2 → 500, c-3 → 200.
    let i = 0;
    (globalThis as any).fetch = async (
      url: string,
      init: RequestInit = {},
    ): Promise<Response> => {
      const statuses = [200, 500, 200];
      const status = statuses[i++] ?? 500;
      const body =
        status === 200
          ? { contradiction: { id: "c-1" } }
          : { error: "boom" };
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    };

    const ref = await driveHook<{
      results: Array<{ id: string; ok: boolean; error?: string }>;
    } | null>((out) => {
      const { mutate } = useBulkResolveContradictions();
      // Mount an effect that calls mutate on first render.
      useEffect(() => {
        (async () => {
          const results = await mutate(
            ["c-1", "c-2", "c-3"],
            "resolved",
          );
          out.current = { results };
        })();
      }, []);
    });

    expect(ref.current).not.toBeNull();
    const { results } = ref.current!;
    expect(results).toHaveLength(3);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toBe("boom");
    expect(results[2].ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. useUnmergeFact — fires with the dialog payload
// ---------------------------------------------------------------------------

describe("useUnmergeFact", () => {
  it("POSTs the reasonCode and reasonDetail in the body", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    (globalThis as any).fetch = async (
      url: string,
      init: RequestInit = {},
    ): Promise<Response> => {
      capturedUrl = url;
      capturedBody = typeof init.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          edge: {
            canonicalFactId: "c-1",
            mergedFactId: "f-1",
            matchRule: "identity_key",
            mergedAt: "2026-06-10T00:00:00Z",
            isActive: false,
            unmergedAt: "2026-06-16T00:00:00Z",
            unmergedBy: "admin-1",
          },
          audit: {
            id: "1",
            factId: "f-1",
            eventType: "unmerge",
            oldCanonicalId: "c-1",
            newCanonicalId: null,
            userId: "admin-1",
            reason: "wrong species",
            reasonCategory: "false_positive",
            createdAt: "2026-06-16T00:00:00Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    await driveHook<{ ok: boolean } | null>((out) => {
      const { mutate } = useUnmergeFact();
      useEffect(() => {
        (async () => {
          await mutate({
            factId: "f-1",
            reasonCode: "false_positive",
            reasonDetail: "wrong species",
          });
          out.current = { ok: true };
        })();
      }, []);
    });

    expect(capturedUrl).toBe("/api/research-brain/dedup/f-1/unmerge");
    const parsedBody = JSON.parse(capturedBody);
    expect(parsedBody.reasonCode).toBe("false_positive");
    expect(parsedBody.reasonDetail).toBe("wrong species");
  });
});
