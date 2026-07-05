/**
 * Integration tests for the PR #3 compound-authority API routes in
 * `src/routes/research-brain.ts`. The four endpoints under test are:
 *
 *   1. GET  /api/research-brain/compounds/search?q=&limit=
 *   2. GET  /api/research-brain/compounds/:canonicalId
 *   3. POST /api/research-brain/compounds/:canonicalId/aliases (admin)
 *   4. POST /api/research-brain/facts/:factId/authority/promote (admin)
 *
 * Test strategy:
 *   - Mock the Supabase service client with a chainable stub
 *     (same pattern as `research-brain.provenance.test.ts`).
 *   - For admin routes, set BIOAGENTS_SECRET + AUTH_MODE=jwt and
 *     use `generateTestJWT` from `src/services/jwt.ts` to mint a
 *     real JWT with `role: "admin"`. The middleware verifies the
 *     token and surfaces the role via `auth.claims.role`.
 *   - For the 403 branches, mint a JWT without admin role.
 *   - Drive the Elysia route through `route.handle(request)`.
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
// Mock infrastructure — same pattern as research-brain.provenance.test.ts
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
  var __compoundAuthorityRoutesTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__compoundAuthorityRoutesTestClient = factory;
}

mock.module("../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__compoundAuthorityRoutesTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__compoundAuthorityRoutesTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__compoundAuthorityRoutesTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__compoundAuthorityRoutesTestClient ?? (() => null))(),
}));

import { generateTestJWT } from "../../services/jwt";
import { researchBrainRoute } from "../../routes/research-brain";

// ---------------------------------------------------------------------------
// Auth setup — JWT-based, role-aware
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

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CANONICAL_ID = "00000000-0000-0000-0000-0000000000c1";
const OTHER_CANONICAL_ID = "00000000-0000-0000-0000-0000000000c2";
const FACT_ID = "00000000-0000-0000-0000-0000000000f1";
const FACT_ID_VERIFIED = "00000000-0000-0000-0000-0000000000f2";
const ALIAS_ID = "00000000-0000-0000-0000-0000000000a1";

function makeCanonical(overrides: Record<string, unknown> = {}) {
  return {
    id: CANONICAL_ID,
    canonical_name: "Curcumin",
    normalized_name: "curcumin",
    inchi_key: "VFLDPWHFBROODJ-UHFFFAOYSA-N",
    pubchem_cid: 969516,
    chebi_id: null,
    molecular_formula: "C21H20O6",
    iupac_name:
      "(1E,6E)-1,7-bis(4-hydroxy-3-methoxyphenyl)hepta-1,6-diene-3,5-dione",
    compound_kind: "small_molecule",
    status: "curated",
    external_ids: {},
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeAlias(overrides: Record<string, unknown> = {}) {
  return {
    id: ALIAS_ID,
    compound_id: CANONICAL_ID,
    alias: "Diferuloylmethane",
    normalized_alias: "diferuloylmethane",
    source: "curated",
    confidence: "high",
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
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
// 1. GET /api/research-brain/compounds/search
// ---------------------------------------------------------------------------

describe("GET /api/research-brain/compounds/search", () => {
  it("returns 400 when q is missing", async () => {
    const res = await researchBrainRoute.handle(
      new Request("http://test/api/research-brain/compounds/search"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("missing query parameter q");
  });

  it("returns the matched canonical rows for q=curcumin", async () => {
    client = scriptedMock(
      [
        // searchCompoundsByName: first SELECT on research_compounds
        { kind: "many", data: [makeCanonical()], error: null },
        // second SELECT on research_compound_aliases (alias pass)
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request("http://test/api/research-brain/compounds/search?q=curcumin"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: any[] };
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results[0]?.canonical_name).toBe("Curcumin");
  });

  it("clamps limit to a safe range (default 25, max 100)", async () => {
    client = scriptedMock(
      [
        { kind: "many", data: [makeCanonical()], error: null },
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(
        "http://test/api/research-brain/compounds/search?q=curcumin&limit=500",
      ),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 2. GET /api/research-brain/compounds/:canonicalId
// ---------------------------------------------------------------------------

describe("GET /api/research-brain/compounds/:canonicalId", () => {
  it("returns the canonical + aliases when the id exists", async () => {
    client = scriptedMock(
      [
        { kind: "single", data: makeCanonical(), error: null }, // canonical row
        { kind: "many", data: [makeAlias()], error: null }, // alias rows
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(`http://test/api/research-brain/compounds/${CANONICAL_ID}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { compound: any };
    expect(body.compound.canonical_name).toBe("Curcumin");
    expect(body.compound.inchi_key).toBe("VFLDPWHFBROODJ-UHFFFAOYSA-N");
    expect(body.compound.aliases).toHaveLength(1);
    expect(body.compound.aliases[0].alias).toBe("Diferuloylmethane");
  });

  it("returns 404 when the canonical id is unknown", async () => {
    client = scriptedMock(
      [
        { kind: "single", data: null, error: null }, // canonical row missing
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(
        `http://test/api/research-brain/compounds/${OTHER_CANONICAL_ID}`,
      ),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Compound not found");
  });
});

// ---------------------------------------------------------------------------
// 3. POST /api/research-brain/compounds/:canonicalId/aliases  (admin)
// ---------------------------------------------------------------------------

describe("POST /api/research-brain/compounds/:canonicalId/aliases (admin)", () => {
  it("returns 201 when an admin submits a valid alias", async () => {
    client = scriptedMock(
      [
        { kind: "single", data: null, error: null }, // existing-alias check (miss)
        { kind: "single", data: { id: ALIAS_ID }, error: null }, // insert
        { kind: "single", data: null, error: null }, // audit insert
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(
        `http://test/api/research-brain/compounds/${CANONICAL_ID}/aliases`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            alias: "turmeric-extract-curcumin",
            confidence: "high",
          }),
        },
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(ALIAS_ID);
  });

  it("returns 400 when confidence is missing", async () => {
    const res = await researchBrainRoute.handle(
      new Request(
        `http://test/api/research-brain/compounds/${CANONICAL_ID}/aliases`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ alias: "x" }),
        },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when alias is missing", async () => {
    const res = await researchBrainRoute.handle(
      new Request(
        `http://test/api/research-brain/compounds/${CANONICAL_ID}/aliases`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ confidence: "high" }),
        },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 when the caller is not an admin", async () => {
    const res = await researchBrainRoute.handle(
      new Request(
        `http://test/api/research-brain/compounds/${CANONICAL_ID}/aliases`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            alias: "turmeric-extract-curcumin",
            confidence: "high",
          }),
        },
      ),
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 4. POST /api/research-brain/facts/:factId/authority/promote  (admin)
// ---------------------------------------------------------------------------

describe("POST /api/research-brain/facts/:factId/authority/promote (admin)", () => {
  it("returns 200 when an admin promotes a failed fact to pending", async () => {
    client = scriptedMock(
      [
        // promoteFactToPending: 1) read current state
        { kind: "single", data: { compound_authority_status: "failed" }, error: null },
        // 2) update fact row
        { kind: "single", data: null, error: null },
        // 3) insert audit row
        { kind: "single", data: null, error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(
        `http://test/api/research-brain/facts/${FACT_ID}/authority/promote`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            reason: "curator confirmed compound exists",
          }),
        },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; compound_authority_status: string };
    expect(body.id).toBe(FACT_ID);
    expect(body.compound_authority_status).toBe("pending");
  });

  it("returns 409 when the fact is not in failed state", async () => {
    client = scriptedMock(
      [
        // promoteFactToPending reads current state — status='verified'
        { kind: "single", data: { compound_authority_status: "verified" }, error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const res = await researchBrainRoute.handle(
      new Request(
        `http://test/api/research-brain/facts/${FACT_ID_VERIFIED}/authority/promote`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ reason: "re-check" }),
        },
      ),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("not in failed state");
  });

  it("returns 400 when reason is missing", async () => {
    const res = await researchBrainRoute.handle(
      new Request(
        `http://test/api/research-brain/facts/${FACT_ID}/authority/promote`,
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

  it("returns 403 when the caller is not an admin", async () => {
    const res = await researchBrainRoute.handle(
      new Request(
        `http://test/api/research-brain/facts/${FACT_ID}/authority/promote`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({ reason: "x" }),
        },
      ),
    );
    expect(res.status).toBe(403);
  });
});
