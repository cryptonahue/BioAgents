/**
 * Footer — displays the running server version (semver + short SHA + build
 * date), fetched from /api/version via the shared `useVersion` hook.
 *
 * The server value is authoritative: it reflects what's actually deployed
 * and running. Build-time values are only a fallback for when the server is
 * unreachable (the client bundle can't always bake the git SHA — e.g. the
 * commit isn't available at build time on some deploy hosts).
 */

import { useVersion, shortSha, formatDate } from '../hooks/useVersion';

export function Footer() {
  const { version, sha, buildDate } = useVersion();

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
