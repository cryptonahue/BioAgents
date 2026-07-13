/**
 * Tests for the Resend REST mailer.
 *
 * THE CONTRACT UNDER TEST IS "IT NEVER THROWS". Every failure mode — no key, a
 * 4xx, a 5xx, a dead network — must come back as a VALUE, because the caller is
 * the whitelist-grant handler and an exception there would surface as a failed
 * approval for a user who has, in fact, already been granted access.
 *
 * `fetch` is stubbed rather than mock.module'd: the mailer calls global `fetch`
 * directly (no client object, no pool — see the header of `services/mailer.ts`),
 * so replacing the global IS the seam.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  buildApprovalEmail,
  getMailerConfig,
  isMailerConfigured,
  sendApprovalEmail,
  sendMail,
} from "../mailer";

const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  init: RequestInit;
}

let captured: Captured[] = [];

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  globalThis.fetch = (async (input: any, init: any) => {
    captured.push({ url: String(input), init: init ?? {} });
    return impl(String(input), init ?? {});
  }) as typeof fetch;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const MSG = {
  to: "ada@lab.org",
  subject: "hi",
  text: "plain",
  html: "<p>rich</p>",
};

beforeEach(() => {
  captured = [];
  process.env.RESEND_API_KEY = "re_test_key_do_not_log";
  process.env.RESEND_FROM = "CoralGPT <no-reply@coralgpt.xyz>";
  delete process.env.CORALGPT_APP_URL;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
});

// ---------------------------------------------------------------------------
// Config — the feature switch
// ---------------------------------------------------------------------------

describe("mailer config", () => {
  it("is DISABLED with no RESEND_API_KEY (and does not throw)", () => {
    delete process.env.RESEND_API_KEY;
    expect(getMailerConfig()).toBeNull();
    expect(isMailerConfigured()).toBe(false);
  });

  it("is DISABLED with a key but no verified RESEND_FROM", () => {
    delete process.env.RESEND_FROM;
    // A key with no verified sender cannot send — Resend rejects the domain.
    // Better to be visibly OFF than to 422 on every approval.
    expect(getMailerConfig()).toBeNull();
  });

  it("reads config INSIDE the call, so env set after import is picked up", () => {
    // This is the TDZ guarantee: nothing is captured at module scope.
    process.env.RESEND_API_KEY = "re_changed_later";
    expect(getMailerConfig()?.apiKey).toBe("re_changed_later");
  });
});

// ---------------------------------------------------------------------------
// The send path
// ---------------------------------------------------------------------------

describe("sendMail — success", () => {
  it("POSTs the documented Resend shape and reports the id", async () => {
    stubFetch(async () => json(200, { id: "49a3999c-0ce1" }));

    const result = await sendMail(MSG);
    expect(result).toEqual({ sent: true, id: "49a3999c-0ce1" });

    const call = captured[0]!;
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.init.method).toBe("POST");

    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key_do_not_log");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(call.init.body as string);
    expect(body.from).toBe("CoralGPT <no-reply@coralgpt.xyz>");
    expect(body.to).toEqual(["ada@lab.org"]);
    expect(body.subject).toBe("hi");
    expect(body.text).toBe("plain");
    expect(body.html).toBe("<p>rich</p>");
  });

  it("still counts a 2xx with an unparseable body as sent", async () => {
    stubFetch(async () => new Response("", { status: 200 }));
    expect(await sendMail(MSG)).toEqual({ sent: true, id: undefined });
  });
});

// ---------------------------------------------------------------------------
// THE FAILURE PATHS — none of these may throw
// ---------------------------------------------------------------------------

describe("sendMail — every failure is a value, never an exception", () => {
  it("no key configured -> { sent: false, not_configured }, and NO request", async () => {
    delete process.env.RESEND_API_KEY;
    stubFetch(async () => json(200, { id: "x" }));

    const result = await sendMail(MSG);
    expect(result).toEqual({ sent: false, reason: "not_configured" });
    // It must not even try.
    expect(captured).toHaveLength(0);
  });

  it("a 500 from the API -> { sent: false, api_error }", async () => {
    stubFetch(async () => json(500, { name: "application_error" }));
    expect(await sendMail(MSG)).toEqual({ sent: false, reason: "api_error" });
  });

  it("a 401/403 (bad key) -> { sent: false, api_error }", async () => {
    stubFetch(async () => json(403, { name: "invalid_api_key" }));
    expect(await sendMail(MSG)).toEqual({ sent: false, reason: "api_error" });
  });

  it("a 429 (rate limited) -> { sent: false, api_error }", async () => {
    stubFetch(async () => json(429, { name: "rate_limit_exceeded" }));
    expect(await sendMail(MSG)).toEqual({ sent: false, reason: "api_error" });
  });

  it("an error status with an UNPARSEABLE body still fails cleanly", async () => {
    // Resend does not document an error envelope, so the code must not depend
    // on one. HTML from a proxy, an empty body — all of it is just "api_error".
    stubFetch(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    expect(await sendMail(MSG)).toEqual({ sent: false, reason: "api_error" });
  });

  it("a dead network (fetch rejects) -> { sent: false, network_error }", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    expect(await sendMail(MSG)).toEqual({ sent: false, reason: "network_error" });
  });
});

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

describe("approval email template", () => {
  it("carries a plain-text part AND an HTML part", () => {
    const mail = buildApprovalEmail({ name: "Ada" });
    expect(mail.subject).toBe("Your CoralGPT access is ready");
    expect(mail.text).toContain("Hi Ada,");
    expect(mail.text).toContain("Your CoralGPT access is ready");
    expect(mail.html).toContain("<p>");
    // The plain part is self-sufficient — it holds the link, not a "view in
    // HTML" stub.
    expect(mail.text).toContain("https://coralgpt.xyz");
    expect(mail.html).toContain("https://coralgpt.xyz");
  });

  it("falls back to a nameless greeting", () => {
    expect(buildApprovalEmail({ name: null }).text).toContain("Hi,");
    expect(buildApprovalEmail({ name: "   " }).text).toContain("Hi,");
  });

  it("honours CORALGPT_APP_URL", () => {
    process.env.CORALGPT_APP_URL = "https://staging.coralgpt.xyz";
    expect(buildApprovalEmail({ name: "Ada" }).text).toContain(
      "https://staging.coralgpt.xyz",
    );
  });

  it("escapes HTML in the name — it reaches the markup", () => {
    const mail = buildApprovalEmail({ name: '<img src=x onerror="alert(1)">' });
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).toContain("&lt;img");
  });

  it("sendApprovalEmail sends to the given address", async () => {
    stubFetch(async () => json(200, { id: "ok" }));
    const result = await sendApprovalEmail({ to: "ada@lab.org", name: "Ada" });
    expect(result.sent).toBe(true);

    const body = JSON.parse(captured[0]!.init.body as string);
    expect(body.to).toEqual(["ada@lab.org"]);
    expect(body.subject).toBe("Your CoralGPT access is ready");
  });
});
