#!/usr/bin/env bash
# scripts/release.sh
#
# Bump the BioAgents version, update CHANGELOG.md, commit, tag, and rebuild
# the docker images with the new GIT_SHA + BUILD_DATE injected into
# /api/version and the frontend Footer.
#
# Usage:
#   ./scripts/release.sh <new-version> [--no-push] [--no-rebuild]
#   ./scripts/release.sh patch                # auto-bump 0.2.0 → 0.2.1
#   ./scripts/release.sh minor                # auto-bump 0.2.0 → 0.3.0
#   ./scripts/release.sh major                # auto-bump 0.2.0 → 1.0.0
#   ./scripts/release.sh                      # interactive: asks level
#
# Workflow:
#   1. Sanity check: clean working tree, on main/dev branch.
#   2. Bump package.json (manual or auto from current).
#   3. Move the [Unreleased] section of CHANGELOG.md to a dated
#      [X.Y.Z] - YYYY-MM-DD section.
#   4. git add package.json CHANGELOG.md
#   5. git commit -m "chore(release): vX.Y.Z"
#   6. git tag vX.Y.Z
#   7. docker compose down + build --build-arg GIT_SHA=<sha>
#                        --build-arg BUILD_DATE=$(date -u +%FT%TZ)
#      for both api and worker.
#   8. docker compose up -d for both services.
#   9. curl /api/version to verify the new version is live.
#
# Env overrides:
#   SKIP_REBUILD=1   skip the docker rebuild step (only useful for CI dry-runs)
#   SKIP_PUSH=1      skip git push (default with --no-push flag)
#   DRY_RUN=1        print commands without executing

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo ".")"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() { printf '\033[1;34m[release]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[release]\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m[release]\033[0m %s\n' "$*" >&2; }
ok() { printf '\033[1;32m[release]\033[0m %s\n' "$*"; }

run() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "  DRY-RUN $*"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# Sanity checks
# ---------------------------------------------------------------------------

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  err "Not a git repository"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  err "Working tree is not clean. Commit or stash first."
  git status --short
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "dev" && "$BRANCH" != "main" && "$BRANCH" != "master" ]]; then
  warn "Releasing from branch '$BRANCH' (expected dev/main/master)."
  if [[ "${DRY_RUN:-0}" != "1" ]]; then
    read -r -p "  Continue? [y/N] " ans
    [[ "$ans" == "y" || "$ans" == "Y" ]] || exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------

BUMP_LEVEL=""
EXPLICIT_VERSION=""
NO_PUSH="0"
NO_REBUILD="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    patch|minor|major) BUMP_LEVEL="$1" ;;
    --no-push) NO_PUSH="1" ;;
    --no-rebuild) NO_REBUILD="1" ;;
    -h|--help)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    v*|[0-9]*)
      EXPLICIT_VERSION="${1#v}"
      ;;
    *)
      err "Unknown arg: $1"
      exit 1
      ;;
  esac
  shift
done

CURRENT_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || \
  grep '"version"' package.json | sed 's/.*"version": *"\([^"]*\)".*/\1/')"

log "Current version: $CURRENT_VERSION"

# ---------------------------------------------------------------------------
# Decide new version
# ---------------------------------------------------------------------------

bump_semver() {
  local current="$1" level="$2"
  IFS='.' read -r major minor patch <<< "$current"
  case "$level" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
    *) err "Unknown bump level: $level"; exit 1 ;;
  esac
}

if [[ -z "$EXPLICIT_VERSION" ]]; then
  if [[ -z "$BUMP_LEVEL" ]]; then
    PS3="Bump level: "
    select lvl in patch minor major; do
      [[ -n "$lvl" ]] && BUMP_LEVEL="$lvl" && break
    done
  fi
  EXPLICIT_VERSION="$(bump_semver "$CURRENT_VERSION" "$BUMP_LEVEL")"
fi

