/**
 * Admin Whitelist API
 *
 * `GET  /api/admin/whitelist/users`      — list users + their access_type
 * `POST /api/admin/whitelist/:userId`    — grant / revoke whitelist access
 *
 * THIS IS THE MOST SECURITY-SENSITIVE SURFACE IN THE PRODUCT: it grants and
 * revokes access to the whole application. Read the three notes below before
 * changing anything here.
 *
 * ---------------------------------------------------------------------------
 * 1. THE GUARD IS SERVER-SIDE AND AUTHORITATIVE
 *
 * `authResolver({ required: true, role: "admin" })` — the SAME guard
 * `cost-totals.ts` and `table-merges.ts` use. Nothing new was invented.
 *
 * It resolves the role from `auth.claims?.role`, and `claims` is populated in
 * exactly ONE branch of the resolver: the JWT branch, from the payload of
 * `jose.jwtVerify(token, secret, { algorithms: ["HS256"] })` — a
 * signature-verified, algorithm-pinned payload. The x402, API-key and
 * anonymous branches never set `claims` at all, so `claims?.role` is
 * `undefined` for them and they get a 403. Not even the master
 * `BIOAGENTS_SECRET` used as an API key can reach this route.
 *
 * The resolver DOES read a caller-supplied `X-User-Id` header / `body.userId`
 * (`resolveProvidedUserId`), but only ever into `auth.userId` — never into
 * `auth.claims`. So the role cannot be spoofed by a header, a body field, or a
 * query param. The only way to hold `role: "admin"` is for `users.role` to be
 * `"admin"` in the database at login time, which is what makes
 * `src/routes/auth.ts` mint the claim.
 *
 * The client-side `useAdmin()` hook decodes the same JWT to hide the menu
 * item. That is a UI affordance, NOT a boundary. This route re-verifies on
 * every single request and does not trust it.
 *
 * ---------------------------------------------------------------------------
 * 2. SELF-LOCKOUT IS IMPOSSIBLE BY CONSTRUCTION — AND STILL BLOCKED
 *
 * This route writes `users.access_type` and NOTHING ELSE. It never touches
 * `users.role` (that is `scripts/grant-admin.ts`'s job, and it stays a CLI).
 *
 * `src/routes/auth.ts` gates login on:
 *
 *     isWhitelisted = user.access_type === "whitelisted" || user.role === "admin"
 *
 * — so an admin who revokes their own whitelist STILL LOGS IN. The admin role
 * bypasses the whitelist gate outright. Self-lockout through this endpoint is
 * therefore not reachable.
 *
 * We block self-revoke anyway (400, `cannot_revoke_self`). It costs nothing —
 * for an admin the write is a no-op with respect to their own access — and it
 * keeps the endpoint safe if someone later drops the `|| isAdmin` bypass from
 * the login gate. Defense in depth against a future edit, not against today's
 * code.
 *
 * ---------------------------------------------------------------------------
 * 3. AUDIT
 *
 * There is NO audit table for this in the schema, and one was not invented.
 * What this route does is what the other admin routes do: structured pino
 * logging (`admin_whitelist_updated`, mirroring `admin_cost_totals_fetched`),
 * recording the ACTOR's id, the TARGET's id, and the before/after value. If a
 * real audit trail is wanted, it needs a migration and should be its own
 * change.
 *
 * ---------------------------------------------------------------------------
 * 4. THE APPROVAL EMAIL CANNOT FAIL THE APPROVAL
 *
 * Granting access does three things, IN THIS ORDER, and the order is the whole
 * design:
 *
 *   1. UPDATE users SET access_type = 'whitelisted'   <- the grant. COMMITS.
 *   2. UPDATE waitlist_leads SET status = 'approved'  <- derived state.
 *   3. POST https://api.resend.com/emails             <- the notification.
 *
 * Steps 2 and 3 run AFTER step 1 has already committed and returned. Neither can
 * roll it back, because there is no transaction spanning them — Supabase's REST
 * client issues each as its own statement, so by the time we look at the email
 * the user ALREADY HAS ACCESS. `sendApprovalEmail()` additionally never throws
 * (see `services/mailer.ts`): an unconfigured key, a 429, a 500 or a DNS failure
 * all come back as a value, not an exception.
 *
 * AN APPROVAL THAT ROLLS BACK BECAUSE A MAIL SERVER HICCUPED IS STRICTLY WORSE
 * THAN AN APPROVAL WITH NO EMAIL. The grant is the thing the user is waiting
 * for; the email is a courtesy on top of it. If the mail fails, the admin is
 * TOLD (`email: { sent: false, reason }` in the response, rendered in the panel)
 * so they can reach out by hand — rather than being left to assume it went out.
 *
 * With no RESEND_API_KEY configured the mailer degrades to a logged no-op and
 * the grant still succeeds. Nothing about mail is required for this route, or
 * for the app, to boot.
 *
 * ---------------------------------------------------------------------------
 * Semantics are lifted from `scripts/whitelist.ts` verbatim, not re-derived:
 * grant sets `access_type = "whitelisted"`, revoke sets it back to `null`.
 */

