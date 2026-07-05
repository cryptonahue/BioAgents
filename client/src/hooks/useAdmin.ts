import { useMemo } from "preact/hooks";
import { useAuth } from "./useAuth";

/**
 * `useAdmin` — role check hook for the Bioprospecting Review UI.
 *
 * Decodes the JWT stored in localStorage and returns whether the
 * user is an admin. The hook is a thin client-side mirror of the
 * server-side `authResolver({ required: true, role: "admin" })`
 * gate; the server is the authoritative source.
 *
 * Use it to gate UI surfaces (sidebar nav, page mount) but never to
 * gate data access — every admin API call must still be authorized
 * by the server.
 *
 * The hook decodes the JWT once per render and memoizes the
 * computed value off the raw token string, so multiple
 * `useAdmin().isAdmin` reads in the same render tree share a
 * single `atob` call.
 */
export function useAdmin(): { isAdmin: boolean; userId: string | null } {
  const { token, userId } = useAuth();
  return useMemo(() => {
    if (!token) return { isAdmin: false, userId: null };
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return { isAdmin: false, userId: null };
      const payload = JSON.parse(atob(parts[1])) as {
        role?: string;
        sub?: string;
      };
      return {
        isAdmin: payload.role === "admin",
        userId: payload.sub ?? userId ?? null,
      };
    } catch {
      return { isAdmin: false, userId: null };
    }
  }, [token, userId]);
}
