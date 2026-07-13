/**
 * Tests for POST /api/access-request — the post-auth request form.
 *
 * THE TWO THINGS THAT MATTER HERE:
 *
 *  1. THE DUPLICATE-EMAIL CASE MUST NOT 500. `waitlist_leads` still carries a
 *     UNIQUE INDEX on `lower(email)` from the original migration, so a user who
 *     filled the OLD pre-auth form and then signs in with the SAME address is a
 *     live collision. The route ADOPTS the orphan row instead of inserting a
 *     second one. If a row is owned by ANOTHER user, that is a real conflict and
 *     gets a 409 — still not a 500.
 *
 *  2. IDENTITY COMES FROM THE PRIVY TOKEN AND NOWHERE ELSE. No `userId` is read
 *     from the body, and an invalid token is a 401 that never touches the DB.
 *     This route is deliberately NOT behind `authResolver` (a pending user holds
 *     no JWT, and minting one would open every guarded route) — so the Privy
 *     verification IS the boundary, and it is tested as one.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

const USER_ID = "00000000-0000-0000-0000-00000000f001";
const OTHER_USER_ID = "00000000-0000-0000-0000-00000000f002";

// ---------------------------------------------------------------------------
// Mocks: Privy + the DB. The route under test is real.
// ---------------------------------------------------------------------------

let privyValid = true;
let currentUser: { id: string; access_type: string | null } = {
  id: USER_ID,
  access_type: null,
};

mock.module("../../services/privy-auth", () => ({
  isPrivyConfigured: () => true,
  isCoralGptEnabled: () => true,
  verifyPrivyAccessToken: async (token: string) => {
    if (!privyValid || token === "bad-token") {
      throw new Error("Invalid Privy access token");
    }
    return { userId: "did:privy:abc" };
  },
  fetchPrivyUser: async () => ({
    linkedAccounts: [
      { type: "email", address: "ada@lab.org" },
      { type: "wallet", address: "0xWALLET" },
    ],
  }),
}));

mock.module("../../db/operations", () => ({
  getOrCreatePrivyUser: async () => ({ user: currentUser, isNew: false }),
}));

/**
 * A scripted Supabase stub. Each `.from()` chain resolves through the next
 * scripted terminal; every call is recorded so a test can assert that a write
 * did or did not happen.
 */
type Terminal = { data: unknown; error: unknown };
let script: Terminal[] = [];
let calls: { method: string; args: unknown[] }[] = [];
// The cursor is SHARED across builders, not per-builder. The route calls
// `getServiceClient()` more than once per request (the lookup and the write are
// separate chains), so a per-builder cursor would rewind the script to step 0 on
// the second call and every test would silently assert against the wrong
// terminal.
let cursor = 0;

function makeBuilder() {
  const next = () => script[cursor++] ?? { data: null, error: null };
  const b: any = {};
  for (const m of ["from", "select", "eq", "is", "update", "insert", "order"]) {
    b[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return b;
    };
  }
  b.maybeSingle = () => {
    calls.push({ method: "maybeSingle", args: [] });
    return Promise.resolve(next());
  };
  b.single = () => {
    calls.push({ method: "single", args: [] });
    return Promise.resolve(next());
  };
  return b;
}

mock.module("../../db/client", () => ({
  getServiceClient: () => makeBuilder(),
  getAnonClient: () => makeBuilder(),
  getSupabaseClient: () => makeBuilder(),
  resetClients: () => undefined,
}));

const { accessRequestRoute } = await import("../access-request");

const FORM = {
  full_name: "Ada Lovelace",
  email: "Ada@Lab.org",
  role: "Researcher",
  use_case: "Reef symbiont genomics.",
  agreed_to_updates: true,
};

function submit(body: Record<string, unknown> = {}) {
  return accessRequestRoute.handle(
    new Request("http://test/api/access-request/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: "good-token", ...FORM, ...body }),
    }),
  );
}

beforeEach(() => {
  privyValid = true;
  currentUser = { id: USER_ID, access_type: null };
  script = [];
  calls = [];
  cursor = 0;
});

const wrote = () =>
  calls.some((c) => c.method === "insert" || c.method === "update");

// ---------------------------------------------------------------------------
// Auth boundary
// ---------------------------------------------------------------------------

