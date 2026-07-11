import { route } from "preact-router";
import { useAuth } from "../hooks";
import { Icon } from "../components/icons";

interface SettingsPageProps {
  path?: string;
  coralGptMode?: boolean;
  privyLogout?: () => Promise<void> | void;
}

/**
 * Minimal account settings page. Shows the signed-in email and a Log out
 * action, mirroring the logout flow used by the sidebar user menu. Rendered
 * inside the shared AppLayout, so it fits the content area like the Library.
 */
export function SettingsPage({ coralGptMode = false, privyLogout }: SettingsPageProps) {
  const { userEmail, logout, isLoggingOut } = useAuth();

  const handleLogout = async () => {
    if (coralGptMode && privyLogout) {
      await privyLogout();
    }
    await logout();
    route(coralGptMode ? "/" : "/login", true);
  };

  return (
    <div className="settings-page">
      <div className="settings-main">
        <div className="settings-heading">
          <h1>Settings</h1>
          <p>Manage your account. More settings are coming soon.</p>
        </div>

        <section className="settings-section">
          <h2 className="settings-section-title">Account</h2>
          <div className="settings-row">
            <span className="settings-row-label">Signed in as</span>
            <span className="settings-row-value">{userEmail || "—"}</span>
          </div>
          <button
            type="button"
            className="settings-logout-btn"
            onClick={handleLogout}
            disabled={isLoggingOut}
          >
            <Icon name="logout" size={16} />
            <span>{isLoggingOut ? "Logging out…" : "Log out"}</span>
          </button>
        </section>
      </div>
    </div>
  );
}
