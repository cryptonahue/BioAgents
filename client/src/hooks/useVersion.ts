/**
 * useVersion — shared build/version metadata for the Footer and the
 * in-app version tag.
 *
 * Prefers the server-reported version (GET /api/version — reflects what's
 * actually deployed), falling back to build-time bundled values when the
 * server is unreachable. See src/version.ts on the backend.
 */
import { useEffect, useState } from 'preact/hooks';

export type VersionInfo = {
  version: string;
  sha: string;
  buildDate: string;
};

const BUILD_VERSION = process.env.APP_VERSION || '0.0.0';
const BUILD_SHA = process.env.GIT_SHA || 'unknown';
const BUILD_DATE = process.env.BUILD_DATE || 'unknown';

export function shortSha(sha: string): string {
  if (!sha || sha === 'unknown') return 'unknown';
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

export function formatDate(iso: string): string {
  if (!iso || iso === 'unknown') return 'unknown';
  try {
    return iso.slice(0, 10); // YYYY-MM-DD
  } catch {
    return iso;
  }
}

export function useVersion(): VersionInfo {
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

  return {
    version: serverVersion?.version || BUILD_VERSION,
    sha: serverVersion?.sha || BUILD_SHA,
    buildDate: serverVersion?.buildDate || BUILD_DATE,
  };
}
