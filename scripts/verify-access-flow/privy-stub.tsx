/**
 * A stub for `@privy-io/react-auth`, aliased in at bundle time by
 * `harness.ts`. Nothing here ships — it exists so the REAL LandingPage and the
 * REAL AccessPendingPage can be driven in a browser without a live Privy app.
 *
 * Privy is a hosted, credentialed identity provider: `login()` opens THEIR modal
 * against a real app id and returns a token signed by THEIR keys. There is no
 * honest way to fake that at the network layer, so it is faked at the MODULE
 * layer, which is the seam the app actually depends on. Everything below the
 * seam — routing, the auth exchange, the form, the CSS — is the real thing.
 *
 * `window.__privy` drives it from the test.
 */

import { createContext } from 'preact';
import { useContext, useState, useEffect } from 'preact/hooks';

interface PrivyState {
  ready: boolean;
  authenticated: boolean;
  user: any;
}

declare global {
  interface Window {
    __privy: {
      state: PrivyState;
      /** Set by the harness to simulate a completed Privy login. */
      login: () => void;
      accessToken: string | null;
      loginCalls: number;
    };
  }
}

/**
 * The session SURVIVES A RELOAD, because the real Privy's does — it keeps its
 * session in storage and rehydrates on mount. Without this the stub would log
 * the user out on every refresh and the "reload /access-pending still shows the
 * right screen" check would fail for a reason that exists only in the harness.
 */
const KEY = 'harness.privy.authenticated';

if (typeof window !== 'undefined' && !window.__privy) {
  const restored = sessionStorage.getItem(KEY) === '1';
  window.__privy = {
    state: {
      ready: true,
      authenticated: restored,
      user: restored ? { email: { address: 'ada@lab.org' } } : null,
    },
    login: () => {},
    accessToken: 'stub-privy-access-token',
    loginCalls: 0,
  };
}

const Ctx = createContext<{ bump: () => void } | null>(null);

export function PrivyProvider({ children }: any) {
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);

  useEffect(() => {
    // The harness calls `window.__privy.login()` to flip authenticated -> true;
    // this re-renders the tree, exactly as Privy's own state change would.
    window.__privy.login = () => {
      window.__privy.loginCalls += 1;
      sessionStorage.setItem(KEY, '1');
      window.__privy.state = {
        ready: true,
        authenticated: true,
        user: { email: { address: 'ada@lab.org' } },
      };
      bump();
    };
  }, []);

  return <Ctx.Provider value={{ bump }}>{children}</Ctx.Provider>;
}

export function usePrivy() {
  useContext(Ctx);
  const s = window.__privy.state;
  return {
    ready: s.ready,
    authenticated: s.authenticated,
    user: s.user,
    login: () => {
      // Real Privy pops a modal. The harness decides when it "completes".
      window.__privy.loginCalls += 1;
      window.dispatchEvent(new CustomEvent('privy:login-requested'));
    },
    logout: async () => {
      sessionStorage.removeItem(KEY);
      window.__privy.state = { ready: true, authenticated: false, user: null };
    },
    getAccessToken: async () => window.__privy.accessToken,
  };
}

export function useWallets() {
  return { wallets: [] };
}

export function useLogin() {
  return { login: () => {} };
}
