#!/usr/bin/env bash
#
# build-and-up.sh — rebuild a service and (re)create its container with
# accurate GIT_SHA / BUILD_DATE metadata baked into the image, so the client
# Footer and /api/version stop showing "unknown".
#
# Usage:
#   bin/build-and-up.sh [service]   # default: bioagents
#
# Examples:
#   bin/build-and-up.sh             # rebuild bioagents
#   bin/build-and-up.sh worker      # rebuild worker
#   bin/build-and-up.sh caddy       # rebuild caddy (no metadata needed)
#
# Notes:
#   * The Dockerfile accepts GIT_SHA / BUILD_DATE as build-args and exports
#     them as ENV. Passing them here makes them visible to src/version.ts at
#     runtime. If unset, the version module falls back to "unknown".
#   * This wraps `docker compose build` so the metadata is captured at
#     image-build time, not at container-start time.

set -euo pipefail

SERVICE="${1:-bioagents}"

# Resolve git metadata from the build context. The .git directory must be
# present (not stripped by .dockerignore) for these lookups to work; if not,
# we fall back to "unknown" / the current UTC timestamp.
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_DATE="$(git log -1 --format=%cI 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"

# Pull the semver from package.json so the client Footer and the server
# /api/version endpoint stay in lock-step (no "version mismatch" warning).
APP_VERSION="$(node -p "require('./package.json').version" 2>/dev/null \
  || grep -m1 '"version"' package.json | sed -E 's/.*"version": *"([^"]+)".*/\1/')"

export GIT_SHA
export BUILD_DATE
export APP_VERSION

echo "==> Building client bundle with APP_VERSION=${APP_VERSION} GIT_SHA=${GIT_SHA} BUILD_DATE=${BUILD_DATE}"
bun run build:client

echo "==> Building ${SERVICE} image with the same metadata as build-args"
# SKIP_CLIENT_BUILD=1 tells the Dockerfile to reuse the client/dist/ we just
# produced locally (with real .git/ available) instead of re-bundling inside
# the container where .git/ is stripped by .dockerignore.
# Any extra args are passed to `up -d`, e.g.:
#   bin/build-and-up.sh bioagents --force-recreate
shift || true
SKIP_CLIENT_BUILD=1 docker compose build "${SERVICE}"
docker compose up -d "${SERVICE}" "$@"
