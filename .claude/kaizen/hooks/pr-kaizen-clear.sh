#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# pr-kaizen-clear.sh — Level 3 kaizen enforcement (Issue #57, #113)
# PostToolUse hook: clears the PR creation kaizen gate when the agent
# submits a valid KAIZEN_IMPEDIMENTS JSON declaration covering all
# identified impediments with proper dispositions.
#
# Triggers on:
#   1. Bash: echo "KAIZEN_IMPEDIMENTS: [...]" (structured impediment declaration)
#   2. Bash: echo "KAIZEN_NO_ACTION: <reason>" (legacy — still accepted)
#
# Validation (kaizen #113):
#   - JSON must be a valid array
#   - Each entry must have "impediment" (non-empty string) and "disposition"
#   - disposition "filed" or "incident" requires "ref" field
#   - disposition "waived" requires "reason" field
#   - Empty array [] is valid (genuinely no impediments)
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

# Trigger 1: KAIZEN_IMPEDIMENTS structured declaration (kaizen #113)
if echo "$CMD_LINE" | grep -qE 'KAIZEN_IMPEDIMENTS:'; then
  # Extract JSON from command or stdout
  # The agent runs: echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS' ... IMPEDIMENTS
  # Or inline: echo 'KAIZEN_IMPEDIMENTS: [...]'
  JSON=""

  # Try extracting from stdout first (the echo output)
  if [ -n "$STDOUT" ]; then
    # Match JSON array after "KAIZEN_IMPEDIMENTS:" — may be on same line or following lines
    JSON=$(echo "$STDOUT" | sed -n '/KAIZEN_IMPEDIMENTS:/,$ p' | sed '1s/.*KAIZEN_IMPEDIMENTS:[[:space:]]*//' | tr '\n' ' ')
  fi

  # Fallback: extract from command itself (inline echo)
  if [ -z "$JSON" ] || ! echo "$JSON" | jq empty 2>/dev/null; then
    JSON=$(echo "$CMD_LINE" | sed -n 's/.*KAIZEN_IMPEDIMENTS:[[:space:]]*//p' | tr '\n' ' ')
  fi

  # Validate the JSON
  if [ -z "$JSON" ] || ! echo "$JSON" | jq empty 2>/dev/null; then
    cat <<'EOF'

KAIZEN_IMPEDIMENTS: Invalid JSON. Expected a JSON array, e.g.:
  echo 'KAIZEN_IMPEDIMENTS: []'
  or
  echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
  [{"impediment": "...", "disposition": "filed", "ref": "#NNN"}]
  IMPEDIMENTS
EOF
    exit 0
  fi

  # Validate it's an array
  IS_ARRAY=$(echo "$JSON" | jq 'type == "array"' 2>/dev/null)
  if [ "$IS_ARRAY" != "true" ]; then
    cat <<'EOF'

KAIZEN_IMPEDIMENTS: Expected a JSON array, got a different type.
  Use [] for no impediments, or [{"impediment": "...", ...}, ...] for a list.
EOF
    exit 0
  fi

  # Empty array is valid — genuinely no impediments
  ITEM_COUNT=$(echo "$JSON" | jq 'length' 2>/dev/null)
  if [ "$ITEM_COUNT" = "0" ]; then
    SHOULD_CLEAR=true
    CLEAR_REASON="no impediments identified"
  else
    # Validate each entry
    VALIDATION=$(echo "$JSON" | jq -r '
      [.[] | {
        impediment: (.impediment // ""),
        disposition: (.disposition // ""),
        ref: (.ref // ""),
        reason: (.reason // "")
      } |
      if .impediment == "" then
        "missing \"impediment\" field"
      elif .disposition == "" then
        "missing \"disposition\" for: \(.impediment)"
      elif (.disposition | IN("filed", "incident", "fixed-in-pr", "waived") | not) then
        "invalid disposition \"\(.disposition)\" for: \(.impediment) (must be filed|incident|fixed-in-pr|waived)"
      elif (.disposition == "filed" or .disposition == "incident") and .ref == "" then
        "disposition \"\(.disposition)\" requires \"ref\" field for: \(.impediment)"
      elif .disposition == "waived" and .reason == "" then
        "disposition \"waived\" requires \"reason\" field for: \(.impediment)"
      else
        empty
      end
      ] | join("\n")
    ' 2>/dev/null)

    if [ -n "$VALIDATION" ]; then
      printf '\nKAIZEN_IMPEDIMENTS: Validation failed:\n%s\n\nFix the issues and resubmit.\n' "$VALIDATION"
      exit 0
    fi

    SHOULD_CLEAR=true
    CLEAR_REASON="$ITEM_COUNT impediment(s) addressed"
  fi
fi

# Trigger 2: KAIZEN_NO_ACTION declaration (legacy compatibility)
if [ "$SHOULD_CLEAR" != "true" ] && echo "$CMD_LINE" | grep -qE 'KAIZEN_NO_ACTION:'; then
  SHOULD_CLEAR=true
  CLEAR_REASON="no action needed (legacy declaration)"
fi

if [ "$SHOULD_CLEAR" = true ]; then
  clear_state_with_status "needs_pr_kaizen"
  cat <<EOF

PR kaizen gate cleared ($CLEAR_REASON). You may proceed with other work.
EOF
fi

exit 0
