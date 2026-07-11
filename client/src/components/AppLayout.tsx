import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { route } from "preact-router";

import { Sidebar } from "./Sidebar";
import { useAuth, useEmbeddedWallet, useSessions, useX402Payment } from "../hooks";
import { generateConversationId, walletAddressToUUID } from "../utils/helpers";

interface AppLayoutProps {
  children?: ComponentChildren;
  coralGptMode?: boolean;
  privyLogout?: () => Promise<void>;
}

/**
 * Fallback user ID for when auth is not required.
 * Persists across sessions via localStorage (same key as ChatPage/useSessions).
 */
function getFallbackUserId(): string {
  const stored = localStorage.getItem("dev_user_id");
  if (stored) return stored;
  const newId = generateConversationId();
  localStorage.setItem("dev_user_id", newId);
  return newId;
}

/**
 * Shared authenticated app layout: renders the chat Sidebar alongside the
 * routed page so non-chat pages (Library, Brain, Corpus, Admin, Paper) get
 * the same navigation shell as ChatPage.
 *
 * ChatPage intentionally does NOT use this layout — it owns its own Sidebar
 * plus in-page session state. This layout is for the sibling pages: it feeds
 * the Sidebar from useSessions (read-only session list + delete) and routes
 * session actions back into the chat page.
 */
export function AppLayout({ children, coralGptMode = false, privyLogout }: AppLayoutProps) {
  // Auth context - provides userId from JWT / Privy
  const { userId: authUserId } = useAuth();

  // x402 payment state (only active when enabled)
  const x402 = useX402Payment();
  const { enabled: x402Enabled, config: x402ConfigData } = x402;

  // Embedded wallet (only relevant under x402)
  const { evmAddress: embeddedWalletAddress } = useEmbeddedWallet(
    x402ConfigData?.network,
    x402Enabled,
  );

  // Same userId derivation as ChatPage:
  // Priority: x402 payment > JWT/Privy auth userId > localStorage fallback
  const actualUserId = x402Enabled
    ? embeddedWalletAddress
      ? walletAddressToUUID(embeddedWalletAddress)
      : null
    : authUserId || getFallbackUserId();

  // Session list for the Sidebar. wsConnected is false here — these pages only
  // need the session list, not the realtime chat channel (owned by ChatPage).
  const { sessions, deleteSession } = useSessions(
    actualUserId || undefined,
    x402Enabled,
    false,
  );

  // Mobile sidebar state (mirrors ChatPage)
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Session actions route into the chat page (no in-page session state here)
  const handleSessionSelect = (id: string) => {
    setIsMobileSidebarOpen(false);
    route(`/chat/${id}`);
  };

  const handleNewSession = () => {
    setIsMobileSidebarOpen(false);
    route("/chat");
  };

  return (
    <div className="app-layout">
      {/* Mobile overlay */}
      {isMobileSidebarOpen && (
        <div
          className="sidebar-overlay"
          onClick={() => setIsMobileSidebarOpen(false)}
        />
      )}

      <Sidebar
        sessions={sessions}
        currentSessionId={undefined}
        onSessionSelect={handleSessionSelect}
        onNewSession={handleNewSession}
        onDeleteSession={deleteSession}
        isMobileOpen={isMobileSidebarOpen}
        onMobileClose={() => setIsMobileSidebarOpen(false)}
        coralGptMode={coralGptMode}
        privyLogout={privyLogout}
      />

      <div className="app-content">
        {/* Mobile menu button (fixed; hidden on desktop via CSS) */}
        <button
          className="mobile-menu-btn"
          onClick={() => setIsMobileSidebarOpen(true)}
          aria-label="Open menu"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </button>

        {children}
      </div>
    </div>
  );
}
