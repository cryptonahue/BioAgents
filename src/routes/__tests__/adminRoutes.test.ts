/**
 * Integration tests for the four new admin-only routes added by
 * the `bioprospecting-review-ui` change:
 *
 *   1. GET  /api/research-brain/contradictions
 *   2. GET  /api/research-brain/contradictions/stats
 *   3. GET  /api/research-brain/dedup/events
 *   4. POST /api/research-brain/dedup/:factId/unmerge
 *
 * Test strategy mirrors `research-brain.compound-authority.routes.test.ts`:
 *   - Mock the Supabase service client with a chainable stub.
 *   - For admin routes, set BIOAGENTS_SECRET + AUTH_MODE=jwt and
 *     use `generateTestJWT` to mint a real JWT with `role: "admin"`.
 *   - For the 403 branch, mint a JWT with `role: "user"`.
 *   - Drive the Elysia route through `route.handle(request)`.
 */

process.env.AUTH_MODE = "jwt";
process.env.BIOAGENTS_SECRET =
  process.env.BIOAGENTS_SECRET || "test-jwt-secret-for-admin-route-tests";

import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";

type Call = { method: string; args: unknown[]; table?: string };
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
  "rpc",
];

const TERMINAL_METHODS = ["maybeSingle", "single"];

function scriptedMock(script: Terminal[], calls: Call[]) {
  let cursor = 0;
  let currentTable: string | undefined;
  const target: any = {};
  const next = (): Terminal => {
    if (cursor >= script.length) {
      return { kind: "many", data: [], error: null };
    }
    return script[cursor++];
  };
  for (const method of BUILDER_METHODS) {
    target[method] = (...args: unknown[]) => {
      if (method === "from" || method === "rpc") {
        currentTable = args[0] as string;
      }
      calls.push({ method, args, table: currentTable });
      return target;
    };
  }
  for (const method of TERMINAL_METHODS) {
    target[method] = (...args: unknown[]) => {
      calls.push({ method, args, table: currentTable });
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
        calls.push({ method: "then", args: [], table: currentTable });
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
  var __adminRoutesTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__adminRoutesTestClient = factory;
}

mock.module("../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__adminRoutesTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__adminRoutesTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__adminRoutesTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__adminRoutesTestClient ?? (() => null))(),
}));

import { generateTestJWT } from "../../services/jwt";
import { researchBrainRoute } from "../../routes/research-brain";

// ---------------------------------------------------------------------------
// Auth setup
// ---------------------------------------------------------------------------

const TEST_SECRET = process.env.BIOAGENTS_SECRET!;
let adminToken: string;
let userToken: string;

beforeAll(async () => {
  adminToken = await generateTestJWT({
    sub: "00000000-0000-0000-0000-0000000000u1",
    role: "admin",
  });
  userToken = await generateTestJWT({
    sub: "00000000-0000-0000-0000-0000000000u2",
    role: "user",
  });
});

const FACT_ID = "00000000-0000-0000-0000-0000000000f1";
const CANONICAL_ID = "00000000-0000-0000-0000-0000000000c1";

let calls: Call[];
let client: any;

beforeEach(() => {
  calls = [];
  client = scriptedMock([], calls);
  setMockServiceClient(() => client);
});

// ---------------------------------------------------------------------------
// 1. GET /api/research-brain/contradictions
// ---------------------------------------------------------------------------

