import { Elysia, t } from "elysia";
import { getServiceClient } from "../db/client";
import logger from "../utils/logger";

const supabase = getServiceClient();

// Lightweight per-IP rate limit for this public, unauthenticated endpoint.
// In-memory + per-process (no Redis dependency): sufficient to blunt casual
// spam of the leads table. Not a substitute for a CAPTCHA on a hard target.
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_MAX = parseInt(
  process.env.WAITLIST_RATE_LIMIT_PER_10MIN || "5",
  10,
);
const ipHits = new Map<string, number[]>();

function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();

  // Opportunistic sweep so the map can't grow unbounded under IP rotation.
  if (ipHits.size > 10_000) {
    for (const [key, hits] of ipHits) {
      if (hits.every((t) => now - t >= RATE_WINDOW_MS)) ipHits.delete(key);
    }
  }

  const recent = (ipHits.get(ip) || []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  if (recent.length >= RATE_MAX) {
    ipHits.set(ip, recent);
    return true;
  }
  recent.push(now);
  ipHits.set(ip, recent);
  return false;
}

export const waitlistRoute = new Elysia({ prefix: "/api/waitlist" }).post(
  "/",
  async ({ body, set, request }) => {
    if (isRateLimited(clientIp(request))) {
      set.status = 429;
      return {
        success: false,
        message: "Too many requests. Please try again later.",
      };
    }

    if (!body.agreed_to_updates) {
      set.status = 400;
      return {
        success: false,
        message: "You must agree to receive updates to join the waitlist",
      };
    }

    const email = body.email.trim().toLowerCase();

    const { data, error } = await supabase
      .from("waitlist_leads")
      .insert({
        full_name: body.full_name.trim(),
        email,
        wallet_address: body.wallet_address?.trim() || null,
        role: body.role,
        organization: body.organization?.trim() || null,
        use_case: body.use_case.trim(),
        referral_source: body.referral_source?.trim() || null,
        twitter_handle: body.twitter_handle?.trim() || null,
        agreed_to_updates: true,
      })
      .select("id")
      .single();

    if (error) {
      if (error.code === "23505") {
        set.status = 409;
        return {
          success: false,
          message: "This email is already on the waitlist",
        };
      }

      logger.error({ error: error.message }, "waitlist_insert_failed");
      set.status = 500;
      return { success: false, message: "Failed to join waitlist" };
    }

    logger.info({ waitlistId: data?.id, email }, "waitlist_signup");

    return {
      success: true,
      message: "You're on the list! We'll notify you when access opens.",
    };
  },
  {
    body: t.Object({
      full_name: t.String({ minLength: 1, maxLength: 200 }),
      email: t.String({ format: "email", maxLength: 320 }),
      wallet_address: t.Optional(t.String({ maxLength: 100 })),
      role: t.String({ minLength: 1, maxLength: 100 }),
      organization: t.Optional(t.String({ maxLength: 200 })),
      use_case: t.String({ minLength: 1, maxLength: 4000 }),
      referral_source: t.Optional(t.String({ maxLength: 200 })),
      twitter_handle: t.Optional(t.String({ maxLength: 100 })),
      agreed_to_updates: t.Boolean(),
    }),
  },
);
