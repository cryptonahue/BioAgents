import { route } from "preact-router";
import { useEffect, useState } from "preact/hooks";
import { useAuth } from "../hooks";
import { Icon } from "../components/icons";
import { BUTTON_ICON_CLASS } from "../components/ui/Button";

interface SettingsPageProps {
  path?: string;
  coralGptMode?: boolean;
  privyLogout?: () => Promise<void> | void;
}

interface SelectableModel {
  id: string;
  label: string;
}

/** Mirrors the token lookup used by the client data hooks (see useLibrary.ts). */
function getAuthToken(): string | null {
  return localStorage.getItem("bioagents_auth_token");
}

/**
 * Minimal account settings page. Shows the signed-in email and a Log out
 * action, mirroring the logout flow used by the sidebar user menu. Rendered
 * inside the shared AppLayout, so it fits the content area like the Library.
 *
 * The "Model" section picks the GLOBAL deep-research model (not per-user). The
 * write is admin-gated on the server, so a non-admin will see a 403 when
 * changing it.
 */
export function SettingsPage({ coralGptMode = false, privyLogout }: SettingsPageProps) {
  const { userEmail, logout, isLoggingOut } = useAuth();

  const [models, setModels] = useState<SelectableModel[]>([]);
  const [current, setCurrent] = useState<string>("");
  const [modelLoading, setModelLoading] = useState(true);
  const [modelError, setModelError] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = getAuthToken();
        const res = await fetch("/api/settings/deep-research-model", {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          credentials: "include",
        });
        if (!res.ok) throw new Error(`Failed to load model setting (${res.status})`);
        const data = await res.json();
        if (cancelled) return;
        setModels(Array.isArray(data.models) ? data.models : []);
        setCurrent(typeof data.current === "string" ? data.current : "");
      } catch (err: any) {
        if (!cancelled) setModelError(err?.message || "Failed to load model setting");
      } finally {
        if (!cancelled) setModelLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleModelChange = async (nextModel: string) => {
    const prev = current;
    setCurrent(nextModel);
    setSaving(true);
    setModelError("");
    setSavedAt(null);
    try {
      const token = getAuthToken();
      const res = await fetch("/api/settings/deep-research-model", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ model: nextModel }),
      });
      if (!res.ok) throw new Error(`Failed to save model (${res.status})`);
      const data = await res.json();
      setCurrent(typeof data.current === "string" ? data.current : nextModel);
      setSavedAt(Date.now());
    } catch (err: any) {
      setCurrent(prev); // roll back the optimistic selection
      setModelError(err?.message || "Failed to save model");
    } finally {
      setSaving(false);
    }
  };

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
          <h2 className="settings-section-title">Model</h2>
          <div className="settings-row">
            <span className="settings-row-label">Deep-research model</span>
            <select
              className="settings-select"
              value={current}
              disabled={modelLoading || saving || models.length === 0}
              onChange={(e) =>
                handleModelChange((e.target as HTMLSelectElement).value)
              }
            >
              {modelLoading && <option value="">Loading…</option>}
              {!modelLoading &&
                models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
            </select>
          </div>
          {saving && <p className="settings-hint">Saving…</p>}
          {!saving && savedAt !== null && (
            <p className="settings-hint">Saved</p>
          )}
          {modelError && (
            <p className="settings-hint settings-hint-error">{modelError}</p>
          )}
        </section>

        <section className="settings-section">
          <h2 className="settings-section-title">Account</h2>
          <div className="settings-row">
            <span className="settings-row-label">Signed in as</span>
            <span className="settings-row-value">{userEmail || "—"}</span>
          </div>
          <button
            type="button"
            className="btn settings-logout-btn"
            data-variant="destructive"
            data-size="lg"
            onClick={handleLogout}
            disabled={isLoggingOut}
          >
            <Icon name="logout" size={16} className={BUTTON_ICON_CLASS} />
            <span>{isLoggingOut ? "Logging out…" : "Log out"}</span>
          </button>
        </section>
      </div>
    </div>
  );
}
