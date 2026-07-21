/**
 * ThemeContext — owns the light/dark theme for the whole client.
 *
 * The theme is expressed as a single `dark` class on `<html>`. That is what
 * both layers of the design system read:
 *   - Basecoat components, whose dark variant is compiled as
 *     `@custom-variant dark (&:is(html.dark *))`.
 *   - The legacy token bridge in `styles/theme.css`, whose `.dark` block
 *     redefines every `--bg-*` / `--text-*` token the hand-written CSS uses.
 *
 * THE RESOLUTION ORDER, AND WHY IT IS A STATE MACHINE
 *
 * There are two distinct states, and they behave differently:
 *
 *   UNSET    — the user has never chosen a theme. `localStorage` holds nothing
 *              valid. The theme FOLLOWS THE OS: `prefers-color-scheme: light`
 *              renders light, anything else (dark, no-preference, or a browser
 *              with no `matchMedia` at all) renders dark. The OS is followed
 *              LIVE — flipping the system appearance flips the app with it,
 *              because nothing the user said is being contradicted.
 *   EXPLICIT — the user pressed the toggle (or something called `setTheme`).
 *              The choice is written to `localStorage` AT THAT MOMENT, it wins
 *              over the OS from then on, and the OS listener is torn down: a
 *              later system change must NOT move a theme the user picked.
 *
 * So: stored -> OS -> dark. Dark is the last resort, not the default: the app
 * was dark-only before light mode existed, and a browser that cannot report a
 * preference should still look the way it always did.
 *
 * NOTHING IS PERSISTED UNTIL THE USER CHOOSES. An earlier version wrote the
 * resolved theme to `localStorage` from a mount effect, which recorded an
 * explicit preference the user never expressed — pinning every first-time
 * visitor to whatever the default happened to be on the day they arrived, and
 * making them indistinguishable from a user who really did pick it. The write
 * now lives in `setTheme` / `toggleTheme` and nowhere else. Applying the class
 * to `<html>` is still an effect; only the storage write moved.
 *
 * An inline script in `public/index.html` applies the SAME resolution order
 * before first paint, so a light-OS visitor never sees a dark flash. The storage
 * key AND the resolution order must stay in sync with that script.
 */
import { useCallback, useContext, useEffect, useMemo, useState } from "preact/hooks";
import { createContext } from "preact";
import type { ComponentChildren } from "preact";

export type Theme = "light" | "dark";

const STORAGE_KEY = "bioagents.theme";

/**
 * Light mode is temporarily disabled — the app is dark-only for now.
 *
 * While this is `false`: `resolveTheme()` ignores the stored preference and the
 * OS, and forces dark; the `<ThemeToggle />` renders are also commented out at
 * their call sites, and the pre-paint script in `public/index.html` is disabled
 * so `<html class="dark">` stays put.
 *
 * TO BRING LIGHT MODE BACK: flip this to `true`, un-comment the `<ThemeToggle />`
 * renders (Sidebar.jsx, LandingPage.tsx, AccessPendingPage.tsx), and re-enable
 * the bootstrap script in `public/index.html`.
 */
const LIGHT_MODE_ENABLED = false;

/** The theme a browser that can tell us nothing gets. */
const FALLBACK_THEME: Theme = "dark";

/**
 * Asking for LIGHT, not dark, is deliberate: `prefers-color-scheme: dark` and
 * `prefers-color-scheme: no-preference` must both land on dark, and querying the
 * light side makes that one boolean instead of two.
 */
const LIGHT_QUERY = "(prefers-color-scheme: light)";

interface ThemeContextValue {
  theme: Theme;
  isDark: boolean;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** The user's stored choice, or `null` if they have never made one. */
export function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage can throw in private mode or a sandboxed iframe.
  }
  return null;
}

/** The live `(prefers-color-scheme: light)` query, or `null` where there is none. */
function lightQuery(): MediaQueryList | null {
  const mm = (globalThis as { matchMedia?: (q: string) => MediaQueryList }).matchMedia;
  if (typeof mm !== "function") return null;
  try {
    return mm.call(globalThis, LIGHT_QUERY);
  } catch {
    return null;
  }
}

/** What the OS is asking for. Anything that is not explicitly light is dark. */
export function systemTheme(): Theme {
  return lightQuery()?.matches ? "light" : FALLBACK_THEME;
}

export interface ResolvedTheme {
  theme: Theme;
  /** True once the user has made a choice — the OS stops being consulted. */
  explicit: boolean;
}

/** The whole resolution order in one place: stored -> OS -> dark. */
export function resolveTheme(): ResolvedTheme {
  // Light mode disabled: force dark, and mark it explicit so the OS listener is
  // never wired up. Remove this guard to restore stored -> OS -> dark.
  if (!LIGHT_MODE_ENABLED) return { theme: "dark", explicit: true };
  const stored = readStoredTheme();
  if (stored) return { theme: stored, explicit: true };
  return { theme: systemTheme(), explicit: false };
}

function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Preference is not persisted; the in-memory theme still works.
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

interface ThemeProviderProps {
  children: ComponentChildren;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [resolved, setResolved] = useState<ResolvedTheme>(resolveTheme);
  const { theme, explicit } = resolved;

  // The class on <html>. Idempotent — the inline bootstrap script already put
  // the same class there before first paint.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Follow the OS, but ONLY while the user has not chosen. The moment `explicit`
  // flips to true this effect re-runs, its cleanup removes the listener, and it
  // subscribes to nothing — a later system change cannot move an explicit theme.
  useEffect(() => {
    if (explicit) return;
    const query = lightQuery();
    if (!query) return;

    const onChange = (event: MediaQueryListEvent) => {
      setResolved((current) =>
        current.explicit
          ? current
          : { theme: event.matches ? "light" : FALLBACK_THEME, explicit: false },
      );
    };

    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [explicit]);

  // The ONLY place a preference is written. An explicit choice, and nothing else.
  const setTheme = useCallback((next: Theme) => {
    persistTheme(next);
    setResolved({ theme: next, explicit: true });
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      isDark: theme === "dark",
      setTheme,
      toggleTheme,
    }),
    [theme, setTheme, toggleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useThemeContext(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Mirror ProvenanceContext: return a usable no-op shape rather than
    // throwing, so a component rendered outside the provider (e.g. in a test)
    // still resolves. Reads report the fallback theme; writes do nothing.
    return {
      theme: FALLBACK_THEME,
      isDark: FALLBACK_THEME === "dark",
      setTheme: () => undefined,
      toggleTheme: () => undefined,
    };
  }
  return ctx;
}
