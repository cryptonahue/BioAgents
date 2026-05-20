import { Elysia, t } from "elysia";
import { getServiceClient } from "../db/client";
import logger from "../utils/logger";

const supabase = getServiceClient();

export const waitlistRoute = new Elysia({ prefix: "/api/waitlist" }).post(
  "/",
  async ({ body, set }) => {
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
      full_name: t.String({ minLength: 1 }),
      email: t.String({ format: "email" }),
      wallet_address: t.Optional(t.String()),
      role: t.String({ minLength: 1 }),
      organization: t.Optional(t.String()),
      use_case: t.String({ minLength: 1 }),
      referral_source: t.Optional(t.String()),
      twitter_handle: t.Optional(t.String()),
      agreed_to_updates: t.Boolean(),
    }),
  },
);
