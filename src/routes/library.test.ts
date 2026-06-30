/**
 * Offline route tests for the per-paper library Q&A endpoint.
 *
 * Locks in the cost-abuse guard on POST /api/library/:docId/ask: it is a paid
 * LLM endpoint, so it requires a verified JWT (authResolver({ required: true }))
 * and validates docId + question BEFORE any LLM call or DB write.
 *
 * Exercised in isolation via app.handle(new Request(...)). The rate-limit
 * middleware in the route's beforeHandle is a no-op while the job queue is
 * disabled, so it does not interfere here.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";

// Required before the route module loads (see conversations.test.ts for why).
process.env.SUPABASE_URL = "http://localhost:9999";
process.env.SUPABASE_SERVICE_KEY = "dummy-service-key";
process.env.BIOAGENTS_SECRET = "test-secret";
process.env.AUTH_MODE = "jwt";

const USER_ID = "33333333-3333-4333-8333-333333333333";
// docId is base64url(title); base64url("Test") === "VGVzdA".
const VALID_DOC_ID = Buffer.from("Test", "utf-8").toString("base64url");

let libraryRoute: any;
let token: string;

beforeAll(async () => {
  const { clearSecretKeyCache, generateTestJWT } = await import(
    "../services/jwt"
  );
  clearSecretKeyCache();
  token = await generateTestJWT({ sub: USER_ID, type: "ui_session" } as any);
  ({ libraryRoute } = await import("./library"));
});

function app() {
  return new Elysia().use(libraryRoute);
}

describe("library /ask route (jwt mode, offline)", () => {
  it("POST /api/library/:docId/ask with no auth -> 401 (no anonymous LLM cost)", async () => {
    const res = await app().handle(
      new Request(`http://localhost/api/library/${VALID_DOC_ID}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "What is this about?" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("POST /api/library/:docId/ask with valid JWT and empty body -> 400 Missing 'question'", async () => {
    const res = await app().handle(
      new Request(`http://localhost/api/library/${VALID_DOC_ID}/ask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("Missing 'question'");
  });

  it("POST /api/library/:docId/ask with valid JWT but invalid docId -> 400 Invalid docId", async () => {
    // "!" is not valid base64url; decodeDocId yields an empty string -> null.
    const res = await app().handle(
      new Request("http://localhost/api/library/!/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ question: "hi" }),
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("Invalid docId");
  });
});
