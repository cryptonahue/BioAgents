import { useCallback, useEffect, useState } from "preact/hooks";

/**
 * useWhitelist — admin-only hooks for the whitelist manager.
 *
 * Wraps the two admin routes in `src/routes/admin/whitelist.ts`:
 *   GET  /api/admin/whitelist/users
 *   POST /api/admin/whitelist/:userId   { whitelisted: boolean }
 *
 * Same auth pattern as `useAdminReview`: the JWT goes out in the
 * `Authorization` header. The server re-verifies it on every request —
 * this hook's job is to render the state, not to guard it.
 */

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = localStorage.getItem("bioagents_auth_token");
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function jsonOrError(res: Response, fallback: string): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || data?.error || fallback);
  }
  return data;
}

/**
 * The access request behind a pending user — the REASON to approve them.
 * `null` for a user the admin whitelisted directly, who never filled the form.
 */
export interface AccessRequest {
  fullName: string | null;
  email: string | null;
  role: string | null;
  organization: string | null;
  useCase: string | null;
  referralSource: string | null;
  twitterHandle: string | null;
  status: string;
  requestedAt: string | null;
}

export interface WhitelistUser {
  id: string;
  email: string | null;
  username: string | null;
  externalId: string | null;
  accessType: string | null;
  whitelisted: boolean;
  isAdmin: boolean;
  createdAt: string | null;
  request: AccessRequest | null;
}

/** What became of the approval email. `null` on a revoke — none is sent. */
export interface EmailOutcome {
  sent: boolean;
  reason?: string;
}

export interface WhitelistUsersResponse {
  users: WhitelistUser[];
  total: number;
  page: number;
  limit: number;
}

export interface UseWhitelistUsersParams {
  search?: string;
  pendingOnly?: boolean;
  page?: number;
}

export function useWhitelistUsers(params: UseWhitelistUsersParams) {
  const { search = "", pendingOnly = false, page = 0 } = params;
  const [data, setData] = useState<WhitelistUsersResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchUsers = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams({ page: String(page) });
      if (search) qs.set("search", search);
      if (pendingOnly) qs.set("pending", "true");

      const res = await fetch(`/api/admin/whitelist/users?${qs}`, {
        headers: getAuthHeaders(),
        credentials: "include",
      });
      setData(await jsonOrError(res, "Failed to load users"));
    } catch (err: any) {
      setError(err?.message || "Failed to load users");
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [search, pendingOnly, page]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  return { data, isLoading, error, refetch: fetchUsers };
}

/**
 * Grant / revoke. Resolves to the updated row AND what became of the approval
 * email, so the panel can tell the admin the truth about the notification
 * instead of leaving them to assume it went out.
 *
 * The email NEVER fails the grant (see `src/routes/admin/whitelist.ts`), so a
 * resolved promise here means access was granted — `email.sent === false` is a
 * report, not an error.
 */
export function useSetWhitelistAccess() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const mutate = useCallback(
    async (
      userId: string,
      whitelisted: boolean,
    ): Promise<{ user: WhitelistUser; email: EmailOutcome | null }> => {
      setIsLoading(true);
      setError("");
      try {
        const res = await fetch(`/api/admin/whitelist/${userId}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders(),
          },
          credentials: "include",
          body: JSON.stringify({ whitelisted }),
        });
        const data = await jsonOrError(res, "Failed to update access");
        return {
          user: data.user as WhitelistUser,
          email: (data.email ?? null) as EmailOutcome | null,
        };
      } catch (err: any) {
        setError(err?.message || "Failed to update access");
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  return { mutate, isLoading, error };
}
