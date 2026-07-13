/**
 * Access Request API — the second half of CoralGPT's single door.
 *
 * `POST /api/access-request` — an AUTHENTICATED user asks for access.
 *
 * This replaces `POST /api/waitlist`, which wrote a `waitlist_leads` row that
 * nothing ever read. The difference is not the form; it is WHEN it runs.
 *
 * ---------------------------------------------------------------------------
 * 1. WHY THIS IS NOT GUARDED BY `authResolver`
 *
 * READ THIS BEFORE "FIXING" THE AUTH ON THIS ROUTE.
 *
 * The user hitting this endpoint is, by definition, NOT whitelisted — that is
 * the only reason they are here. `POST /api/auth/privy` refuses to mint a JWT
 * for them (403, "Access pending approval"), so they hold NO session token, and
 * there is nothing for `authResolver` to verify.
 *
 * The obvious shortcut — mint a limited "pending" JWT so the resolver has
 * something to chew on — IS A PRIVILEGE ESCALATION, and it was deliberately not
 * taken. `authResolver({ required: true })` accepts ANY JWT that verifies
 * against `BIOAGENTS_SECRET`; it does not inspect a `type` claim. A pending-user
 * token would therefore be accepted by `/api/chat`, `/api/library`,
 * `/api/deep-research/*` and every other guarded route in the app — i.e. it
 * would hand the un-approved user exactly the product they are queuing for. The
 * whitelist gate would become decorative.
 *
 * So this route authenticates against PRIVY DIRECTLY, with the same
 * `verifyPrivyAccessToken()` that `/api/auth/privy` uses — a signature-verified
 * token from Privy's JWKS. That gives a cryptographically established identity
 * WITHOUT minting any BioAgents session credential, so nothing this route
 * accepts can be replayed against a guarded endpoint.
 *
 * The user is resolved FROM THE VERIFIED TOKEN and from nothing else. There is
 * no `userId` in the body and none would be read: a caller cannot file a request
 * as somebody else, because the only id in play is the one Privy signed.
 *
 * ---------------------------------------------------------------------------
 * 2. THE DUPLICATE-EMAIL CASE — WHY THIS ADOPTS
 *
 * `waitlist_leads` carries `UNIQUE INDEX ... ON (lower(email))` from the
 * original migration, and it stays. So the pre-auth form's rows are a live
 * hazard: a user who filled the OLD form as `ada@lab.org` and now signs in with
 * that same address would collide on a plain INSERT and take a 23505 → 500.
 *
 * This route ADOPTS instead of rejecting. An orphan row (`user_id IS NULL`) with
 * a matching email is CLAIMED onto the authenticated user with an UPDATE: their
 * earlier answers are replaced by the ones they just typed, and the row keeps
 * its original `created_at` (they really did ask first — the queue position they
 * earned pre-auth is not taken away from them).
 *
 * Rejecting was the other option and it is worse: the user cannot prove they own
 * that old row, cannot delete it, and would be permanently locked out of asking
 * for access by their own earlier signup. Adoption is safe precisely BECAUSE
 * identity is now established before the form runs — the Privy-verified email is
 * the same string the unique index is keyed on, so claiming the row is not a
 * guess.
 *
 * A row already owned by a DIFFERENT user is the one case we refuse (409). That
 * is a genuine conflict — two accounts claiming one mailbox — and silently
 * moving the row would let account B overwrite account A's request.
 *
 * ---------------------------------------------------------------------------
 * 3. EMAIL IS REQUIRED, EVEN FOR A WALLET-ONLY USER
 *
 * Privy will happily authenticate someone who has only a wallet and no email.
 * The form asks for one anyway and the schema keeps `email NOT NULL`, because
 * the email IS the approval notification channel (see `services/mailer.ts`).
 * An address we cannot reach is a request we cannot answer.
 */

import { Elysia, t } from "elysia";
import { getServiceClient } from "../db/client";
import { getOrCreatePrivyUser } from "../db/operations";
import {
  fetchPrivyUser,
  isPrivyConfigured,
  verifyPrivyAccessToken,
} from "../services/privy-auth";
import logger from "../utils/logger";

/** Mirrors `waitlist_leads.status` — see the migration. Two states, no more. */
const PENDING = "pending";

/**
 * Pull the email / wallet Privy holds for a user. Duplicated in shape from
 * `routes/auth.ts` on purpose: these two routes are the only readers of a Privy
 * user object, and a shared helper would be a one-caller abstraction that hides
 * how loose the upstream `linkedAccounts` array actually is.
 */
function extractWallet(user: any): string | undefined {
  return user.linkedAccounts?.find(
    (a: any) =>
      a.type === "wallet" || a.type === "smart_wallet" || a.walletClientType,
  )?.address;
}

function extractEmail(user: any): string | undefined {
  return (
    user.linkedAccounts?.find((a: any) => a.type === "email")?.address ||
    user.email?.address
  );
}

/**
 * Does this user already have a request on file? Used by the login response so
 * the client knows whether to render the form or the "under review" notice.
 *
 * Exported because `routes/auth.ts` answers exactly this question on its 403
 * branch, and asking it twice from two different queries is how the two answers
 * eventually disagree.
 */
export async function findRequestForUser(
  userId: string,
): Promise<{ id: string; status: string; created_at: string } | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("waitlist_leads")
    .select("id, status, created_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    // A read failure must not become "you have no request" — that would show a
    // user who already asked the form again and walk them into a 409. Log it and
    // let the caller decide; `null` here is only ever returned on a clean miss.
    logger.warn(
      { err: error, event: "access_request_lookup_failed" },
      "failed to look up an existing access request",
    );
    throw new Error("lookup_failed");
  }

  return data ?? null;
}

