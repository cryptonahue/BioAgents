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

export interface WhitelistUser {
  id: string;
  email: string | null;
  username: string | null;
  externalId: string | null;
  accessType: string | null;
  whitelisted: boolean;
  isAdmin: boolean;
  createdAt: string | null;
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
 * Grant / revoke. Resolves to the updated row so the caller can patch it into
 * the list without a full refetch.
 */
export function useSetWhitelistAccess() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const mutate = useCallback(
    async (userId: string, whitelisted: boolean): Promise<WhitelistUser> => {
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
        return data.user as WhitelistUser;
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
