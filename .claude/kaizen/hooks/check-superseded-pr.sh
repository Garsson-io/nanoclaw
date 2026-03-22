#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# check-superseded-pr.sh — Detects and auto-closes PRs whose kaizen issues
# are already resolved by other PRs (kaizen #318).
#
# PostToolUse hook on Bash tool calls.
# Triggers after successful `gh pr create`.
# If ALL referenced kaizen issues in the PR body are CLOSED, the hook:
#   1. Warns the agent that the PR is superseded
#   2. Adds a comment explaining why
#   3. Closes the PR
#
# Always exits 0 — this is advisory + cleanup, not a gate.

source "$(dirname "$0")/lib/parse-command.sh"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
STDOUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // empty')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exit_code // "0"')

# Only process successful Bash tool calls
if [ "$TOOL_NAME" != "Bash" ] || [ "$EXIT_CODE" != "0" ]; then
  exit 0
fi

CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Only trigger on gh pr create
if ! is_gh_pr_command "$CMD_LINE" "create"; then
  exit 0
fi

# Extract PR URL from stdout
PR_URL=$(reconstruct_pr_url "$CMD_LINE" "$STDOUT" "" "create")
if [ -z "$PR_URL" ]; then
  exit 0
fi

# Extract repo and PR number
PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$')
REPO=$(echo "$PR_URL" | sed -n 's|https://github.com/\([^/]*/[^/]*\)/pull/.*|\1|p')
if [ -z "$PR_NUM" ] || [ -z "$REPO" ]; then
  exit 0
fi

# Get PR body + title
PR_BODY=$(gh pr view "$PR_NUM" --repo "$REPO" --json body,title --jq '.title + "\n" + .body' 2>/dev/null)
if [ -z "$PR_BODY" ]; then
  exit 0
fi

# Extract kaizen issue numbers from PR body
# Patterns: Garsson-io/kaizen#NNN, kaizen/issues/NNN, kaizen #NNN, (kaizen #NNN)
ISSUE_NUMS=$(echo "$PR_BODY" | grep -oP 'Garsson-io/kaizen[#/issues/]*\K[0-9]+' | sort -un)
URL_NUMS=$(echo "$PR_BODY" | grep -oP 'https://github\.com/Garsson-io/kaizen/issues/\K[0-9]+' | sort -un)
INLINE_NUMS=$(echo "$PR_BODY" | grep -oP 'kaizen\s*#\K[0-9]+' | sort -un)

ALL_ISSUES=$(printf '%s\n%s\n%s' "$ISSUE_NUMS" "$URL_NUMS" "$INLINE_NUMS" | sort -un | grep -v '^$')
if [ -z "$ALL_ISSUES" ]; then
  exit 0
fi

# Check each issue — if ANY is still open, PR is not superseded
ALL_CLOSED=true
CLOSED_ISSUES=""
while IFS= read -r issue_num; do
  [ -z "$issue_num" ] && continue
  ISSUE_STATE=$(gh issue view "$issue_num" --repo Garsson-io/kaizen --json state --jq .state 2>/dev/null)
  if [ "$ISSUE_STATE" != "CLOSED" ]; then
    ALL_CLOSED=false
    break
  fi
  CLOSED_ISSUES="${CLOSED_ISSUES}#${issue_num} "
done <<< "$ALL_ISSUES"

if [ "$ALL_CLOSED" != "true" ]; then
  exit 0
fi

# All referenced kaizen issues are closed — PR is superseded
CLOSED_ISSUES=$(echo "$CLOSED_ISSUES" | sed 's/ $//')

# Add comment explaining why
gh pr comment "$PR_NUM" --repo "$REPO" --body "$(printf 'Auto-closing: all referenced kaizen issues (%s) are already resolved by other PRs.\n\nThis PR is superseded — the work was completed in a parallel run.' "$CLOSED_ISSUES")" 2>/dev/null || true

# Close the PR
gh pr close "$PR_NUM" --repo "$REPO" 2>/dev/null || true

cat <<EOF

⚠️  PR $PR_URL is superseded — auto-closed.
All referenced kaizen issues ($CLOSED_ISSUES) are already CLOSED.
Another PR already shipped this work. No further action needed.

Do NOT spend time on merge conflicts or reviews for this PR.
Move on to the next work item.
EOF

exit 0
