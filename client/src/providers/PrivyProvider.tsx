import { PrivyProvider } from '@privy-io/react-auth';
import type { ComponentChildren } from 'preact';

interface CoralPrivyProviderProps {
  appId: string;
  children: ComponentChildren;
}

function getPrivyConfig() {
  return {
    loginMethods: ['email', 'wallet', 'google'] as const,
    appearance: {
      theme: 'dark' as const,
      accentColor: '#FF6B6B',
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
  return (
    <PrivyProvider appId={appId} config={getPrivyConfig()}>
      {children}
    </PrivyProvider>
  );
}