export const accessRequestRoute = new Elysia({ prefix: "/api/access-request" })
  .post(
    "/",
    async ({ body, set }) => {
      if (!isPrivyConfigured()) {
        set.status = 503;
        return {
          success: false,
          message: "Privy authentication is not configured",
        };
      }

      // ---------------------------------------------------------------------
      // Identity first. Everything below hangs off `user.id`, which came out of
      // a Privy-signed token — never out of the request body.
      // ---------------------------------------------------------------------
      let user: { id: string; access_type: string | null };
      let privyEmail: string | undefined;
      let privyWallet: string | undefined;

      try {
        const claims = await verifyPrivyAccessToken(body.accessToken);
        const privyUser = await fetchPrivyUser(claims.userId);
        privyEmail = extractEmail(privyUser);
        privyWallet = extractWallet(privyUser);

        const created = await getOrCreatePrivyUser({
          privyUserId: claims.userId,
          email: privyEmail,
          walletAddress: privyWallet,
        });
        user = created.user;
      } catch (error: any) {
        set.status = 401;
        return {
          success: false,
          message: error?.message || "Invalid Privy access token",
        };
      }

      // Already approved? Then they should be in the app, not filling in a form.
      if (user.access_type === "whitelisted") {
        return { success: true, status: "approved", alreadyApproved: true };
      }

      if (!body.agreed_to_updates) {
        set.status = 400;
        return {
          success: false,
          message: "You must agree to receive updates to request access.",
        };
      }

      // The form's email wins over Privy's: a wallet-only user has none upstream,
      // and a user is allowed to nominate a different address to be reached on.
      const email = body.email.trim().toLowerCase();
      const supabase = getServiceClient();

      const fields = {
        full_name: body.full_name.trim(),
        email,
        wallet_address: body.wallet_address?.trim() || privyWallet || null,
        role: body.role,
        organization: body.organization?.trim() || null,
        use_case: body.use_case.trim(),
        referral_source: body.referral_source?.trim() || null,
        twitter_handle: body.twitter_handle?.trim() || null,
        agreed_to_updates: true,
      };

      try {
        // -------------------------------------------------------------------
        // (a) Already asked? Idempotent — do not create a second row, and do not
        //     error. Re-opening the page and re-submitting should be harmless.
        // -------------------------------------------------------------------
        const existing = await findRequestForUser(user.id);
        if (existing) {
          return {
            success: true,
            status: existing.status,
            alreadyRequested: true,
            submittedAt: existing.created_at,
          };
        }

        // -------------------------------------------------------------------
        // (b) THE ORPHAN. A pre-auth row with this email and no owner. Claim it
        //     rather than colliding with the `lower(email)` unique index.
        //     `.is("user_id", null)` is what makes this safe: it can only ever
        //     match an UNOWNED row, so it cannot steal one from another account.
        // -------------------------------------------------------------------
        const { data: adopted, error: adoptError } = await supabase
          .from("waitlist_leads")
          .update({ ...fields, user_id: user.id, status: PENDING })
          .eq("email", email)
          .is("user_id", null)
          .select("id, created_at")
          .maybeSingle();

        if (adoptError) {
          logger.error(
            { err: adoptError, event: "access_request_adopt_failed" },
            "failed to adopt a pre-auth waitlist row",
          );
          set.status = 500;
          return { success: false, message: "Failed to submit your request." };
        }

        if (adopted) {
          logger.info(
            {
              event: "access_request_adopted_orphan",
              userId: user.id,
              requestId: adopted.id,
            },
            "access_request_adopted_orphan",
          );
          return {
            success: true,
            status: PENDING,
            adopted: true,
            submittedAt: adopted.created_at,
          };
        }

        // -------------------------------------------------------------------
        // (c) The ordinary path: a brand-new request.
        // -------------------------------------------------------------------
        const { data: inserted, error: insertError } = await supabase
          .from("waitlist_leads")
          .insert({ ...fields, user_id: user.id, status: PENDING })
          .select("id, created_at")
          .single();

        if (insertError) {
          // 23505 here means the email belongs to a row we could NOT adopt —
          // i.e. one owned by a DIFFERENT user (an unowned row would have been
          // taken in (b), and this user's own row in (a)). That is a real
          // conflict: two accounts, one mailbox. 409, not 500 — and not a crash.
          if (insertError.code === "23505") {
            logger.warn(
              {
                event: "access_request_email_taken",
                userId: user.id,
              },
              "access request email already belongs to another account",
            );
            set.status = 409;
            return {
              success: false,
              message:
                "That email is already linked to another account. Sign in with that account, or use a different email.",
            };
          }

          logger.error(
            { err: insertError, event: "access_request_insert_failed" },
            "failed to insert an access request",
          );
          set.status = 500;
          return { success: false, message: "Failed to submit your request." };
        }

        logger.info(
          {
            event: "access_request_submitted",
            userId: user.id,
            requestId: inserted?.id,
          },
          "access_request_submitted",
        );

        return {
          success: true,
          status: PENDING,
          submittedAt: inserted?.created_at,
        };
      } catch (err) {
        logger.error(
          { err, event: "access_request_failed" },
          "access request threw",
        );
        set.status = 500;
        return { success: false, message: "Failed to submit your request." };
      }
    },
    {
      body: t.Object({
        // The Privy token IS the auth. Everything else is the form.
        accessToken: t.String(),
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

export default accessRequestRoute;
