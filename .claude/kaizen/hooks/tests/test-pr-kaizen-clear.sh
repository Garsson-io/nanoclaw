#!/bin/bash
# Tests for pr-kaizen-clear.sh — PostToolUse hook that clears the PR
# creation kaizen gate when the agent takes a kaizen action.
#
# INVARIANT UNDER TEST: The PR kaizen gate (needs_pr_kaizen) is cleared
# when the agent files a kaizen issue or declares no action needed.
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../pr-kaizen-clear.sh"
setup_test_env

setup() { reset_state; }
teardown() { reset_state; }

# Helper: create PR kaizen state file
create_pr_kaizen_state() {
  local pr_url="$1"
  local branch="${2:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
  local filename
  filename="pr-kaizen-$(echo "$pr_url" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')"
  printf 'PR_URL=%s\nSTATUS=%s\nBRANCH=%s\n' \
    "$pr_url" "needs_pr_kaizen" "$branch" > "$STATE_DIR/$filename"
}

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
  echo "$input" | bash "$HOOK" 2>/dev/null
}

# Helper: check if kaizen state file exists
has_pr_kaizen_state() {
  local count
  count=$(find "$STATE_DIR" -name "pr-kaizen-*" 2>/dev/null | wc -l)
  [ "$count" -gt 0 ]
}

echo "=== gh issue create clears kaizen gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Filing a kaizen issue clears the gate
OUTPUT=$(run_posttool_bash \
  "gh issue create --repo Garsson-io/kaizen --title 'improve X' --body 'details'" \
  "https://github.com/Garsson-io/kaizen/issues/99")

if ! has_pr_kaizen_state; then
  echo "  PASS: gh issue create cleared kaizen gate"
  ((PASS++))
else
  echo "  FAIL: gh issue create did NOT clear kaizen gate"
  ((FAIL++))
fi
assert_contains "output mentions gate cleared" "gate cleared" "$OUTPUT"

echo ""
echo "=== KAIZEN_NO_ACTION clears kaizen gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Explicit no-action declaration clears the gate
OUTPUT=$(run_posttool_bash \
  'echo "KAIZEN_NO_ACTION: straightforward config change" >/dev/null' \
  "")

if ! has_pr_kaizen_state; then
  echo "  PASS: KAIZEN_NO_ACTION cleared kaizen gate"
  ((PASS++))
else
  echo "  FAIL: KAIZEN_NO_ACTION did NOT clear kaizen gate"
  ((FAIL++))
fi
assert_contains "output mentions no action" "no action needed" "$OUTPUT"

echo ""
echo "=== Failed gh issue create does NOT clear gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Failed issue creation does not clear the gate
OUTPUT=$(run_posttool_bash \
  "gh issue create --repo Garsson-io/kaizen --title 'test'" \
  "error: could not create issue" \
  "1")

if has_pr_kaizen_state; then
  echo "  PASS: failed gh issue create did not clear gate"
  ((PASS++))
else
  echo "  FAIL: failed command incorrectly cleared gate"
  ((FAIL++))
fi

echo ""
echo "=== gh issue create without issue URL does NOT clear gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Issue creation that doesn't return a URL is suspicious
OUTPUT=$(run_posttool_bash \
  "gh issue create --repo Garsson-io/kaizen --title 'test'" \
  "some output without a url")

if has_pr_kaizen_state; then
  echo "  PASS: gh issue create without URL did not clear gate"
  ((PASS++))
else
  echo "  FAIL: gh issue create without URL incorrectly cleared gate"
  ((FAIL++))
fi

echo ""
echo "=== Unrelated commands do NOT clear gate ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Non-kaizen commands do not affect the gate
OUTPUT=$(run_posttool_bash "npm run build" "build complete")
if has_pr_kaizen_state; then
  echo "  PASS: npm run build did not clear gate"
  ((PASS++))
else
  echo "  FAIL: npm run build incorrectly cleared gate"
  ((FAIL++))
fi

OUTPUT=$(run_posttool_bash "git status" "nothing to commit")
if has_pr_kaizen_state; then
  echo "  PASS: git status did not clear gate"
  ((PASS++))
else
  echo "  FAIL: git status incorrectly cleared gate"
  ((FAIL++))
fi

echo ""
echo "=== No pending state: hook is a no-op ==="

setup

# INVARIANT: Without pending state, no output or side effects
OUTPUT=$(run_posttool_bash \
  "gh issue create --repo Garsson-io/kaizen --title 'test'" \
  "https://github.com/Garsson-io/kaizen/issues/99")
assert_eq "no pending state, no output" "" "$OUTPUT"

echo ""
echo "=== Non-Bash tool calls are ignored ==="

setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Non-Bash tool calls don't affect state
INPUT_EDIT=$(jq -n '{
  tool_name: "Edit",
  tool_input: { file_path: "/test.ts" },
  tool_response: {}
}')
OUTPUT=$(echo "$INPUT_EDIT" | bash "$HOOK" 2>/dev/null)
if has_pr_kaizen_state; then
  echo "  PASS: Edit tool call did not clear gate"
  ((PASS++))
else
  echo "  FAIL: Edit tool call incorrectly cleared gate"
  ((FAIL++))
fi

echo ""
echo "=== Cross-worktree isolation: only clears own branch ==="

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
setup
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/42" "wt/other-branch"
create_pr_kaizen_state "https://github.com/Garsson-io/nanoclaw/pull/43" "$CURRENT_BRANCH"

# INVARIANT: Clearing only affects state for the current branch
OUTPUT=$(run_posttool_bash \
  "gh issue create --repo Garsson-io/kaizen --title 'test'" \
  "https://github.com/Garsson-io/kaizen/issues/99")

# PR 42 (other branch) should still exist
if [ -f "$STATE_DIR/pr-kaizen-Garsson-io_nanoclaw_42" ]; then
  echo "  PASS: other branch's kaizen state preserved"
  ((PASS++))
else
  echo "  FAIL: other branch's kaizen state was cleared"
  ((FAIL++))
fi

# PR 43 (our branch) should be cleared
if [ ! -f "$STATE_DIR/pr-kaizen-Garsson-io_nanoclaw_43" ]; then
  echo "  PASS: own branch's kaizen state cleared"
  ((PASS++))
else
  echo "  FAIL: own branch's kaizen state NOT cleared"
  ((FAIL++))
fi

teardown
print_results
