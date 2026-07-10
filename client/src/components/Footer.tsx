/**
 * Footer — displays the running server version (semver + short SHA + build
 * date), fetched from /api/version.
 *
 * The server value is authoritative: it reflects what's actually deployed
 * and running. Build-time values are only a fallback for when the server is
 * unreachable (the client bundle can't always bake the git SHA — e.g. the
 * commit isn't available at build time on some deploy hosts).
 */

import { useEffect, useState } from 'preact/hooks';

type VersionInfo = {
  version: string;
  sha: string;
  buildDate: string;
};

const BUILD_VERSION = process.env.APP_VERSION || '0.0.0';
const BUILD_SHA = process.env.GIT_SHA || 'unknown';
const BUILD_DATE = process.env.BUILD_DATE || 'unknown';

function shortSha(sha: string): string {
  if (!sha || sha === 'unknown') return 'unknown';
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function formatDate(iso: string): string {
  if (!iso || iso === 'unknown') return 'unknown';
  try {
    return iso.slice(0, 10); // YYYY-MM-DD
  } catch {
    return iso;
  }
}

export function Footer() {
  const [serverVersion, setServerVersion] = useState<VersionInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/version')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setServerVersion(data);
      })
      .catch(() => {
        // Server unreachable — fall back to build values silently
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Prefer the server-reported version (reflects what's actually running)
  const version = serverVersion?.version || BUILD_VERSION;
  const sha = serverVersion?.sha || BUILD_SHA;
  const buildDate = serverVersion?.buildDate || BUILD_DATE;

  return (
    <footer
      style={{
        padding: '8px 16px',
        fontSize: '11px',
        color: 'var(--color-text-muted, #6b7280)',
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
        borderTop: '1px solid var(--color-border, #e5e7eb)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '12px',
        background: 'var(--color-bg-footer, transparent)',
      }}
      title={`Build ${version} (${shortSha(sha)}) at ${formatDate(buildDate)}`}
    >
      <span>
        BioAgents <strong>v{version}</strong>
        <span style={{ opacity: 0.6 }}> · {shortSha(sha)}</span>
        <span style={{ opacity: 0.6 }}> · {formatDate(buildDate)}</span>
      </span>
    </footer>
  );
}
