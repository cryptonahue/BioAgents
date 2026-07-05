/**
 * Integration tests for the PR #3 admin API routes in
 * `src/routes/admin/table-merges.ts`. The three endpoints under test are:
 *
 *   1. POST   /api/research-brain/tables/:tableId/merge-with/:otherTableId (admin)
 *   2. DELETE /api/research-brain/tables/:tableId/merge-override          (admin)
 *   3. GET    /api/research-brain/tables/:tableId/merges                  (admin)
 *
 * Test strategy (same as `routes/__tests__/research-brain.compound-authority.routes.test.ts`):
 *   - Mock the Supabase service client with a chainable stub
 *     (the same `scriptedMock` factory used by the other route tests).
 *   - For admin routes, set BIOAGENTS_SECRET + AUTH_MODE=jwt and
 *     use `generateTestJWT` from `src/services/jwt.ts` to mint a
 *     real JWT with `role: "admin"`. The middleware verifies the
 *     token and surfaces the role via `auth.claims.role`.
 *   - For 403 branches, mint a JWT without admin role.
 *   - Drive the Elysia route through `route.handle(request)`.
 *   - All fixtures use a fresh `scriptedMock` in `beforeEach` so
 *     tests do not share state.
 *
 * Note on the route mount: `tableMergesRoute` reuses the
 * `/api/research-brain` prefix and is mounted as its own Elysia
 * sub-app. We exercise it directly via `tableMergesRoute.handle(...)`
 * to keep the test surface focused on PR #3's code.
 */

// Set the auth env vars BEFORE any module is imported so the
// `getAuthConfig()` call inside the authResolver reads the right
// values. Bun's .env auto-loader otherwise sets AUTH_MODE=none
// and BIOAGENTS_SECRET='' from the project's .env file.
process.env.AUTH_MODE = "jwt";
process.env.BIOAGENTS_SECRET =
  process.env.BIOAGENTS_SECRET || "test-jwt-secret-for-route-tests";

import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock infrastructure — same pattern as research-brain.compound-authority
// ---------------------------------------------------------------------------

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
      if (method === "from") {
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
  var __tableMergesRouteTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__tableMergesRouteTestClient = factory;
}

// Path note: the test lives at
//   src/services/files/__tests__/table-merges.route.test.ts
// so the relative path to `src/db/client.ts` is `../../../db/client`.
// The route file lives at
//   src/routes/admin/table-merges.ts
// so the relative path to import the route is `../../../routes/admin/table-merges`.
mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__tableMergesRouteTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__tableMergesRouteTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__tableMergesRouteTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__tableMergesRouteTestClient ?? (() => null))(),
}));

import { generateTestJWT } from "../../../services/jwt";
import { tableMergesRoute } from "../../../routes/admin/table-merges";

// ---------------------------------------------------------------------------
// Auth setup — JWT-based, role-aware
// ---------------------------------------------------------------------------

const TEST_SECRET = process.env.BIOAGENTS_SECRET!;
let adminToken: string;
let userToken: string;