describe("access request — the Privy token is the boundary", () => {
  it("401s an invalid Privy token and never touches the DB", async () => {
    privyValid = false;
    const res = await submit();
    expect(res.status).toBe(401);
    expect(wrote()).toBe(false);
  });

  it("ignores a userId smuggled in via the body — identity is the token's", async () => {
    // No existing request; the insert should be keyed on the TOKEN's user.
    script = [
      { data: null, error: null }, // findRequestForUser -> none
      { data: null, error: null }, // adopt -> no orphan
      { data: { id: "r1", created_at: "2026-07-12T00:00:00Z" }, error: null },
    ];

    const res = await submit({ userId: OTHER_USER_ID });
    expect(res.status).toBe(200);

    const insert = calls.find((c) => c.method === "insert");
    expect((insert?.args[0] as any).user_id).toBe(USER_ID);
  });
});

// ---------------------------------------------------------------------------
// THE DUPLICATE-EMAIL CASE
// ---------------------------------------------------------------------------

describe("access request — duplicate email must not 500", () => {
  it("ADOPTS a pre-auth orphan row with the same email", async () => {
    script = [
      { data: null, error: null }, // no request for this user yet
      // The UPDATE ... WHERE email = ? AND user_id IS NULL matches the orphan.
      { data: { id: "orphan-1", created_at: "2026-01-01T00:00:00Z" }, error: null },
    ];

    const res = await submit();
    expect(res.status).toBe(200);

    const body = (await res.json()) as { adopted: boolean; submittedAt: string };
    expect(body.adopted).toBe(true);
    // The row keeps its ORIGINAL created_at — they really did ask first.
    expect(body.submittedAt).toBe("2026-01-01T00:00:00Z");

    // Adoption is an UPDATE, and it is scoped to an UNOWNED row: `.is(user_id,
    // null)` is what stops it stealing a row from another account.
    const isNull = calls.find(
      (c) => c.method === "is" && c.args[0] === "user_id" && c.args[1] === null,
    );
    expect(isNull).toBeDefined();
    expect(calls.find((c) => c.method === "insert")).toBeUndefined();
  });

  it("409s (not 500) when the email belongs to ANOTHER account", async () => {
    script = [
      { data: null, error: null }, // no request for this user
      { data: null, error: null }, // no orphan to adopt (the row has an owner)
      { data: null, error: { code: "23505", message: "duplicate key" } },
    ];

    const res = await submit();
    expect(res.status).toBe(409);

    const body = (await res.json()) as { success: boolean; message: string };
    expect(body.success).toBe(false);
    expect(body.message).toContain("another account");
  });

  it("normalises the email to lower case before it is matched or stored", async () => {
    script = [
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: "r1", created_at: "x" }, error: null },
    ];

    await submit(); // FORM.email is "Ada@Lab.org"

    const insert = calls.find((c) => c.method === "insert");
    expect((insert?.args[0] as any).email).toBe("ada@lab.org");
  });
});

// ---------------------------------------------------------------------------
// Idempotence + state
// ---------------------------------------------------------------------------

describe("access request — state", () => {
  it("is idempotent: a user who already asked does not get a second row", async () => {
    script = [
      {
        data: { id: "r1", status: "pending", created_at: "2026-02-02T00:00:00Z" },
        error: null,
      },
    ];

    const res = await submit();
    expect(res.status).toBe(200);

    const body = (await res.json()) as { alreadyRequested: boolean };
    expect(body.alreadyRequested).toBe(true);
    expect(wrote()).toBe(false);
  });

  it("short-circuits an already-whitelisted user — no form row is written", async () => {
    currentUser = { id: USER_ID, access_type: "whitelisted" };

    const res = await submit();
    expect(res.status).toBe(200);

    const body = (await res.json()) as { alreadyApproved: boolean };
    expect(body.alreadyApproved).toBe(true);
    expect(wrote()).toBe(false);
  });

  it("rejects agreed_to_updates=false -> 400, no write", async () => {
    const res = await submit({ agreed_to_updates: false });
    expect(res.status).toBe(400);
    expect(wrote()).toBe(false);
  });

  it("rejects an over-long use_case via body validation -> 422", async () => {
    const res = await submit({ use_case: "x".repeat(5000) });
    expect(res.status).toBe(422);
  });

  it("requires an email even though Privy may not have one -> 422", async () => {
    const res = await submit({ email: undefined });
    expect(res.status).toBe(422);
  });
});
