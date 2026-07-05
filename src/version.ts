/**
 * Version metadata for runtime introspection.
 *
 * Reads semver from package.json + git SHA from env (set at build time
 * by Docker or by the dev runner). Exposed via the GET /api/version route
 * and used by the client Footer component.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export type VersionInfo = {
  version: string;
  sha: string;
  buildDate: string;
};

let cached: VersionInfo | null = null;

function readPackageVersion(): string {
  try {
    // Walk up from cwd to find package.json (handles both src/ and project root)
    let dir = process.cwd();
    for (let i = 0; i < 5; i++) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
        return pkg.version || '0.0.0';
      }
      dir = join(dir, '..');
    }
  } catch {
    // fall through
  }
  return '0.0.0';
}

function readGitSha(): string {
  // Prefer env var (set at build time) over runtime git lookup
  if (process.env.GIT_SHA) return process.env.GIT_SHA;
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function readBuildDate(): string {
  if (process.env.BUILD_DATE) return process.env.BUILD_DATE;
  return new Date().toISOString();
}

export function getVersion(): VersionInfo {
  if (cached) return cached;
  cached = {
    version: readPackageVersion(),
    sha: readGitSha(),
    buildDate: readBuildDate(),
  };
  return cached;
}
