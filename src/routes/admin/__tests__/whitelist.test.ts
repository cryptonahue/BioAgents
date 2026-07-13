/**
 * Unit tests for the admin whitelist route.
 *
 * THE SECURITY TESTS ARE THE POINT OF THIS FILE. This endpoint grants and
 * revokes access to the entire application, so the coverage that matters is
 * the negative space:
 *
 *   - a non-admin JWT is rejected
 *   - no auth at all is rejected
 *   - a caller who FORGES `role: "admin"` in an unsigned / wrongly-signed
 *     token is rejected (the signature is what carries the role)
 *   - a caller who supplies `role: "admin"` as a header or a BODY FIELD is
 *     rejected (the resolver only ever reads the role from verified claims)
 *   - and all of the above on the MUTATING route, not just the read one
 *
 * Auth is exercised through the REAL `authResolver` via real JWTs (the same
 * pattern as `cost-totals.test.ts`); only the DB client is mocked.
 */

// Set the auth env BEFORE any import, so `getAuthConfig()` inside the
// resolver reads the right values at module-init time.
process.env.AUTH_MODE = "jwt";
process.env.BIOAGENTS_SECRET =
  process.env.BIOAGENTS_SECRET || "test-jwt-secret-for-whitelist-tests";

import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";
import * as jose from "jose";

// ---------------------------------------------------------------------------
// Mocks — DB client only.
// ---------------------------------------------------------------------------

type Terminal = { data: unknown; error: unknown; count?: number };

const BUILDER_METHODS = [
  "from",
  "select",
  "eq",
  "gte",
  "lte",
  "or",
  "order",
  "range",
  "update",
  "in",
];

declare global {
  // eslint-disable-next-line no-var
  var __whitelistTestClient: (() => any) | undefined;
}

/**
 * A chainable Supabase stub. Terminal calls are `await`ed either directly
 * (thenable) or via `.maybeSingle()`; the script is consumed in order.
 */
function scriptedClient(script: Terminal[]) {
  const calls: { method: string; args: unknown[] }[] = [];
  let cursor = 0;
  const next = () => script[cursor++] ?? { data: null, error: null };

  const builder: any = {};
  for (const m of BUILDER_METHODS) {
    builder[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return builder;
    };
  }
  builder.maybeSingle = () => {
    calls.push({ method: "maybeSingle", args: [] });
    return Promise.resolve(next());
  };
  Object.defineProperty(builder, "then", {
    get() {
      return (onFulfilled: any) => Promise.resolve(next()).then(onFulfilled);
    },
  });
  return { client: builder, calls };
}

