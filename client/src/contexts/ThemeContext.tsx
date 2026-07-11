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
 * Default is `dark`. The app was dark-only before this provider existed, so an
 * unset preference must keep looking exactly the same.
 *
 * An inline script in `public/index.html` applies the stored preference before
 * first paint. This provider re-applies it on mount (idempotent) and owns every
 * change from then on. The storage key MUST stay in sync with that script.
 */
import { useCallback, useContext, useEffect, useMemo, useState } from "preact/hooks";
import { createContext } from "preact";
import type { ComponentChildren } from "preact";

export type Theme = "light" | "dark";

const STORAGE_KEY = "bioagents.theme";
const DEFAULT_THEME: Theme = "dark";

interface ThemeContextValue {
  theme: Theme;
  isDark: boolean;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage can throw in private mode or a sandboxed iframe.
  }
  return DEFAULT_THEME;
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

interface ThemeProviderProps {
  children: ComponentChildren;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Preference is not persisted; the in-memory theme still works.
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => (current === "dark" ? "light" : "dark"));
  }, []);

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
    // still resolves. Reads report the default theme; writes do nothing.
    return {
      theme: DEFAULT_THEME,
      isDark: DEFAULT_THEME === "dark",
      setTheme: () => undefined,
      toggleTheme: () => undefined,
    };
  }
  return ctx;
}
