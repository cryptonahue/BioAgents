/**
 * Offline route tests for the public waitlist endpoint.
 *
 * Locks in the abuse guards on the unauthenticated POST /api/waitlist/:
 *  - per-IP in-memory rate limiting (WAITLIST_RATE_LIMIT_PER_10MIN),
 *  - TypeBox body validation (length caps -> 422),
 *  - the agreed_to_updates business rule (400).
 *
 * The rate-limit map is module-global and persists across tests within this
 * file, so each test uses a DISTINCT X-Forwarded-For to avoid interference.
 * Requests that pass validation reach the dummy Supabase client and fail fast
 * (500, connection refused) — that is expected; we only assert they are NOT 429.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";

// RATE_MAX is read at module load, so set it before importing the route.
process.env.SUPABASE_URL = "http://localhost:9999";
process.env.SUPABASE_SERVICE_KEY = "dummy-service-key";
process.env.WAITLIST_RATE_LIMIT_PER_10MIN = "2";

let waitlistRoute: any;

beforeAll(async () => {
  ({ waitlistRoute } = await import("./waitlist"));
});

function app() {
  return new Elysia().use(waitlistRoute);
}

function post(ip: string, overrides: Record<string, unknown> = {}) {
  const body = {
    full_name: "Ada Lovelace",
    email: "ada@example.com",
    role: "researcher",
    use_case: "Exploring protein folding literature.",
    agreed_to_updates: true,
    ...overrides,
  };
  return app().handle(
    new Request("http://localhost/api/waitlist/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": ip,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("waitlist route (offline, per-IP rate limit)", () => {
  it("rate-limits the 3rd request from the same IP -> 429", async () => {
    const r1 = await post("9.9.9.9");
    const r2 = await post("9.9.9.9");
    const r3 = await post("9.9.9.9");
    expect(r1.status).not.toBe(429);
    expect(r2.status).not.toBe(429);
    expect(r3.status).toBe(429);
  });

  it("buckets per IP: a different IP is not rate-limited -> not 429", async () => {
    const res = await post("8.8.8.8");
    expect(res.status).not.toBe(429);
  });

  it("rejects an over-long use_case via body validation -> 422", async () => {
    const res = await post("7.7.7.7", { use_case: "x".repeat(5000) });
    expect(res.status).toBe(422);
  });

  it("rejects agreed_to_updates=false -> 400", async () => {
    const res = await post("6.6.6.6", { agreed_to_updates: false });
    expect(res.status).toBe(400);
  });
});