describe("GET /api/research-brain/contradictions (admin)", () => {
  it("returns 403 when the caller is not an admin", async () => {
    const res = await researchBrainRoute.handle(
      new Request("http://test/api/research-brain/contradictions", {
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns rows + total + limit + offset on the happy path", async () => {
    client = scriptedMock(
      [
        // count
        { kind: "many", data: [], error: null },
        // page
        {
          kind: "many",
          data: [
            {
              id: "00000000-0000-0000-0000-0000000000a1",
              fact_a_id: "f-1",
              fact_b_id: "f-2",
              conflict_type: "compound_mismatch",
              severity: "medium",
              explanation: null,
              status: "open",
              resolved_by: null,
              resolved_at: null,
              resolution_note: null,
              detected_at: "2026-06-15T00:00:00Z",
              metadata: {},
            },
          ],
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request("http://test/api/research-brain/contradictions?limit=50&offset=0", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.contradictions).toHaveLength(1);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("returns 400 when limit is not an integer", async () => {
    const res = await researchBrainRoute.handle(
      new Request("http://test/api/research-brain/contradictions?limit=abc", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 2. GET /api/research-brain/contradictions/stats
// ---------------------------------------------------------------------------

describe("GET /api/research-brain/contradictions/stats (admin)", () => {
  it("returns 403 when the caller is not an admin", async () => {
    const res = await researchBrainRoute.handle(
      new Request("http://test/api/research-brain/contradictions/stats", {
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns the two-window shape on the happy path", async () => {
    client = scriptedMock(
      [
        // RPC: get_contradiction_stats returns 2 rows
        {
          kind: "many",
          data: [
            { window_label: "1d", found: 10, resolved: 3, dismissed: 1 },
            { window_label: "7d", found: 50, resolved: 15, dismissed: 4 },
          ],
          error: null,
        },
        // edges
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request("http://test/api/research-brain/contradictions/stats", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.today).toBeDefined();
    expect(body.last7d).toBeDefined();
    expect(Object.keys(body.today).sort()).toEqual(
      ["dismissed", "found", "merges", "pending", "resolved", "unmerges"].sort(),
    );
    expect(body.today.pending).toBe(6);
    expect(body.last7d.pending).toBe(31);
  });
});

// ---------------------------------------------------------------------------
// 3. GET /api/research-brain/dedup/events
// ---------------------------------------------------------------------------

describe("GET /api/research-brain/dedup/events (admin)", () => {
  it("returns 403 when the caller is not an admin", async () => {
    const res = await researchBrainRoute.handle(
      new Request("http://test/api/research-brain/dedup/events", {
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns events with the default 7d window", async () => {
    client = scriptedMock(
      [
        {
          kind: "many",
          data: [
            {
              canonical_fact_id: CANONICAL_ID,
              merged_fact_id: FACT_ID,
              match_rule: "identity_key",
              merged_at: new Date().toISOString(),
              is_active: true,
              unmerged_at: null,
              unmerged_by: null,
              dedup_audit: null,
            },
          ],
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request("http://test/api/research-brain/dedup/events", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.events).toHaveLength(1);
    expect(body.events[0].isActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. POST /api/research-brain/dedup/:factId/unmerge
// ---------------------------------------------------------------------------

describe("POST /api/research-brain/dedup/:factId/unmerge (admin)", () => {
  it("returns 409 on a double-unmerge (no active edge)", async () => {
    client = scriptedMock(
      [
        // fact exists
        { kind: "single", data: { id: FACT_ID }, error: null },
        // no active edges
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(
        `http://test/api/research-brain/dedup/${FACT_ID}/unmerge`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ reasonCode: "false_positive" }),
        },
      ),
    );
    expect(res.status).toBe(409);
  });

  it("returns 404 when the fact does not exist (Nonexistent fact returns 404)", async () => {
    // Spec scenario: "Nonexistent fact returns 404". The
    // `unmergeFact` service throws `FactNotFoundError` when its
    // existence check on `research_bioprospecting_facts` returns no
    // row; the route maps that error to 404.
    client = scriptedMock(
      [
        // fact existence check returns null (no row)
        { kind: "single", data: null, error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(
        `http://test/api/research-brain/dedup/${FACT_ID}/unmerge`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ reasonCode: "false_positive" }),
        },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 on an invalid reasonCode", async () => {
    const res = await researchBrainRoute.handle(
      new Request(
        `http://test/api/research-brain/dedup/${FACT_ID}/unmerge`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ reasonCode: "not_a_real_category" }),
        },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 when the caller is not an admin", async () => {
    const res = await researchBrainRoute.handle(
      new Request(
        `http://test/api/research-brain/dedup/${FACT_ID}/unmerge`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({ reasonCode: "false_positive" }),
        },
      ),
    );
    expect(res.status).toBe(403);
  });
});