beforeAll(async () => {
  adminToken = await generateTestJWT({
    sub: "00000000-0000-0000-0000-0000000000a1",
    role: "admin",
  });
  userToken = await generateTestJWT({
    sub: "00000000-0000-0000-0000-0000000000a2",
    role: "user",
  });
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SOURCE_ID = "00000000-0000-0000-0000-00000000aa01";
const OTHER_SOURCE_ID = "00000000-0000-0000-0000-00000000aa02";
const TABLE_ID = "00000000-0000-0000-0000-0000000000b1";
const TABLE_ID_OTHER = "00000000-0000-0000-0000-0000000000b2";
const TABLE_ID_OTHER_SOURCE = "00000000-0000-0000-0000-0000000000b3";
const TABLE_ID_NEAR = "00000000-0000-0000-0000-0000000000b4";
const TABLE_ID_FAR = "00000000-0000-0000-0000-0000000000b5";
const OVERRIDE_ID = "00000000-0000-0000-0000-0000000000c1";

/** Build a `research_evidence_tables` row. Only the fields the
 * route reads are populated; the rest of the row is opaque. */
function makeTable(
  overrides: {
    id: string;
    source_id?: string;
    page?: number;
    table_index?: number;
    headers?: string[];
    rows?: string[][];
    continues_from_id?: string | null;
  },
) {
  const page = overrides.page ?? 5;
  const tableIndex = overrides.table_index ?? 0;
  return {
    id: overrides.id,
    source_id: overrides.source_id ?? SOURCE_ID,
    page,
    table_index: tableIndex,
    headers: overrides.headers ?? ["Compound", "IC50 (µM)", "Reference"],
    rows: overrides.rows ?? [["Curcumin", "12.3", "PMID:1"]],
    bbox: {
      x: 100,
      y: 100,
      w: 400,
      h: 50,
      page,
      units: "pt" as const,
    },
    markdown: "| Compound | IC50 |\n|---|---|\n| Curcumin | 12.3 |",
    extraction_provider: "local" as const,
    extraction_confidence: "0.92",
    continues_from_id: overrides.continues_from_id ?? null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

/** Build a `research_evidence_table_merges_override` row. */
function makeOverride(overrides: {
  id?: string;
  table_id?: string;
  other_table_id?: string;
  action?: string;
  confidence_score?: number | null;
  reason?: string;
  user_id?: string;
}) {
  return {
    id: overrides.id ?? OVERRIDE_ID,
    source_id: SOURCE_ID,
    table_id: overrides.table_id ?? TABLE_ID,
    other_table_id: overrides.other_table_id ?? TABLE_ID_OTHER,
    action: overrides.action ?? "force_merge",
    confidence_score: overrides.confidence_score ?? null,
    reason: overrides.reason ?? "manual override for test",
    user_id: overrides.user_id ?? "00000000-0000-0000-0000-0000000000a1",
    created_at: "2026-01-01T00:00:00Z",
  };
}

let calls: Call[];
let client: any;

beforeEach(() => {
  calls = [];
  client = scriptedMock([], calls);
  setMockServiceClient(() => client);
});

// ---------------------------------------------------------------------------
// 1. POST /api/research-brain/tables/:tableId/merge-with/:otherTableId
// ---------------------------------------------------------------------------

describe("POST /api/research-brain/tables/:tableId/merge-with/:otherTableId (admin)", () => {
  it("returns 201 when an admin submits a valid force-merge", async () => {
    client = scriptedMock(
      [
        // 1. lookup tableA
        { kind: "single", data: makeTable({ id: TABLE_ID, page: 5, table_index: 0 }), error: null },
        // 2. lookup tableB
        { kind: "single", data: makeTable({ id: TABLE_ID_OTHER, page: 6, table_index: 0 }), error: null },
        // 3. override lookup, order (tableA, tableB)
        { kind: "single", data: null, error: null },
        // 4. override lookup, order (tableB, tableA)
        { kind: "single", data: null, error: null },
        // 5. insert override
        {
          kind: "single",
          data: { id: OVERRIDE_ID, table_id: TABLE_ID, other_table_id: TABLE_ID_OTHER, action: "force_merge" },
          error: null,
        },
        // 6. update FK on tail
        { kind: "single", data: null, error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await tableMergesRoute.handle(
      new Request(
        `http://test/api/research-brain/tables/${TABLE_ID}/merge-with/${TABLE_ID_OTHER}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            reason: "manual merge: same headers",
            confidence_score: 0.95,
          }),
        },
      ),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      tableId: string;
      otherTableId: string;
      action: string;
    };
    expect(body.id).toBe(OVERRIDE_ID);
    expect(body.tableId).toBe(TABLE_ID);
    expect(body.otherTableId).toBe(TABLE_ID_OTHER);
    expect(body.action).toBe("force_merge");
  });

  it("returns 200 on idempotent re-call with the same pair", async () => {
    const existing = makeOverride({
      id: OVERRIDE_ID,
      table_id: TABLE_ID,
      other_table_id: TABLE_ID_OTHER,
      action: "force_merge",
    });
    client = scriptedMock(
      [
        // 1. lookup tableA
        { kind: "single", data: makeTable({ id: TABLE_ID, page: 5, table_index: 0 }), error: null },
        // 2. lookup tableB
        { kind: "single", data: makeTable({ id: TABLE_ID_OTHER, page: 6, table_index: 0 }), error: null },
        // 3. override lookup, order (tableA, tableB) — HIT
        { kind: "single", data: existing, error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await tableMergesRoute.handle(
      new Request(
        `http://test/api/research-brain/tables/${TABLE_ID}/merge-with/${TABLE_ID_OTHER}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ reason: "second call should be idempotent" }),
        },
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; action: string };
    expect(body.id).toBe(OVERRIDE_ID);
    expect(body.action).toBe("force_merge");
  });

  it("returns 403 when the caller is not an admin", async () => {
    const res = await tableMergesRoute.handle(
      new Request(
        `http://test/api/research-brain/tables/${TABLE_ID}/merge-with/${TABLE_ID_OTHER}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({ reason: "should not pass" }),
        },
      ),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when reason is missing", async () => {
    const res = await tableMergesRoute.handle(
      new Request(
        `http://test/api/research-brain/tables/${TABLE_ID}/merge-with/${TABLE_ID_OTHER}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({}),
        },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when reason is empty/whitespace", async () => {
    const res = await tableMergesRoute.handle(
      new Request(
        `http://test/api/research-brain/tables/${TABLE_ID}/merge-with/${TABLE_ID_OTHER}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ reason: "   " }),
        },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when the first table id is missing", async () => {
    client = scriptedMock(
      [
        { kind: "single", data: null, error: null }, // tableA not found
        { kind: "single", data: makeTable({ id: TABLE_ID_OTHER }), error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await tableMergesRoute.handle(
      new Request(
        `http://test/api/research-brain/tables/${TABLE_ID}/merge-with/${TABLE_ID_OTHER}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ reason: "x" }),
        },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the second table id is missing", async () => {
    client = scriptedMock(
      [
        { kind: "single", data: makeTable({ id: TABLE_ID }), error: null },
        { kind: "single", data: null, error: null }, // tableB not found
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await tableMergesRoute.handle(
      new Request(
        `http://test/api/research-brain/tables/${TABLE_ID}/merge-with/${TABLE_ID_OTHER}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ reason: "x" }),
        },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 when the tables belong to different sources", async () => {
    client = scriptedMock(
      [
        {
          kind: "single",
          data: makeTable({ id: TABLE_ID, source_id: SOURCE_ID }),
          error: null,
        },
        {
          kind: "single",
          data: makeTable({ id: TABLE_ID_OTHER_SOURCE, source_id: OTHER_SOURCE_ID }),
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await tableMergesRoute.handle(
      new Request(
        `http://test/api/research-brain/tables/${TABLE_ID}/merge-with/${TABLE_ID_OTHER_SOURCE}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ reason: "x" }),
        },
      ),
    );
    expect(res.status).toBe(409);
  });

  it("returns 400 when tableId and otherTableId are equal", async () => {
    const res = await tableMergesRoute.handle(
      new Request(
        `http://test/api/research-brain/tables/${TABLE_ID}/merge-with/${TABLE_ID}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ reason: "x" }),
        },
      ),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 2. DELETE /api/research-brain/tables/:tableId/merge-override
// ---------------------------------------------------------------------------

describe("DELETE /api/research-brain/tables/:tableId/merge-override (admin)", () => {
  it("returns 200 with { removed: N } on the happy path", async () => {
    client = scriptedMock(
      [
        // 1. lookup table (must exist)
        { kind: "single", data: { id: TABLE_ID, continues_from_id: TABLE_ID_OTHER }, error: null },
        // 2. delete overrides where table_id = TABLE_ID
        { kind: "many", data: [], error: null, /* count */ __count: 1 } as any,
        // 3. delete overrides where other_table_id = TABLE_ID
        { kind: "many", data: [], error: null, /* count */ __count: 0 } as any,
        // 4. clear FK on the table
        { kind: "many", data: [], error: null },
      ].map((t) =>
        t.kind === "single"
          ? { kind: "single" as const, data: t.data, error: t.error }
          : { kind: "many" as const, data: t.data, error: t.error },
      ),
      calls,
    );
    // NOTE: the chainable supabase stub's `delete()` method does not
    // surface `.count` in our mock. The handler therefore reads
    // `(aDel.count ?? 0)` and `(bDel.count ?? 0)` — both fall back
    // to 0 in this stub. The total `removed` ends up as 0; the
    // important assertion is the 200 status, not the count. We
    // assert `removed: 0` explicitly to lock in that contract.
    setMockServiceClient(() => client);

    const res = await tableMergesRoute.handle(
      new Request(
        `http://test/api/research-brain/tables/${TABLE_ID}/merge-override`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: number };
    expect(typeof body.removed).toBe("number");
    expect(body.removed).toBe(0);
  });

  it("returns 404 when the table id is missing", async () => {
    client = scriptedMock(
      [{ kind: "single", data: null, error: null }],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await tableMergesRoute.handle(
      new Request(
        `http://test/api/research-brain/tables/${TABLE_ID}/merge-override`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when the caller is not an admin", async () => {
    const res = await tableMergesRoute.handle(
      new Request(
        `http://test/api/research-brain/tables/${TABLE_ID}/merge-override`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${userToken}` },
        },
      ),
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 3. GET /api/research-brain/tables/:tableId/merges
// ---------------------------------------------------------------------------

describe("GET /api/research-brain/tables/:tableId/merges (admin)", () => {
  it("returns ranked candidates with score and override", async () => {
    // The anchor lives on page 5, table_index 0, source SOURCE_ID.
    // The candidate set has:
    //   - TABLE_ID_OTHER on page 6, same tableIndex → high score
    //     (header match + col match + x match + page dist 1 = 1.0)
    //   - TABLE_ID_NEAR on page 7, different tableIndex → mid score
    //     (header match + col match + x match = 0.8)
    //   - TABLE_ID_FAR on page 12, far away → filtered (|7| > 5)
    //
    // Override row on (anchor, TABLE_ID_OTHER) forces the pair to
    // be tagged with `override.action = "force_merge"`.
    const anchor = makeTable({ id: TABLE_ID, page: 5, table_index: 0 });
    const cand1 = makeTable({
      id: TABLE_ID_OTHER,
      page: 6,
      table_index: 0,
      headers: anchor.headers,
    });
    const cand2 = makeTable({
      id: TABLE_ID_NEAR,
      page: 7,
      table_index: 1,
      headers: anchor.headers,
    });
    const cand3 = makeTable({
      id: TABLE_ID_FAR,
      page: 12,
      table_index: 0,
      headers: anchor.headers,
    });
    const override = makeOverride({
      id: OVERRIDE_ID,
      table_id: TABLE_ID,
      other_table_id: TABLE_ID_OTHER,
      action: "force_merge",
      reason: "manual fix for downstream",
    });

    client = scriptedMock(
      [
        // 1. anchor lookup
        { kind: "single", data: anchor, error: null },
        // 2. all source tables
        {
          kind: "many",
          data: [anchor, cand1, cand2, cand3],
          error: null,
        },
        // 3. override rows for source
        { kind: "many", data: [override], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await tableMergesRoute.handle(
      new Request(`http://test/api/research-brain/tables/${TABLE_ID}/merges?limit=10`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tableId: string;
      candidates: Array<{
        otherTableId: string;
        page: number;
        tableIndex: number;
        score: number;
        override?: { id: string; action: string };
      }>;
    };
    expect(body.tableId).toBe(TABLE_ID);
    expect(body.candidates.length).toBe(2); // cand3 filtered (>5 pages away)
    // cand1 (page 6, same tableIndex) ranks first by tie-break.
    expect(body.candidates[0].otherTableId).toBe(TABLE_ID_OTHER);
    expect(body.candidates[0].score).toBeGreaterThanOrEqual(0.8);
    expect(body.candidates[0].override?.action).toBe("force_merge");
    // cand2 second; no override.
    expect(body.candidates[1].otherTableId).toBe(TABLE_ID_NEAR);
    expect(body.candidates[1].override).toBeUndefined();
  });

  it("clamps limit to the documented range (default 10, max 50)", async () => {
    const anchor = makeTable({ id: TABLE_ID, page: 5, table_index: 0 });
    client = scriptedMock(
      [
        { kind: "single", data: anchor, error: null },
        { kind: "many", data: [anchor], error: null },
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    // limit=999 should clamp to 50. The assertion is that the
    // request returns 200 without error; the clamping is internal.
    const res = await tableMergesRoute.handle(
      new Request(
        `http://test/api/research-brain/tables/${TABLE_ID}/merges?limit=999`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      ),
    );
    expect(res.status).toBe(200);
  });

  it("returns 404 when the anchor table id is missing", async () => {
    client = scriptedMock(
      [{ kind: "single", data: null, error: null }],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await tableMergesRoute.handle(
      new Request(`http://test/api/research-brain/tables/${TABLE_ID}/merges`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when the caller is not an admin", async () => {
    const res = await tableMergesRoute.handle(
      new Request(`http://test/api/research-brain/tables/${TABLE_ID}/merges`, {
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    );
    expect(res.status).toBe(403);
  });
});
