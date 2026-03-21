#!/bin/bash
# Tests for kaizen-reflect.sh — PostToolUse hook that triggers kaizen
# reflection after gh pr create/merge and instructs the main agent to
# launch a background kaizen-bg subagent.
#
# INVARIANT UNDER TEST: After gh pr create or gh pr merge, kaizen-reflect.sh
# writes a state file AND emits instructions to launch kaizen-bg subagent
# with PR context for background reflection.
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../kaizen-reflect.sh"
setup_test_env

# Override send_telegram_ipc to no-op (avoid real Telegram calls)
export SEND_TELEGRAM_IPC_DISABLED=true

setup() { reset_state; }
teardown() { reset_state; }

# Helper: run PostToolUse hook simulating a gh pr create
run_pr_create() {
  local pr_url="$1"
  local input
  input=$(jq -n \
    --arg cmd "gh pr create --title 'test' --body 'test'" \
    --arg out "$pr_url" '{
    tool_name: "Bash",
    tool_input: { command: $cmd },
    tool_response: { stdout: $out, stderr: "", exit_code: 0 }
  }')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

# Helper: run PostToolUse hook simulating a gh pr merge
run_pr_merge() {
  local pr_url="$1"
  local input
  input=$(jq -n \
    --arg cmd "gh pr merge $pr_url --squash --delete-branch --auto" \
    --arg out "✓ Pull request merged" '{
    tool_name: "Bash",
    tool_input: { command: $cmd },
    tool_response: { stdout: $out, stderr: "", exit_code: 0 }
  }')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

# Helper: check if state file was created
has_kaizen_state() {
  local count
  count=$(find "$STATE_DIR" -name "pr-kaizen-*" 2>/dev/null | wc -l)
  [ "$count" -gt 0 ]
}

echo "=== gh pr create: state file is written ==="

setup

run_pr_create "https://github.com/Garsson-io/nanoclaw/pull/42" > /dev/null

if has_kaizen_state; then
  echo "  PASS: state file created after gh pr create"
  ((PASS++))
else
  echo "  FAIL: no state file after gh pr create"
  ((FAIL++))
fi

echo ""
echo "=== gh pr create: output includes kaizen-bg subagent instruction ==="

setup

OUTPUT=$(run_pr_create "https://github.com/Garsson-io/nanoclaw/pull/42")

# INVARIANT: Output instructs the agent to launch kaizen-bg subagent
assert_contains "mentions kaizen-bg" "kaizen-bg" "$OUTPUT"
assert_contains "mentions background" "background" "$OUTPUT"
assert_contains "mentions Agent tool" "Agent" "$OUTPUT"
assert_contains "mentions run_in_background" "run_in_background" "$OUTPUT"
assert_contains "includes PR URL" "pull/42" "$OUTPUT"

echo ""
echo "=== gh pr create: output includes structured impediment format ==="

setup

OUTPUT=$(run_pr_create "https://github.com/Garsson-io/nanoclaw/pull/42")

# INVARIANT: Output still includes the KAIZEN_IMPEDIMENTS format for gate clearing
assert_contains "mentions KAIZEN_IMPEDIMENTS" "KAIZEN_IMPEDIMENTS" "$OUTPUT"

echo ""
echo "=== gh pr merge: output includes kaizen-bg subagent instruction ==="

setup

OUTPUT=$(run_pr_merge "https://github.com/Garsson-io/nanoclaw/pull/42")

# INVARIANT: Post-merge also instructs kaizen-bg subagent launch
assert_contains "merge: mentions kaizen-bg" "kaizen-bg" "$OUTPUT"
assert_contains "merge: mentions background" "background" "$OUTPUT"

echo ""
echo "=== Non-PR commands: no output ==="

setup

INPUT=$(jq -n '{
  tool_name: "Bash",
  tool_input: { command: "npm run build" },
  tool_response: { stdout: "done", stderr: "", exit_code: 0 }
}')
OUTPUT=$(echo "$INPUT" | bash "$HOOK" 2>/dev/null)

assert_eq "non-PR command produces no output" "" "$OUTPUT"

echo ""
echo "=== Failed commands: no output ==="

setup

INPUT=$(jq -n '{
  tool_name: "Bash",
  tool_input: { command: "gh pr create --title test" },
  tool_response: { stdout: "", stderr: "error", exit_code: 1 }
}')
OUTPUT=$(echo "$INPUT" | bash "$HOOK" 2>/dev/null)

assert_eq "failed pr create produces no output" "" "$OUTPUT"

echo ""
echo "=== kaizen-bg agent definition exists with correct config ==="

# Agent definitions live at .claude/agents/, not .claude/kaizen/agents/
# Navigate from .claude/kaizen/hooks/tests/ up to .claude/ then into agents/
AGENT_FILE="$(dirname "$0")/../../../agents/kaizen-bg.md"

if [ -f "$AGENT_FILE" ]; then
  echo "  PASS: kaizen-bg.md exists"
  ((PASS++))
else
  echo "  FAIL: kaizen-bg.md does not exist at $AGENT_FILE"
  ((FAIL++))
fi

# INVARIANT: Agent definition uses sonnet model
if grep -q "model:.*sonnet" "$AGENT_FILE" 2>/dev/null; then
  echo "  PASS: uses sonnet model"
  ((PASS++))
else
  echo "  FAIL: does not use sonnet model"
  ((FAIL++))
fi

# INVARIANT: Agent definition does NOT include Agent tool (prevents sub-subagent spawning)
if grep -q "^tools:" "$AGENT_FILE" 2>/dev/null; then
  TOOLS_LINE=$(grep "^tools:" "$AGENT_FILE")
  if echo "$TOOLS_LINE" | grep -qv "Agent"; then
    echo "  PASS: tools line does not include Agent"
    ((PASS++))
  else
    echo "  FAIL: tools line includes Agent (sub-subagent risk)"
    echo "    tools: $TOOLS_LINE"
    ((FAIL++))
  fi
else
  echo "  FAIL: no tools line found"
  ((FAIL++))
fi

# INVARIANT: Agent definition includes Read, Grep, Glob, Bash
for tool in Read Grep Glob Bash; do
  if grep -q "$tool" "$AGENT_FILE" 2>/dev/null; then
    echo "  PASS: includes $tool"
    ((PASS++))
  else
    echo "  FAIL: missing $tool"
    ((FAIL++))
  fi
done

# INVARIANT: Agent has maxTurns set (prevents runaway)
if grep -q "maxTurns:" "$AGENT_FILE" 2>/dev/null; then
  echo "  PASS: maxTurns is set"
  ((PASS++))
else
  echo "  FAIL: maxTurns not set (runaway risk)"
  ((FAIL++))
fi


echo ""
echo "=== TS wrapper: STATE_DIR env var isolation ==="

# Verify that the TS wrapper (kaizen-reflect-ts.sh) respects STATE_DIR env var.
# This is the fix for kaizen #340: smoke tests should not pollute the real state dir.

TS_HOOK="$(dirname "$0")/../kaizen-reflect-ts.sh"
TS_ISOLATED_DIR="$TEST_STATE_DIR/ts-isolated"
mkdir -p "$TS_ISOLATED_DIR"

# Check that TS wrapper exists
if [ -f "$TS_HOOK" ]; then
  # Run the TS hook with an isolated STATE_DIR
  TS_INPUT=$(jq -n \
    --arg cmd "gh pr create --title 'test isolation' --body 'body'" \
    --arg out "https://github.com/Garsson-io/nanoclaw/pull/999" '{
    tool_name: "Bash",
    tool_input: { command: $cmd },
    tool_response: { stdout: $out, stderr: "", exit_code: 0 }
  }')

  TS_OUTPUT=$(echo "$TS_INPUT" | STATE_DIR="$TS_ISOLATED_DIR" SEND_TELEGRAM_IPC_DISABLED=true bash "$TS_HOOK" 2>/dev/null)
  TS_EXIT=$?

  # State file should go to isolated dir, NOT to /tmp/.pr-review-state
  ISOLATED_STATE_COUNT=$(find "$TS_ISOLATED_DIR" -name "pr-kaizen-*" 2>/dev/null | wc -l | tr -d ' ')
  REAL_STATE_LEAK=$(find /tmp/.pr-review-state -name "*nanoclaw_999" 2>/dev/null | wc -l | tr -d ' ')

  if [ "$ISOLATED_STATE_COUNT" -gt 0 ]; then
    echo "  PASS: TS hook wrote state to isolated dir"
    ((PASS++))
  else
    # TS wrapper may not be available (tsx not installed) — skip gracefully
    if [ "$TS_EXIT" -ne 0 ] && [ -z "$TS_OUTPUT" ]; then
      echo "  SKIP: TS wrapper not available (tsx may not be installed)"
    else
      echo "  FAIL: TS hook did not write state to isolated dir"
      ((FAIL++))
    fi
  fi

  if [ "$REAL_STATE_LEAK" -eq 0 ]; then
    echo "  PASS: no state leaked to real state dir"
    ((PASS++))
  else
    echo "  FAIL: state leaked to /tmp/.pr-review-state!"
    ((FAIL++))
    # Clean up the leak
    find /tmp/.pr-review-state -name "*nanoclaw_999" -delete 2>/dev/null
  fi

  rm -rf "$TS_ISOLATED_DIR"
else
  echo "  SKIP: kaizen-reflect-ts.sh not found"
fi

teardown
print_results
