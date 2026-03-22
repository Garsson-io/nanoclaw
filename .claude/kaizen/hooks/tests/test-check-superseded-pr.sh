#!/bin/bash
# Tests for check-superseded-pr.sh — PostToolUse hook that detects and
# auto-closes PRs whose referenced kaizen issues are already resolved.
#
# INVARIANT UNDER TEST: After `gh pr create`, if ALL referenced kaizen
# issues (Garsson-io/kaizen#NNN) in the PR body are already CLOSED,
# the hook warns the agent and auto-closes the PR.
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../check-superseded-pr.sh"

# Create a temp directory for mock commands
MOCK_DIR=$(mktemp -d)
trap 'rm -rf "$MOCK_DIR"' EXIT

# Helper: run PostToolUse hook simulating a Bash command
run_posttool_bash() {
  local command="$1"
  local stdout="$2"
  local exit_code="${3:-0}"
  local input
  input=$(jq -n \
    --arg cmd "$command" \
    --arg out "$stdout" \
    --arg ec "$exit_code" '{
    tool_name: "Bash",
    tool_input: { command: $cmd },
    tool_response: { stdout: $out, stderr: "", exit_code: ($ec | tonumber) }
  }')
  echo "$input" | PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>/dev/null
}

echo "=== Non-pr-create commands are ignored ==="

# Mock gh that should NOT be called
cat > "$MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
echo "ERROR: gh should not be called for non-pr-create" >&2
exit 1
MOCK
chmod +x "$MOCK_DIR/gh"

OUTPUT=$(run_posttool_bash "npm test" "all tests pass")
assert_eq "npm test ignored" "" "$OUTPUT"

OUTPUT=$(run_posttool_bash "gh pr merge 42" "merged")
assert_eq "gh pr merge ignored" "" "$OUTPUT"

OUTPUT=$(run_posttool_bash "gh issue create --title test" "created")
assert_eq "gh issue create ignored" "" "$OUTPUT"

echo ""
echo "=== Failed gh pr create is ignored ==="

OUTPUT=$(run_posttool_bash "gh pr create --title test" "error" "1")
assert_eq "failed pr create ignored" "" "$OUTPUT"

echo ""
echo "=== PR with no kaizen references ==="

cat > "$MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "pr view.*body"; then
  echo "Fixed a typo in the README"
  exit 0
fi
exit 0
MOCK
chmod +x "$MOCK_DIR/gh"

OUTPUT=$(run_posttool_bash \
  "gh pr create --title 'fix typo'" \
  "https://github.com/Garsson-io/nanoclaw/pull/100")
assert_eq "no kaizen refs - no output" "" "$OUTPUT"

echo ""
echo "=== PR with open kaizen issues ==="

cat > "$MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "pr view.*body"; then
  echo "Closes https://github.com/Garsson-io/kaizen/issues/42"
  exit 0
fi
if echo "$@" | grep -q "issue view.*42.*state"; then
  echo "OPEN"
  exit 0
fi
exit 0
MOCK
chmod +x "$MOCK_DIR/gh"

OUTPUT=$(run_posttool_bash \
  "gh pr create --title 'fix kaizen 42'" \
  "https://github.com/Garsson-io/nanoclaw/pull/101")
assert_eq "open kaizen issue - no output" "" "$OUTPUT"

echo ""
echo "=== PR with all kaizen issues closed — superseded ==="

cat > "$MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "pr view.*body"; then
  echo "Closes https://github.com/Garsson-io/kaizen/issues/42"
  echo "Also fixes Garsson-io/kaizen#43"
  exit 0
fi
if echo "$@" | grep -q "issue view"; then
  echo "CLOSED"
  exit 0
fi
if echo "$@" | grep -q "pr close"; then
  echo "closed"
  exit 0
fi
exit 0
MOCK
chmod +x "$MOCK_DIR/gh"

OUTPUT=$(run_posttool_bash \
  "gh pr create --title 'fix kaizen 42'" \
  "https://github.com/Garsson-io/nanoclaw/pull/102")
assert_contains "superseded warning shown" "superseded" "$OUTPUT"
assert_contains "mentions closed issues" "#42" "$OUTPUT"

echo ""
echo "=== PR with mixed open/closed kaizen issues — no action ==="

cat > "$MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "pr view.*body"; then
  echo "Closes https://github.com/Garsson-io/kaizen/issues/42"
  echo "Also fixes Garsson-io/kaizen#43"
  exit 0
fi
if echo "$@" | grep -q "issue view.*42"; then
  echo "CLOSED"
  exit 0
fi
if echo "$@" | grep -q "issue view.*43"; then
  echo "OPEN"
  exit 0
fi
exit 0
MOCK
chmod +x "$MOCK_DIR/gh"

OUTPUT=$(run_posttool_bash \
  "gh pr create --title 'fix kaizen 42 and 43'" \
  "https://github.com/Garsson-io/nanoclaw/pull/103")
assert_eq "mixed open/closed - no output" "" "$OUTPUT"

echo ""
echo "=== kaizen reference patterns in PR body ==="

cat > "$MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "pr view.*body"; then
  echo "Fix for kaizen #42"
  echo "References Garsson-io/kaizen#43"
  exit 0
fi
if echo "$@" | grep -q "issue view"; then
  echo "CLOSED"
  exit 0
fi
if echo "$@" | grep -q "pr close"; then
  echo "closed"
  exit 0
fi
exit 0
MOCK
chmod +x "$MOCK_DIR/gh"

OUTPUT=$(run_posttool_bash \
  "gh pr create --title 'fix (kaizen #42)'" \
  "https://github.com/Garsson-io/nanoclaw/pull/104")
assert_contains "detects kaizen references" "superseded" "$OUTPUT"

echo ""
echo "=== gh failure handled gracefully ==="

cat > "$MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
exit 1
MOCK
chmod +x "$MOCK_DIR/gh"

OUTPUT=$(run_posttool_bash \
  "gh pr create --title 'test'" \
  "https://github.com/Garsson-io/nanoclaw/pull/105")
assert_eq "gh failure - no output" "" "$OUTPUT"

echo ""
echo "=== Non-Bash tool is ignored ==="

INPUT=$(jq -n '{
  tool_name: "Edit",
  tool_input: { file: "test.ts" },
  tool_response: { stdout: "", stderr: "", exit_code: 0 }
}')
OUTPUT=$(echo "$INPUT" | PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>/dev/null)
assert_eq "Edit tool ignored" "" "$OUTPUT"

print_results
