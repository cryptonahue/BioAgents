import { PrivyProvider } from '@privy-io/react-auth';
import type { ComponentChildren } from 'preact';
import { useTheme } from '../hooks/useTheme';

interface CoralPrivyProviderProps {
  appId: string;
  children: ComponentChildren;
}

/**
 * Privy's auth modal is themed by Privy, not by our stylesheet — it renders its
 * own UI from `config.appearance`. This used to hardcode `theme: 'dark'`, so the
 * login modal stayed dark even with the app in light mode.
 *
 * API (verified against the installed `@privy-io/react-auth@3.26.1` types,
 * `PrivyClientConfig.appearance` in `dist/dts/types-j5ABA33q.d.ts`):
 *
 *     theme?: 'light' | 'dark' | HexColor
 *
 * so the two values we need are exactly the two our `useTheme()` returns.
 *
 * IT DOES LIVE-UPDATE, and that is load-bearing enough to be worth showing.
 * Tracing the installed bundle: `PrivyProvider` destructures
 * `({ config, ...props })` and re-spreads it (`Object.assign({}, config)`) into
 * its own provider's `clientConfig` prop on EVERY render. That provider builds
 * the modal palette inside a `useMemo` whose dependency list contains
 * `clientConfig` — and because the spread produces a fresh object identity each
 * render, the memo re-runs and the palette is recomputed. So a re-render of THIS
 * component is sufficient to re-theme Privy's modal; no remount, and no `key`
 * hack (which would tear down auth state).
 *
 * This component subscribes to `useTheme()`, so a toggle re-renders it and the
 * modal follows. Confirmed by reading the bundle, not assumed from the docs.
 *
 * `accentColor` stays a literal hex: it is the CoralGPT brand coral, it is not
 * part of our CSS token system, and Privy's API takes a HexColor here — it
 * cannot resolve `var()`.
 */
function usePrivyConfig() {
  const { isDark } = useTheme();

  return {
    loginMethods: ['email', 'wallet', 'google'] as const,
    appearance: {
      theme: (isDark ? 'dark' : 'light') as 'dark' | 'light',
      accentColor: '#FF6B6B' as const,
      logo: '/images/token.png',
    },
    embeddedWallets: {
      ethereum: { createOnLogin: 'off' as const },
      solana: { createOnLogin: 'off' as const },
      showWalletUIs: false,
    },
  };
}

export function CoralPrivyProvider({ appId, children }: CoralPrivyProviderProps) {
  const config = usePrivyConfig();

  return (
    <PrivyProvider appId={appId} config={config}>
      {children}
    </PrivyProvider>
  );
}