mock.module("../../../db/client", () => ({
  getServiceClient: () => (globalThis.__whitelistTestClient ?? (() => null))(),
  getAnonClient: () => (globalThis.__whitelistTestClient ?? (() => null))(),
  getSupabaseClient: () => (globalThis.__whitelistTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () => (globalThis.__whitelistTestClient ?? (() => null))(),
}));

// SUT (post-mock)
import { whitelistRoute } from "../whitelist";
import { generateTestJWT } from "../../../services/jwt";

const ADMIN_ID = "00000000-0000-0000-0000-0000000000a1";
const USER_ID = "00000000-0000-0000-0000-0000000000a2";
const TARGET_ID = "00000000-0000-0000-0000-0000000000b9";

let adminToken: string;
let userToken: string;
/** A token with `role: "admin"` signed with the WRONG secret. */
let forgedToken: string;

const row = (over: Record<string, unknown> = {}) => ({
  id: TARGET_ID,
  email: "target@example.com",
  username: "target",
  user_id: "did:privy:xyz",
  access_type: null,
  role: "user",
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

beforeAll(async () => {
  adminToken = await generateTestJWT({ sub: ADMIN_ID, role: "admin" });
  userToken = await generateTestJWT({ sub: USER_ID, role: "user" });

  // Same claims as `adminToken`, signed with a secret the server does not
  // hold. This is the forgery the guard has to reject.
  forgedToken = await new jose.SignJWT({ sub: USER_ID, role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("not-the-real-bioagents-secret"));
});

beforeEach(() => {
  globalThis.__whitelistTestClient = undefined;
});

function setClient(factory: () => any) {
  globalThis.__whitelistTestClient = factory;
}

function list(token?: string, qs = "") {
  return whitelistRoute.handle(
    new Request(`http://test/api/admin/whitelist/users${qs}`, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );
}

function setAccess(
  token: string | undefined,
  targetId: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return whitelistRoute.handle(
    new Request(`http://test/api/admin/whitelist/${targetId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    }),
  );
}

// ---------------------------------------------------------------------------
// SECURITY — the reason this file exists
// ---------------------------------------------------------------------------

describe("admin whitelist route — authorization", () => {
  it("rejects a non-admin caller on the LIST route", async () => {
    const res = await list(userToken);
    expect([401, 403]).toContain(res.status);
  });

  it("rejects a non-admin caller on the MUTATING route", async () => {
    const res = await setAccess(userToken, TARGET_ID, { whitelisted: true });
    expect([401, 403]).toContain(res.status);
  });

  it("rejects a caller with no auth at all on both routes", async () => {
    expect([401, 403]).toContain((await list()).status);
    expect([401, 403]).toContain(
      (await setAccess(undefined, TARGET_ID, { whitelisted: true })).status,
    );
  });

  it("rejects a FORGED admin token signed with the wrong secret", async () => {
    // The claims say `role: "admin"`. The signature does not verify, so the
    // resolver never populates `claims` and the role check sees `undefined`.
    const res = await setAccess(forgedToken, TARGET_ID, { whitelisted: true });
    expect([401, 403]).toContain(res.status);
  });

  it("rejects a role smuggled in via a HEADER or the BODY", async () => {
    // `resolveProvidedUserId` reads `X-User-Id` and `body.userId`, but only
    // ever into `auth.userId` — never into `auth.claims`. A client-supplied
    // `role` is not read from anywhere.
    const res = await setAccess(
      userToken,
      TARGET_ID,
      { whitelisted: true, role: "admin", userId: ADMIN_ID },
      { "X-User-Id": ADMIN_ID, "X-Role": "admin" },
    );
    expect([401, 403]).toContain(res.status);
  });

  it("does not mutate the DB when authorization fails", async () => {
    const { client, calls } = scriptedClient([{ data: row(), error: null }]);
    setClient(() => client);

    await setAccess(userToken, TARGET_ID, { whitelisted: true });

    // The guard is a `beforeHandle`, so the handler never runs.
    expect(calls.find((c) => c.method === "update")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Self-lockout
// ---------------------------------------------------------------------------

describe("admin whitelist route — self-lockout", () => {
  it("blocks an admin from revoking their OWN access", async () => {
    const { client, calls } = scriptedClient([{ data: row(), error: null }]);
    setClient(() => client);

    const res = await setAccess(adminToken, ADMIN_ID, { whitelisted: false });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("cannot_revoke_self");
    // Blocked before any write.
    expect(calls.find((c) => c.method === "update")).toBeUndefined();
  });

  it("allows an admin to GRANT to themselves (not a lockout)", async () => {
    const { client } = scriptedClient([
      { data: row({ id: ADMIN_ID, access_type: null }), error: null },
      {
        data: row({ id: ADMIN_ID, access_type: "whitelisted" }),
        error: null,
      },
    ]);
    setClient(() => client);

    const res = await setAccess(adminToken, ADMIN_ID, { whitelisted: true });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

describe("admin whitelist route — behavior", () => {
  it("lists users with their access state", async () => {
    const { client } = scriptedClient([
      {
        data: [
          row({ access_type: "whitelisted" }),
          row({ id: USER_ID, email: "pending@example.com", access_type: null }),
        ],
        error: null,
        count: 2,
      },
    ]);
    setClient(() => client);

    const res = await list(adminToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: any[]; total: number };
    expect(body.users).toHaveLength(2);
    expect(body.users[0].whitelisted).toBe(true);
    expect(body.users[1].whitelisted).toBe(false);
    expect(body.total).toBe(2);
  });

  it("surfaces admins in the list so the UI can mark them", async () => {
    const { client } = scriptedClient([
      { data: [row({ role: "admin" })], error: null, count: 1 },
    ]);
    setClient(() => client);

    const res = await list(adminToken);
    const body = (await res.json()) as { users: any[] };
    expect(body.users[0].isAdmin).toBe(true);
  });

  it("grants access: access_type -> 'whitelisted'", async () => {
    const { client, calls } = scriptedClient([
      { data: row({ access_type: null }), error: null },
      { data: row({ access_type: "whitelisted" }), error: null },
    ]);
    setClient(() => client);

    const res = await setAccess(adminToken, TARGET_ID, { whitelisted: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: any; changed: boolean };
    expect(body.user.whitelisted).toBe(true);
    expect(body.changed).toBe(true);

    const update = calls.find((c) => c.method === "update");
    expect(update?.args[0]).toEqual({ access_type: "whitelisted" });
  });

  it("revokes access: access_type -> null (the CLI's semantics)", async () => {
    const { client, calls } = scriptedClient([
      { data: row({ access_type: "whitelisted" }), error: null },
      { data: row({ access_type: null }), error: null },
    ]);
    setClient(() => client);

    const res = await setAccess(adminToken, TARGET_ID, { whitelisted: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: any };
    expect(body.user.whitelisted).toBe(false);

    const update = calls.find((c) => c.method === "update");
    expect(update?.args[0]).toEqual({ access_type: null });
  });

  it("is idempotent — no write when the state already matches", async () => {
    const { client, calls } = scriptedClient([
      { data: row({ access_type: "whitelisted" }), error: null },
    ]);
    setClient(() => client);

    const res = await setAccess(adminToken, TARGET_ID, { whitelisted: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean };
    expect(body.changed).toBe(false);
    expect(calls.find((c) => c.method === "update")).toBeUndefined();
  });

  it("404s on an unknown user", async () => {
    const { client } = scriptedClient([{ data: null, error: null }]);
    setClient(() => client);

    const res = await setAccess(adminToken, TARGET_ID, { whitelisted: true });
    expect(res.status).toBe(404);
  });

  it("400s on a body that is not { whitelisted: boolean }", async () => {
    const { client } = scriptedClient([{ data: row(), error: null }]);
    setClient(() => client);

    const res = await setAccess(adminToken, TARGET_ID, { whitelisted: "yes" });
    expect(res.status).toBe(400);
  });
});