import { Elysia } from "elysia";
import { authResolver } from "../../middleware/authResolver";
import { getServiceClient } from "../../db/client";
import { sendApprovalEmail } from "../../services/mailer";
import type { AuthContext } from "../../types/auth";
import logger from "../../utils/logger";

/** The one value that means "has access". Same literal as the CLI. */
const WHITELISTED = "whitelisted";

/** Columns the CLI reads, plus `role` so the UI can mark admins. */
const SELECT_COLS = "id, email, username, user_id, access_type, role, created_at";

const MAX_PAGE_SIZE = 100;

interface UserRow {
  id: string;
  email: string | null;
  username: string | null;
  user_id: string | null;
  access_type: string | null;
  role: string | null;
  created_at: string | null;
}

interface WhitelistUser {
  id: string;
  email: string | null;
  username: string | null;
  externalId: string | null;
  accessType: string | null;
  whitelisted: boolean;
  isAdmin: boolean;
  createdAt: string | null;
}

function toWhitelistUser(row: UserRow): WhitelistUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    externalId: row.user_id,
    accessType: row.access_type,
    whitelisted: row.access_type === WHITELISTED,
    isAdmin: row.role === "admin",
    createdAt: row.created_at,
  };
}

/**
 * The authenticated caller. `authResolver` has already run (it is the
 * `beforeHandle`), so `request.auth` is present and its `claims.role` is
 * `"admin"` — otherwise the request never reached the handler.
 */
function actorId(request: Request): string {
  return (request as Request & { auth?: AuthContext }).auth?.userId ?? "unknown";
}

/** What the admin sees about the notification. `null` when none was attempted. */
type EmailOutcome =
  | { sent: true }
  | { sent: false; reason: string };

/**
 * Move the user's `waitlist_leads` row in step with the grant.
 *
 * BEST EFFORT, BY DESIGN. `users.access_type` is the ONLY thing the login gate
 * reads (`routes/auth.ts`); `waitlist_leads.status` is derived state that exists
 * so the admin list can be filtered without a join back through `users`. If this
 * write fails, the user still HAS access — the request row just looks stale in
 * the panel, which is a cosmetic bug, not a lockout. So it is logged and
 * swallowed rather than allowed to fail an approval that already committed.
 *
 * Returns the request row (for the email's recipient and name), or `null` — a
 * user granted access without ever filling in the form has no row, which is
 * normal for anyone the admin whitelisted directly.
 */
async function syncRequestStatus(
  targetId: string,
  approved: boolean,
): Promise<{ email: string | null; full_name: string | null } | null> {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("waitlist_leads")
      .update({ status: approved ? "approved" : "pending" })
      .eq("user_id", targetId)
      .select("email, full_name")
      .maybeSingle();

    if (error) {
      logger.warn(
        {
          err: error,
          event: "admin_whitelist_request_sync_failed",
          targetUserId: targetId,
        },
        "failed to sync the access request status; the grant itself stands",
      );
      return null;
    }

    return data ?? null;
  } catch (err) {
    logger.warn(
      {
        err,
        event: "admin_whitelist_request_sync_failed",
        targetUserId: targetId,
      },
      "access request status sync threw; the grant itself stands",
    );
    return null;
  }
}

