#!/bin/bash
# claude-wt — Launch Claude Code in an isolated git worktree
#
# Creates a temporary worktree with a nonce branch, runs claude inside it,
# and cleans up on exit if no changes were made.
#
# Usage:
#   claude-wt [claude args...]          # interactive, auto-skips permissions
#   claude-wt -p "fix the bug"          # headless with prompt (-p is claude's --prompt flag)
#   claude-wt --base feat/my-branch     # branch off a specific base
#   claude-wt --safe                    # DON'T skip permissions (ask for each tool)
#   claude-wt --keep                    # preserve worktree even if clean on exit
#
# By default, --dangerously-skip-permissions is passed to claude because
# the worktree is isolated — no risk to the main checkout.
#
# Install as alias:
#   alias claude-wt='/path/to/nanoclaw/scripts/claude-wt.sh'

set -euo pipefail

# Parse our own flags (before passing rest to claude)
BASE_BRANCH=""
KEEP_WORKTREE=false
SKIP_PERMISSIONS=true  # Default: skip permissions (worktree is isolated, safe)
CLAUDE_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      BASE_BRANCH="$2"
      shift 2
      ;;
    --keep)
      KEEP_WORKTREE=true
      shift
      ;;
    --safe)
      SKIP_PERMISSIONS=false
      shift
      ;;
    *)
      CLAUDE_ARGS+=("$1")
      shift
      ;;
  esac
done

# Add --dangerously-skip-permissions by default (worktree is isolated)
if [ "$SKIP_PERMISSIONS" = true ]; then
  CLAUDE_ARGS=("--dangerously-skip-permissions" "${CLAUDE_ARGS[@]}")
fi

# Find repo root
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  echo "Error: not in a git repository" >&2
  exit 1
fi

# Default base: current branch or main
if [ -z "$BASE_BRANCH" ]; then
  BASE_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
fi

# Generate nonce: YYMMDD-HHMM-random
NONCE=$(date +%y%m%d-%H%M)-$(head -c 3 /dev/urandom | xxd -p)
BRANCH_NAME="wt/${NONCE}"
WORKTREE_DIR="${REPO_ROOT}/.claude/worktrees/${NONCE}"

# Create worktree
echo "Creating worktree: ${WORKTREE_DIR}"
echo "  Branch: ${BRANCH_NAME} (based on ${BASE_BRANCH})"
git worktree add -b "${BRANCH_NAME}" "${WORKTREE_DIR}" "${BASE_BRANCH}" 2>/dev/null

cleanup() {
  local exit_code=$?

  # Check if worktree has changes
  if [ -d "${WORKTREE_DIR}" ]; then
    local dirty
    dirty=$(git -C "${WORKTREE_DIR}" status --porcelain 2>/dev/null | head -1)
    local ahead
    ahead=$(git -C "${WORKTREE_DIR}" log "${BASE_BRANCH}..HEAD" --oneline 2>/dev/null | head -1)

    if [ -n "$dirty" ] || [ -n "$ahead" ] || [ "$KEEP_WORKTREE" = true ]; then
      echo ""
      echo "Worktree preserved at: ${WORKTREE_DIR}"
      echo "  Branch: ${BRANCH_NAME}"
      if [ -n "$dirty" ]; then
        echo "  (has uncommitted changes)"
      fi
      if [ -n "$ahead" ]; then
        echo "  (has unpushed commits)"
      fi
      echo "  To remove: git worktree remove ${WORKTREE_DIR} && git branch -d ${BRANCH_NAME}"
    else
      echo "Worktree clean, removing: ${WORKTREE_DIR}"
      git worktree remove "${WORKTREE_DIR}" 2>/dev/null || true
      git branch -d "${BRANCH_NAME}" 2>/dev/null || true
    fi
  fi

  exit $exit_code
}

trap cleanup EXIT

# Run claude in the worktree
cd "${WORKTREE_DIR}"
echo "Starting Claude in worktree..."
echo ""
claude "${CLAUDE_ARGS[@]}"
