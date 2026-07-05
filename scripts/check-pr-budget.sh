#!/usr/bin/env bash
# scripts/check-pr-budget.sh
#
# Assert the per-PR review line budget (default 400 changed lines).
# Used by .github/workflows/pr-budget.yml on pull requests.
#
# Behavior:
#   - Computes additions + deletions between BASE_REF and HEAD_REF
#     (BASE_REF defaults to origin/main, HEAD_REF defaults to HEAD).
#   - Compares against MAX_LINES (default 400).
#   - Prints a clear pass/fail summary, plus the top contributors.
#   - Exits 0 when within budget.
#   - In "fail" mode, exits 1 when over budget.
#   - In "warn" mode (default), exits 0 even when over budget, but prints
#     a loud warning so CI shows it on the PR check page.
#
# Env vars:
#   MAX_LINES        - per-PR budget in changed lines (default: 400)
#   PR_BUDGET_MODE   - "warn" (default) or "fail"
#   BASE_REF         - base ref for diff (default: origin/main)
#   HEAD_REF         - head ref for diff (default: HEAD)
#   TOP_N            - number of top contributor files to print (default: 5)
#
# Exit codes:
#   0  - within budget (or over budget in warn mode)
#   1  - over budget in fail mode
#   2  - usage / config error (missing git, invalid mode, etc.)

set -euo pipefail

MAX_LINES="${MAX_LINES:-400}"
PR_BUDGET_MODE="${PR_BUDGET_MODE:-warn}"
BASE_REF="${BASE_REF:-origin/main}"
HEAD_REF="${HEAD_REF:-HEAD}"
TOP_N="${TOP_N:-5}"

log()  { printf '%s\n' "$*"; }
warn() { printf '::warning::%s\n' "$*" >&2; }
err()  { printf '::error::%s\n' "$*" >&2; }

# --- Input validation -------------------------------------------------------

if ! command -v git >/dev/null 2>&1; then
  err "git is not installed or not on PATH"
  exit 2
fi

case "$PR_BUDGET_MODE" in
  warn|fail) ;;
  *)
    err "PR_BUDGET_MODE must be 'warn' or 'fail' (got: '$PR_BUDGET_MODE')"
    exit 2
    ;;
esac

if ! [[ "$MAX_LINES" =~ ^[0-9]+$ ]]; then
  err "MAX_LINES must be a non-negative integer (got: '$MAX_LINES')"
  exit 2
fi

# --- Compute diff stats -----------------------------------------------------

# --shortstat: "N files changed, X insertions(+), Y deletions(-)"
# Binary files are NOT counted in insertions/deletions by git.
shortstat="$(git diff --shortstat "$BASE_REF"..."$HEAD_REF" 2>/dev/null || true)"

if [[ -z "$shortstat" ]]; then
  log "No diff between $BASE_REF and $HEAD_REF (or refs not found). Nothing to check."
  exit 0
fi

# --numstat: "<add>\t<del>\t<path>" per file. Binary files show "-\t-\t<path>".
# We use it only for the "top contributors" report; the budget check uses
# --shortstat which already excludes binary content.
numstat="$(git diff --numstat "$BASE_REF"..."$HEAD_REF" 2>/dev/null || true)"

additions="$(printf '%s\n' "$shortstat" | sed -n 's/.* \([0-9]\+\) insertions\?.*/\1/p')"
deletions="$(printf '%s\n' "$shortstat" | sed -n 's/.* \([0-9]\+\) deletions\?.*/\1/p')"
files_changed="$(printf '%s\n' "$shortstat" | sed -n 's/ \([0-9]\+\) files\? changed.*/\1/p')"

# Edge case: zero changes — --shortstat outputs nothing meaningful.
additions="${additions:-0}"
deletions="${deletions:-0}"
files_changed="${files_changed:-0}"

total=$(( additions + deletions ))

# --- Disabled budget (MAX_LINES=0) -----------------------------------------

if [[ "$MAX_LINES" -eq 0 ]]; then
  log "PR budget check is disabled (MAX_LINES=0)."
  log "  base..head: $BASE_REF...$HEAD_REF"
  log "  files changed: $files_changed"
  log "  insertions:    $additions"
  log "  deletions:     $deletions"
  log "  total:         $total"
  exit 0
fi

# --- Top contributors -------------------------------------------------------

# Parse --numstat into "<add+del>\t<path>" lines, sort desc, head N.
# Skip binary files (lines with "-<TAB>-<TAB>").
top_files="$(printf '%s\n' "$numstat" \
  | awk -F'\t' '
      $1 == "-" && $2 == "-" { next }                # binary
      { sum = $1 + $2; printf "%d\t%s\n", sum, $3 }
    ' \
  | sort -rn \
  | head -n "$TOP_N" \
  || true)"

# --- Report -----------------------------------------------------------------

log "PR line-budget check"
log "  base..head:    $BASE_REF...$HEAD_REF"
log "  budget:        $MAX_LINES changed lines (mode: $PR_BUDGET_MODE)"
log "  files changed: $files_changed"
log "  insertions:    $additions"
log "  deletions:     $deletions"
log "  total:         $total"
log ""

if [[ -n "$top_files" ]]; then
  log "Top $TOP_N files by changed lines:"
  while IFS=$'\t' read -r lines path; do
    log "  $lines  $path"
  done <<< "$top_files"
  log ""
fi

# --- Verdict ----------------------------------------------------------------

if [[ "$total" -le "$MAX_LINES" ]]; then
  log "PASS: $total <= $MAX_LINES budget."
  exit 0
fi

over=$(( total - MAX_LINES ))
over_pct=$(( (over * 100 + MAX_LINES / 2) / MAX_LINES ))

msg="PR exceeds $MAX_LINES-line review budget: $total changed lines (+$additions / -$deletions, +${over_pct}% over)."

case "$PR_BUDGET_MODE" in
  fail)
    err "$msg"
    exit 1
    ;;
  warn)
    warn "$msg Failing the budget is not blocking in warn mode; switch PR_BUDGET_MODE=fail to enforce."
    log "OVER BUDGET (warn): $total > $MAX_LINES (over by $over lines, ~${over_pct}%)."
    exit 0
    ;;
esac
