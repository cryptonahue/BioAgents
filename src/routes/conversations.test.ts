/**
 * Offline route tests for the conversations endpoints.
 *
 * These lock in the RLS-replacement security fix: every conversations read is
 * gated by authResolver({ required: true }) in JWT mode, so an X-User-Id header
 * can no longer impersonate a user, and malformed conversation ids are rejected
 * (400) before they ever reach Postgres.
 *
 * The route is an exported Elysia instance, exercised in isolation via
 * app.handle(new Request(...)) — no server, no Redis, and no real Supabase.
 * Auth/validation guards return BEFORE the (dummy) Supabase client is used, so
 * these assertions are deterministic without a database.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";

// getServiceClient() throws at construction without these, and the route module
// (transitively) constructs it. AUTH_MODE/BIOAGENTS_SECRET must also be set
// before import because authResolver() reads getAuthConfig() at factory time.
process.env.SUPABASE_URL = "http://localhost:9999";
process.env.SUPABASE_SERVICE_KEY = "dummy-service-key";
process.env.BIOAGENTS_SECRET = "test-secret";
process.env.AUTH_MODE = "jwt";

// Valid v4-shaped UUIDs (pass the route's UUID_REGEX).
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONV_ID = "22222222-2222-4222-8222-222222222222";

let conversationsRoute: any;
let token: string;

beforeAll(async () => {
  const { clearSecretKeyCache, generateTestJWT } = await import(
    "../services/jwt"
  );
  clearSecretKeyCache();
  token = await generateTestJWT({ sub: USER_ID, type: "ui_session" } as any);
  ({ conversationsRoute } = await import("./conversations"));
});

function app() {
  return new Elysia().use(conversationsRoute);
}

describe("conversations route (jwt mode, offline)", () => {
  it("GET /api/conversations with no Authorization header -> 401", async () => {
    const res = await app().handle(
      new Request("http://localhost/api/conversations", { method: "GET" }),
    );
    expect(res.status).toBe(401);
  });

  it("GET /api/conversations with X-User-Id but no token cannot impersonate -> 401", async () => {
    // The core RLS-fix property: a caller-supplied user id is NOT trusted when
    // auth is required; only a verified JWT sub may scope the read.
    const res = await app().handle(
      new Request("http://localhost/api/conversations", {
        method: "GET",
        headers: { "X-User-Id": USER_ID },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("GET /api/conversations/:id/messages with a non-uuid id (valid JWT) -> 400", async () => {
    const res = await app().handle(
      new Request("http://localhost/api/conversations/not-a-uuid/messages", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("GET /api/conversations/:id/messages with a valid uuid (valid JWT) passes the guards", async () => {
    // Auth + UUID validation both pass; the handler then hits the dummy DB and
    // fails (500). We only assert it got PAST the security guards.
    const res = await app().handle(
      new Request(`http://localhost/api/conversations/${CONV_ID}/messages`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(400);
  });
});
