#!/bin/bash
# enforce-pr-review-stop.sh — Level 3 kaizen enforcement (Issue #46)
# Stop hook: prevents Claude from finishing its response when a PR review is pending.
#
# This closes the critical gap in the review enforcement system:
#   1. PostToolUse (pr-review-loop.sh) writes STATUS=needs_review after gh pr create
#   2. PreToolUse (enforce-pr-review.sh) blocks non-review Bash commands
#   3. THIS HOOK blocks Claude from stopping — forcing it to start the review
#
# Without this hook, Claude can respond "PR created: <url>" and stop, never
# triggering any PreToolUse hooks. The review would only happen if the user
# explicitly asked for it.
#
# Flow after fix:
#   gh pr create → PostToolUse writes needs_review → Claude tries to stop
#   → THIS HOOK blocks stop → Claude must call a tool → PreToolUse funnels
#   to gh pr diff → PostToolUse sets passed → Claude can stop
#
# Exit 0 with no output = allow stop
# Exit 0 with JSON {"decision":"block","reason":"..."} = block stop

source "$(dirname "$0")/lib/state-utils.sh"

INPUT=$(cat)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')

# Find any needs_review state for current branch
find_needs_review() {
  while IFS= read -r f; do
    local status
    status=$(grep -E '^STATUS=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ "$status" = "needs_review" ]; then
      local pr_url round
      pr_url=$(grep -E '^PR_URL=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
      round=$(grep -E '^ROUND=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
      echo "$pr_url|$round"
      return 0
    fi
  done < <(list_state_files_for_current_worktree)
  return 1
}

REVIEW_INFO=$(find_needs_review)
if [ $? -ne 0 ] || [ -z "$REVIEW_INFO" ]; then
  # No pending review — allow stop
  exit 0
fi

PR_URL=$(echo "$REVIEW_INFO" | cut -d'|' -f1)
ROUND=$(echo "$REVIEW_INFO" | cut -d'|' -f2)

# Block stop: agent must review the PR first.
# Use jq --arg for safe string interpolation (no injection risk).
jq -n \
  --arg pr_url "$PR_URL" \
  --arg round "$ROUND" \
  '{
    decision: "block",
    reason: ("STOP BLOCKED: You have a pending PR review that must be completed before you can finish.\n\n  PR: " + $pr_url + " (round " + $round + ")\n\nYou MUST run `gh pr diff " + $pr_url + "` now and complete the self-review checklist.\nOnly after reviewing can you finish your response.\n\nThis is a mandatory part of the PR creation workflow.")
  }'

exit 0
