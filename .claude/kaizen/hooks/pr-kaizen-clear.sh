#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# pr-kaizen-clear.sh — Level 3 kaizen enforcement (Issue #57)
# PostToolUse hook: clears the PR creation kaizen gate when the agent
# takes a kaizen action (files an issue, suggests a dev case, or
# explicitly declares no action needed).
#
# Triggers on:
#   1. Bash: gh issue create --repo Garsson-io/kaizen (filed a kaizen issue)
#   2. Bash: echo "KAIZEN_NO_ACTION: <reason>" (explicit opt-out)
#   3. Bash: case_suggest_dev IPC file write (dev case suggestion)
#
# Always exits 0 — this is state management, not a gate.

source "$(dirname "$0")/lib/parse-command.sh"
source "$(dirname "$0")/lib/state-utils.sh"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
STDOUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // empty')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exit_code // "0"')

# Only process Bash tool calls
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

# Only process successful commands
if [ "$EXIT_CODE" != "0" ]; then
  exit 0
fi

CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Check if there's an active PR kaizen gate to clear
STATE_INFO=$(find_state_with_status "needs_pr_kaizen")
if [ $? -ne 0 ] || [ -z "$STATE_INFO" ]; then
  exit 0
fi

SHOULD_CLEAR=false
CLEAR_REASON=""

# Trigger 1: gh issue create (filed a kaizen issue)
if echo "$CMD_LINE" | grep -qE '^\s*gh\s+issue\s+create'; then
  # Verify it was actually created (stdout should contain issue URL)
  if echo "$STDOUT" | grep -qE 'https://github\.com/'; then
    SHOULD_CLEAR=true
    CLEAR_REASON="kaizen issue filed"
  fi
fi

# Trigger 2: KAIZEN_NO_ACTION declaration
if echo "$CMD_LINE" | grep -qE 'KAIZEN_NO_ACTION:'; then
  SHOULD_CLEAR=true
  CLEAR_REASON="no action needed (declared)"
fi

if [ "$SHOULD_CLEAR" = true ]; then
  clear_state_with_status "needs_pr_kaizen"
  cat <<EOF

PR kaizen gate cleared ($CLEAR_REASON). You may proceed with other work.
EOF
fi

exit 0
