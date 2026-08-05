import { useCallback, useEffect, useState } from "preact/hooks";

/**
 * usePrivyUsers — admin-only hook for the Privy users manager.
 *
 * Wraps the admin route in `src/routes/admin/privy-users.ts`:
 *   GET  /api/admin/privy-users
 *
 * Same auth pattern as `useWhitelistUsers`: the JWT goes out in the
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

export interface PrivyUserEntry {
  id: string;
  email: string | null;
  walletAddress: string | null;
  createdAt: string;
  isGuest: boolean;
  localUserId: string | null;
  whitelisted: boolean;
  hasAccount: boolean;
}

export interface PrivyUsersResponse {
  users: PrivyUserEntry[];
  total: number;
  page: number;
  limit: number;
}

export interface UsePrivyUsersParams {
  search?: string;
  page?: number;
  limit?: number;
}

export function usePrivyUsers(params: UsePrivyUsersParams) {
  const { search = "", page = 0, limit = 50 } = params;
  const [data, setData] = useState<PrivyUsersResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchUsers = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (search) qs.set("search", search);

      const res = await fetch(`/api/admin/privy-users?${qs}`, {
        headers: getAuthHeaders(),
        credentials: "include",
      });
      setData(await jsonOrError(res, "Failed to load Privy users"));
    } catch (err: any) {
      setError(err?.message || "Failed to load Privy users");
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [search, page, limit]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  return { data, isLoading, error, refetch: fetchUsers };
}
