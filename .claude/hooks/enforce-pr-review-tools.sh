#!/bin/bash
# enforce-pr-review-tools.sh — Level 3 kaizen enforcement (Issue #46)
# PreToolUse gate for non-Bash tools: blocks Edit, Write, and Agent tools
# until the agent completes the mandatory PR self-review.
#
# Companion to enforce-pr-review.sh (which handles Bash commands with
# an allowlist for review commands like gh pr diff). This hook is simpler:
# during an active review, these tools are always blocked because the agent
# should be reviewing, not editing or spawning subagents.
#
# Read-only tools (Read, Glob, Grep) are NOT blocked because they're useful
# for reviewing code during the review process.

source "$(dirname "$0")/lib/state-utils.sh"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

if [ -z "$TOOL_NAME" ]; then
  exit 0
fi

# Check if any state file has STATUS=needs_review for the CURRENT branch
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
  # No active review — allow everything
  exit 0
fi

PR_URL=$(echo "$REVIEW_INFO" | cut -d'|' -f1)
ROUND=$(echo "$REVIEW_INFO" | cut -d'|' -f2)

# Block the tool — agent must review first
jq -n \
  --arg tool "$TOOL_NAME" \
  --arg pr_url "$PR_URL" \
  --arg round "$ROUND" \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("BLOCKED: " + $tool + " is not allowed during PR review.\n\nYou have an active PR review that must be completed first:\n  PR: " + $pr_url + " (round " + $round + ")\n\nRun `gh pr diff " + $pr_url + "` to review the diff, then work through the\nself-review checklist. Only after reviewing can you proceed with other work.")
    }
  }'

exit 0
