#!/bin/bash
# Dev Agent Bootstrap Script
# Runs inside the container before the agent starts.
# Clones repos from read-only mounts for local writable access.
# Registers a shutdown hook to push WIP branches on exit.
set -euo pipefail

log() { echo "[dev-bootstrap] $*" >&2; }

# --- Shutdown hook: push unpushed commits before dying ---
push_wip_if_needed() {
  local exit_code=$?
  log "Shutdown hook triggered (exit code: $exit_code)"

  for repo in /tmp/nanoclaw /tmp/garsson-*; do
    [ -d "$repo/.git" ] || continue
    cd "$repo"

    # Check for unpushed commits
    local unpushed
    unpushed=$(git log origin/main..HEAD --oneline 2>/dev/null || true)
    if [ -z "$unpushed" ]; then
      log "No unpushed commits in $repo"
      continue
    fi

    # Check if there are uncommitted changes to add
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
      log "Committing uncommitted changes in $repo"
      git add -A
      git commit -m "WIP: uncommitted changes at shutdown" --no-verify 2>/dev/null || true
    fi

    local branch_name
    branch_name="wip/${NANOCLAW_CASE_NAME:-unknown}"
    log "Pushing WIP branch $branch_name from $repo"
    git push -u origin "HEAD:refs/heads/$branch_name" --force 2>/dev/null || {
      log "WARNING: Failed to push WIP branch from $repo"
    }
  done

  log "Shutdown hook complete"
}

trap push_wip_if_needed EXIT

# --- Clone NanoClaw from read-only mount ---
if [ -d /workspace/project/.git ]; then
  log "Cloning NanoClaw from ro mount..."
  git clone --local /workspace/project /tmp/nanoclaw 2>&1 >&2
  cd /tmp/nanoclaw

  # Set remote to GitHub (for pushing)
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    git remote set-url origin \
      "https://x-access-token:${GITHUB_TOKEN}@github.com/Garsson-io/nanoclaw.git"
  fi

  # Fetch latest main for accurate diffing
  git fetch origin main 2>&1 >&2 || log "WARNING: Could not fetch origin/main"

  log "NanoClaw cloned to /tmp/nanoclaw ($(git rev-parse --short HEAD))"
else
  log "WARNING: No project mount at /workspace/project"
fi

# --- Clone vertical repos from read-only mounts ---
if [ -d /workspace/extra ]; then
  for extra in /workspace/extra/*/; do
    [ -d "$extra/.git" ] || continue
    local_name=$(basename "$extra")
    log "Cloning vertical $local_name from ro mount..."
    git clone --local "$extra" "/tmp/$local_name" 2>&1 >&2

    # Set remote if we have GitHub token (vertical remotes set by agent based on needs)
    cd "/tmp/$local_name"
    log "Vertical $local_name cloned to /tmp/$local_name ($(git rev-parse --short HEAD))"
  done
fi

log "Bootstrap complete. Repos ready for dev work."
