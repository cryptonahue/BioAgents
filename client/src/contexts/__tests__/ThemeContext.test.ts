/**
 * Unit tests for the theme RESOLUTION ORDER (`contexts/ThemeContext.tsx`).
 *
 * The theme is no longer "dark unless a key says otherwise": it is a two-state
 * machine — UNSET follows the OS live, EXPLICIT wins over the OS forever — and
 * the order it resolves in (stored -> OS -> dark) is duplicated in the inline
 * bootstrap script in `public/index.html`. Both halves of that are asserted here.
 *
 * The provider itself is a hook component, and this project's DOM shim cannot
 * drive Preact's hook internals (see `test-dom-shim.ts` and the header of
 * `ui/Menu.tsx`), so the resolution is exported as PURE FUNCTIONS and tested
 * directly. `resolveTheme()` is the exact function `ThemeProvider`'s
 * `useState` initialiser calls, so this is the real thing, not a re-statement.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { readStoredTheme, resolveTheme, systemTheme } from "../ThemeContext";

const STORAGE_KEY = "bioagents.theme";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

type Listener = (event: { matches: boolean }) => void;

/** A `matchMedia` that reports the OS preference we tell it to. */
function fakeMatchMedia(prefersLight: boolean) {
  const listeners: Listener[] = [];
  const query = {
    media: LIGHT_QUERY,
    matches: prefersLight,
    addEventListener: (_type: string, fn: Listener) => {
      listeners.push(fn);
    },
    removeEventListener: (_type: string, fn: Listener) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const matchMedia = (media: string) => {
    if (media !== LIGHT_QUERY) throw new Error(`unexpected query: ${media}`);
    return query;
  };
  return { matchMedia, query, listeners };
}

function installMatchMedia(prefersLight: boolean) {
  const fake = fakeMatchMedia(prefersLight);
  (globalThis as any).matchMedia = fake.matchMedia;
  return fake;
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  delete (globalThis as any).matchMedia;
});

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  delete (globalThis as any).matchMedia;
});

describe("readStoredTheme — a preference exists only if the user made one", () => {
  it("returns null when nothing is stored", () => {
    // Not "dark". The absence of a choice has to be distinguishable from the
    // choice of dark, or the OS can never be consulted.
    expect(readStoredTheme()).toBeNull();
  });

  it("returns the stored value when it is a theme", () => {
    localStorage.setItem(STORAGE_KEY, "light");
    expect(readStoredTheme()).toBe("light");
    localStorage.setItem(STORAGE_KEY, "dark");
    expect(readStoredTheme()).toBe("dark");
  });

  it("treats a garbage value as no preference", () => {
    localStorage.setItem(STORAGE_KEY, "solarized");
    expect(readStoredTheme()).toBeNull();
  });
});

describe("systemTheme — anything that is not explicitly light is dark", () => {
  it("is light when the OS asks for light", () => {
    installMatchMedia(true);
    expect(systemTheme()).toBe("light");
  });

  it("is dark when the OS asks for dark", () => {
    installMatchMedia(false);
    expect(systemTheme()).toBe("dark");
  });

  it("is dark when the browser has no matchMedia at all", () => {
    // `no-preference` lands here too: the light query simply does not match.
    expect((globalThis as any).matchMedia).toBeUndefined();
    expect(systemTheme()).toBe("dark");
  });
});

describe("resolveTheme — stored, then the OS, then dark", () => {
  it("follows the OS when nothing is stored (light)", () => {
    installMatchMedia(true);
    expect(resolveTheme()).toEqual({ theme: "light", explicit: false });
  });

  it("follows the OS when nothing is stored (dark)", () => {
    installMatchMedia(false);
    expect(resolveTheme()).toEqual({ theme: "dark", explicit: false });
  });

  it("falls back to dark when the OS cannot be asked", () => {
    expect(resolveTheme()).toEqual({ theme: "dark", explicit: false });
  });

  it("lets a stored LIGHT beat a dark OS, and marks it explicit", () => {
    installMatchMedia(false);
    localStorage.setItem(STORAGE_KEY, "light");
    expect(resolveTheme()).toEqual({ theme: "light", explicit: true });
  });

  it("lets a stored DARK beat a light OS, and marks it explicit", () => {
    installMatchMedia(true);
    localStorage.setItem(STORAGE_KEY, "dark");
    // The `explicit` flag is what tears the OS listener down in the provider.
    // Without it, a stored dark would keep getting overwritten by a light OS.
    expect(resolveTheme()).toEqual({ theme: "dark", explicit: true });
  });
});