/**
 * Tell the user their access is ready.
 *
 * THIS CANNOT FAIL THE APPROVAL. `sendApprovalEmail` never throws (see
 * `services/mailer.ts`); the try/catch here is belt-and-braces against a future
 * edit that breaks that promise. Either way the grant is already committed — we
 * are past the point of no return, and the worst outcome is an approved user who
 * has to be told by hand.
 */
async function notifyApproved(params: {
  targetId: string;
  to: string | null;
  name: string | null;
}): Promise<EmailOutcome> {
  if (!params.to) {
    // A wallet-only user who never filled in the form. Nothing to send to.
    logger.info(
      {
        event: "admin_whitelist_email_skipped",
        targetUserId: params.targetId,
        reason: "no_address",
      },
      "approved user has no email address on file; no notification sent",
    );
    return { sent: false, reason: "no_address" };
  }

  try {
    const result = await sendApprovalEmail({ to: params.to, name: params.name });
    if (result.sent) return { sent: true };
    return { sent: false, reason: result.reason };
  } catch (err) {
    logger.error(
      {
        err,
        event: "admin_whitelist_email_failed",
        targetUserId: params.targetId,
      },
      "approval email threw; the grant itself stands",
    );
    return { sent: false, reason: "send_failed" };
  }
}

export const whitelistRoute = new Elysia()
  /**
   * List users and their access state.
   *
   * Unlike the CLI's `--list` (which shows only users *pending* access), the
   * UI needs the full roster: it renders a toggle per row and has to show the
   * current state of both sides. `?pending=true` narrows it to the CLI's view.
   */
  .get(
    "/api/admin/whitelist/users",
    async ({ query, set, request }) => {
      const search = typeof query.search === "string" ? query.search.trim() : "";
      const pendingOnly = query.pending === "true";
      const limit = Math.min(
        Math.max(Number(query.limit) || 50, 1),
        MAX_PAGE_SIZE,
      );
      const page = Math.max(Number(query.page) || 0, 0);

      try {
        const supabase = getServiceClient();
        let q = supabase
          .from("users")
          .select(SELECT_COLS, { count: "exact" })
          .order("created_at", { ascending: false })
          .range(page * limit, page * limit + limit - 1);

        if (pendingOnly) {
          // Same predicate as the CLI's `list()`.
          q = q.or(`access_type.is.null,access_type.neq.${WHITELISTED}`);
        }

        if (search) {
          // Escape PostgREST's `or()` meta-characters so a search string can
          // never break out of the filter expression it is embedded in.
          const safe = search.replace(/[,()\\*]/g, " ").trim();
          if (safe) {
            q = q.or(
              `email.ilike.*${safe}*,username.ilike.*${safe}*,user_id.ilike.*${safe}*`,
            );
          }
        }

        const { data, error, count } = await q;
        if (error) {
          logger.warn(
            { err: error, event: "admin_whitelist_list_failed" },
            "whitelist list query failed",
          );
          set.status = 500;
          return { error: "Failed to query users" };
        }

        const rows = ((data ?? []) as UserRow[]).map(toWhitelistUser);

        logger.info(
          {
            event: "admin_whitelist_listed",
            actorUserId: actorId(request),
            returned: rows.length,
            total: count ?? rows.length,
            pendingOnly,
          },
          "admin_whitelist_listed",
        );

        return {
          users: rows,
          total: count ?? rows.length,
          page,
          limit,
        };
      } catch (err) {
        logger.error(
          { err, event: "admin_whitelist_list_failed" },
          "whitelist list threw",
        );
        set.status = 500;
        return { error: "Failed to query users" };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  )

  /**
   * Grant or revoke whitelist access for one user.
   *
   * Body: `{ "whitelisted": true }` -> access_type = "whitelisted"
   *       `{ "whitelisted": false }` -> access_type = null
   *
   * The target is addressed by the internal `users.id` (a uuid) only. The CLI
   * also accepts an email or a Privy DID and has to disambiguate; the UI
   * always has the id in hand because it just rendered the row, so this route
   * takes the unambiguous key and skips that whole class of bug.
   */
  .post(
    "/api/admin/whitelist/:userId",
    async ({ params, body, set, request }) => {
      const targetId = params.userId;
      const desired = (body as { whitelisted?: unknown } | null)?.whitelisted;

      if (typeof desired !== "boolean") {
        set.status = 400;
        return {
          error: "Invalid body",
          message: "Expected { whitelisted: boolean }",
        };
      }

      const actor = actorId(request);

      // See note 2 in the header. Not reachable as a real lockout today, but
      // blocked so it stays unreachable if the login gate ever changes.
      if (!desired && targetId === actor) {
        logger.warn(
          {
            event: "admin_whitelist_self_revoke_blocked",
            actorUserId: actor,
          },
          "admin tried to revoke their own whitelist access",
        );
        set.status = 400;
        return {
          error: "cannot_revoke_self",
          message:
            "You cannot revoke your own access. Ask another admin to do it.",
        };
      }

      try {
        const supabase = getServiceClient();

        const { data: existing, error: findError } = await supabase
          .from("users")
          .select(SELECT_COLS)
          .eq("id", targetId)
          .maybeSingle();

        if (findError) {
          logger.warn(
            { err: findError, event: "admin_whitelist_update_failed" },
            "whitelist target lookup failed",
          );
          set.status = 500;
          return { error: "Failed to look up user" };
        }

        if (!existing) {
          set.status = 404;
          return { error: "not_found", message: "No user with that id." };
        }

        const before = (existing as UserRow).access_type;
        const after = desired ? WHITELISTED : null;

        if (before === after) {
          // Idempotent, like the CLI's "already ... — no change."
          return {
            user: toWhitelistUser(existing as UserRow),
            changed: false,
          };
        }

        const { data: updated, error: updateError } = await supabase
          .from("users")
          .update({ access_type: after })
          .eq("id", targetId)
          .select(SELECT_COLS)
          .maybeSingle();

        if (updateError || !updated) {
          logger.warn(
            { err: updateError, event: "admin_whitelist_update_failed" },
            "whitelist update failed",
          );
          set.status = 500;
          return { error: "Failed to update user" };
        }

        // The audit trail. See note 3 in the header — structured logging is
        // the pattern this codebase has; no audit table was invented.
        logger.info(
          {
            event: "admin_whitelist_updated",
            actorUserId: actor,
            targetUserId: targetId,
            before,
            after,
          },
          "admin_whitelist_updated",
        );

        // -------------------------------------------------------------------
        // EVERYTHING BELOW THIS LINE IS A SIDE EFFECT OF AN ALREADY-COMMITTED
        // GRANT. See note 4 in the header. Nothing here can fail the request.
        // -------------------------------------------------------------------
        const request = await syncRequestStatus(targetId, desired);

        const emailResult = desired
          ? await notifyApproved({
              targetId,
              // The address they gave us on the request form is the channel they
              // asked to be reached on, and it is the only one a wallet-only user
              // has. `users.email` is the fallback.
              to: request?.email ?? (updated as UserRow).email,
              name: request?.full_name ?? null,
            })
          : null;

        return {
          user: toWhitelistUser(updated as UserRow),
          changed: true,
          // The admin is told the TRUTH about the notification rather than being
          // left to assume it went out. `null` on a revoke — no email is sent.
          email: emailResult,
        };
      } catch (err) {
        logger.error(
          { err, event: "admin_whitelist_update_failed" },
          "whitelist update threw",
        );
        set.status = 500;
        return { error: "Failed to update user" };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  );

export default whitelistRoute;
