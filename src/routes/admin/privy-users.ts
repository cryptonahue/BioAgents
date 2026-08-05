/**
 * Admin Privy Users API
 *
 * `GET /api/admin/privy-users` — list Privy-authenticated users with local whitelist cross-reference
 *
 * This endpoint queries Privy's `getUsers()` API and cross-references results
 * with the local `users` table via `user_id` column. Admins can see ALL Privy
 * users who registered via Privy but may not have completed login in BioAgents.
 */

import { Elysia } from "elysia";
import { authResolver } from "../../middleware/authResolver";
import { getServiceClient } from "../../db/client";
import { getPrivyClient } from "../../services/privy-auth";
import type { AuthContext } from "../../types/auth";
import logger from "../../utils/logger";

const MAX_PAGE_SIZE = 100;

interface PrivyUserEntry {
  id: string;
  email: string | null;
  walletAddress: string | null;
  createdAt: string;
  isGuest: boolean;
  localUserId: string | null;
  whitelisted: boolean;
  hasAccount: boolean;
}

interface PrivyUsersResponse {
  users: PrivyUserEntry[];
  total: number;
  page: number;
  limit: number;
}

/**
 * The authenticated caller. `authResolver` has already run (it is the
 * `beforeHandle`), so `request.auth` is present and its `claims.role` is
 * `"admin"` — otherwise the request never reached the handler.
 */
function actorId(request: Request): string {
  return (request as Request & { auth?: AuthContext }).auth?.userId ?? "unknown";
}

export const privyUsersRoute = new Elysia()
  /**
   * List Privy users with local whitelist cross-reference.
   *
   * Query params:
   *   - search: Filter by email, wallet address, or Privy ID
   *   - page: Page number (0-indexed, default 0)
   *   - limit: Results per page (default 50, max 100)
   */
  .get(
    "/api/admin/privy-users",
    async ({ query, set, request }) => {
      const search = typeof query.search === "string" ? query.search.trim() : "";
      const limit = Math.min(
        Math.max(Number(query.limit) || 50, 1),
        MAX_PAGE_SIZE,
      );
      const page = Math.max(Number(query.page) || 0, 0);

      const privyClient = getPrivyClient();
      if (!privyClient) {
        set.status = 503;
        return { error: "Privy is not configured" };
      }

      try {
        // Query Privy for users. getUsers() has 3 overloads:
        //   1. getUsers() → all users
        //   2. getUsers(searchTerm: string) → filter by search
        //   3. getUsers(bulkParams: BulkParams) → bulk lookup by email/wallet/phone
        // We use overload 2 when search is provided, otherwise 1.
        const privyUsers = search
          ? await privyClient.getUsers(search)
          : await privyClient.getUsers();

        // Batch-query local users table for cross-reference
        const supabase = getServiceClient();
        let localUsers: { user_id: string; id: string; access_type: string | null }[] = [];

        if (privyUsers.length > 0) {
          const privyIds = privyUsers.map((u) => u.id);
          const { data, error } = await supabase
            .from("users")
            .select("user_id, id, access_type")
            .in("user_id", privyIds);

          if (error) {
            logger.warn(
              { err: error, event: "admin_privy_users_local_query_failed" },
              "failed to query local users for cross-reference",
            );
            // Continue with empty local users - degrade gracefully
          } else {
            localUsers = (data ?? []) as { user_id: string; id: string; access_type: string | null }[];
          }
        }

        // Build a lookup map: privyId -> local user
        const localUserMap = new Map<string, { id: string; access_type: string | null }>();
        for (const local of localUsers) {
          if (local.user_id) {
            localUserMap.set(local.user_id, { id: local.id, access_type: local.access_type });
          }
        }

        // Merge Privy data with local user data
        const mergedUsers: PrivyUserEntry[] = privyUsers.map((privyUser) => {
          const local = localUserMap.get(privyUser.id);
          return {
            id: privyUser.id,
            email: privyUser.email?.address ?? null,
            walletAddress: privyUser.wallet?.address ?? null,
            createdAt: privyUser.createdAt instanceof Date
              ? privyUser.createdAt.toISOString()
              : String(privyUser.createdAt),
            isGuest: privyUser.isGuest ?? false,
            localUserId: local?.id ?? null,
            whitelisted: local?.access_type === "whitelisted",
            hasAccount: !!local,
          };
        });

        // Privy's getUsers returns ALL users at once — no server-side pagination.
        // We slice the merged array for page/limit after cross-referencing.
        const total = mergedUsers.length;
        const start = page * limit;
        const pagedUsers = mergedUsers.slice(start, start + limit);

        logger.info(
          {
            event: "admin_privy_users_listed",
            actorUserId: actorId(request),
            returned: pagedUsers.length,
            total,
            search: search || undefined,
            page,
            limit,
          },
          "admin_privy_users_listed",
        );

        return {
          users: pagedUsers,
          total,
          page,
          limit,
        };
      } catch (err: any) {
        // Distinguish between Privy API errors and other errors
        if (err?.message?.toLowerCase()?.includes("privy") || err?.status || err?.statusCode) {
          logger.error(
            { err, event: "admin_privy_users_privy_failed" },
            "Privy API call failed",
          );
          set.status = 502;
          return { error: "Failed to fetch users from Privy", message: err?.message };
        }

        logger.error(
          { err, event: "admin_privy_users_failed" },
          "privy-users endpoint threw",
        );
        set.status = 500;
        return { error: "Internal server error" };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  );

export default privyUsersRoute;