if [[ ! "$EXPLICIT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  err "Invalid version: $EXPLICIT_VERSION (expected semver, e.g. 0.2.1)"
  exit 1
fi

NEW_VERSION="$EXPLICIT_VERSION"
log "New version: $NEW_VERSION"

# ---------------------------------------------------------------------------
# Update package.json
# ---------------------------------------------------------------------------

log "Updating package.json..."
run sed -i.bak "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" package.json
run rm -f package.json.bak

# ---------------------------------------------------------------------------
# Update CHANGELOG.md
# ---------------------------------------------------------------------------

CHANGELOG="CHANGELOG.md"
TODAY="$(date -u +%Y-%m-%d)"

if [[ ! -f "$CHANGELOG" ]]; then
  warn "CHANGELOG.md not found, creating a minimal one"
  run tee "$CHANGELOG" >/dev/null <<EOF
# Changelog

All notable changes to BioAgents will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- TBD

EOF
fi

log "Updating CHANGELOG.md..."

# Insert a new [X.Y.Z] section above [Unreleased] if [Unreleased] is empty,
# otherwise just rename the [Unreleased] heading to the new version.
if grep -q '^## \[Unreleased\]' "$CHANGELOG"; then
  # Extract content under [Unreleased]
  UNRELEASED_CONTENT="$(awk '/^## \[Unreleased\]/{flag=1; next} /^## \[/{flag=0} flag' "$CHANGELOG")"

  if [[ -z "$(echo "$UNRELEASED_CONTENT" | sed '/^$/d' | sed '/^### /d')" ]]; then
    warn "CHANGELOG [Unreleased] section is empty. Add entries first, then re-run."
    exit 1
  fi

  # Replace the [Unreleased] heading with [NEW_VERSION] - DATE and add a
  # fresh empty [Unreleased] block above it.
  run python3 - "$CHANGELOG" "$NEW_VERSION" "$TODAY" <<'PYEOF'
import sys, re, pathlib

path, new_version, today = sys.argv[1], sys.argv[2], sys.argv[3]
text = pathlib.Path(path).read_text()

# Replace [Unreleased] with [X.Y.Z] - YYYY-MM-DD and inject a fresh
# [Unreleased] placeholder above it.
new_block = f"""## [Unreleased]

### Changed
- TBD

## [{new_version}] - {today}

"""
text = re.sub(r"^## \[Unreleased\]\n", new_block, text, count=1, flags=re.MULTILINE)
pathlib.Path(path).write_text(text)
PYEOF
else
  warn "No [Unreleased] section in CHANGELOG.md. Add one or run release.sh --help"
  exit 1
fi

# ---------------------------------------------------------------------------
# Commit + tag
# ---------------------------------------------------------------------------

log "Committing..."
run git add package.json CHANGELOG.md
run git commit -m "chore(release): v$NEW_VERSION"

log "Tagging v$NEW_VERSION..."
run git tag -a "v$NEW_VERSION" -m "v$NEW_VERSION"

if [[ "$NO_PUSH" != "1" ]]; then
  log "Pushing commit + tag..."
  run git push origin HEAD
  run git push origin "v$NEW_VERSION"
fi

# ---------------------------------------------------------------------------
# Rebuild + restart containers with new SHA
# ---------------------------------------------------------------------------

GIT_SHA="$(git rev-parse --short HEAD)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ "$NO_REBUILD" == "1" || "${SKIP_REBUILD:-0}" == "1" ]]; then
  warn "Skipping docker rebuild (--no-rebuild)"
else
  # CACHE_BUST=1 forces a no-cache rebuild so the client bundle picks up
  # the new package.json version. Without this, Docker's layer cache
  # may reuse the previous client/dist and the Footer would show a
  # stale "version mismatch" warning.
  CACHE_FLAG=""
  if [[ "${CACHE_BUST:-0}" == "1" ]]; then
    CACHE_FLAG="--no-cache"
    log "CACHE_BUST=1 → rebuilding without docker cache"
  fi

  log "Rebuilding api (GIT_SHA=$GIT_SHA, BUILD_DATE=$BUILD_DATE)..."
  run docker compose down bioagents
  run env GIT_SHA="$GIT_SHA" BUILD_DATE="$BUILD_DATE" \
    docker compose build $CACHE_FLAG \
      --build-arg GIT_SHA="$GIT_SHA" \
      --build-arg BUILD_DATE="$BUILD_DATE" \
      bioagents
  run docker compose up -d bioagents

  log "Rebuilding worker..."
  run docker compose -f docker-compose.yml -f docker-compose.worker.yml down worker
  run env GIT_SHA="$GIT_SHA" BUILD_DATE="$BUILD_DATE" \
    docker compose -f docker-compose.yml -f docker-compose.worker.yml build $CACHE_FLAG \
      --build-arg GIT_SHA="$GIT_SHA" \
      --build-arg BUILD_DATE="$BUILD_DATE" \
      worker
  run docker compose -f docker-compose.yml -f docker-compose.worker.yml up -d worker

  log "Waiting for api to become healthy..."
  for i in {1..30}; do
    if curl -fsS http://localhost:3000/api/health >/dev/null 2>&1; then
      ok "API healthy"
      break
    fi
    sleep 2
  done

  log "Verifying /api/version..."
  if command -v jq >/dev/null 2>&1; then
    curl -fsS http://localhost:3000/api/version | jq .
  else
    curl -fsS http://localhost:3000/api/version
  fi
fi

ok "Release v$NEW_VERSION complete!"
log "Next steps:"
echo "  - Verify the frontend Footer shows 'BioAgents v$NEW_VERSION'"
echo "  - Smoke-test one deep-research query"
echo "  - If you skipped --no-push, the tag was pushed to origin"