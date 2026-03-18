#!/bin/bash
# Tests for enforce-post-merge-stop.sh — Stop hook that blocks Claude from
# stopping when post-merge workflow steps are pending.
#
# INVARIANT UNDER TEST: Claude cannot finish its response while
# STATUS=needs_post_merge exists for the current branch.
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../enforce-post-merge-stop.sh"
setup_test_env

setup() { reset_state; }
teardown() { reset_state; }

run_stop_hook() {
  local input
  input=$(jq -n '{
    session_id: "test-session",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "PR merged successfully"
  }')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

echo "=== No post-merge state: stop allowed ==="

setup

# INVARIANT: When no post-merge state files exist, Claude can stop freely
# SUT: enforce-post-merge-stop.sh with empty STATE_DIR
OUTPUT=$(run_stop_hook)
if [ -z "$OUTPUT" ]; then
  echo "  PASS: stop allowed with no post-merge state"
  ((PASS++))
else
  echo "  FAIL: stop blocked with no post-merge state"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== Active post-merge (needs_post_merge): stop blocked ==="

setup
create_post_merge_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: When STATUS=needs_post_merge, Claude cannot stop
# SUT: enforce-post-merge-stop.sh block logic
OUTPUT=$(run_stop_hook)
if is_blocked "$OUTPUT"; then
  echo "  PASS: stop blocked during pending post-merge workflow"
  ((PASS++))
else
  echo "  FAIL: stop NOT blocked during pending post-merge workflow"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

# INVARIANT: Block reason includes PR URL and /kaizen instruction
REASON=$(echo "$OUTPUT" | jq -r '.reason // empty')
assert_contains "block reason includes PR URL" "nanoclaw/pull/42" "$REASON"
assert_contains "block reason mentions /kaizen" "kaizen" "$REASON"

echo ""
echo "=== Awaiting merge (--auto): stop allowed ==="

setup
create_post_merge_state "https://github.com/Garsson-io/nanoclaw/pull/42" "awaiting_merge"

# INVARIANT: awaiting_merge state does NOT block stop — merge hasn't happened yet
# SUT: enforce-post-merge-stop.sh only blocks on needs_post_merge, not awaiting_merge
OUTPUT=$(run_stop_hook)
if [ -z "$OUTPUT" ]; then
  echo "  PASS: stop allowed during awaiting_merge (merge not confirmed)"
  ((PASS++))
else
  echo "  FAIL: stop blocked during awaiting_merge"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== Cross-worktree isolation: other branch's post-merge does not block ==="

setup
create_post_merge_state "https://github.com/Garsson-io/nanoclaw/pull/55" "needs_post_merge" "wt/other-worktree-branch"

# INVARIANT: A needs_post_merge state from a different branch does NOT block stop
# SUT: enforce-post-merge-stop.sh branch filtering via state-utils.sh
OUTPUT=$(run_stop_hook)
if [ -z "$OUTPUT" ]; then
  echo "  PASS: other branch's post-merge state does not block stop"
  ((PASS++))
else
  echo "  FAIL: other branch's post-merge state is blocking stop"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== Stale state files do not block stop ==="

setup
create_post_merge_state "https://github.com/Garsson-io/nanoclaw/pull/60"
STATE_FILE="$STATE_DIR/post-merge-Garsson-io_nanoclaw_60"
backdate_file "$STATE_FILE" 3

# INVARIANT: State files older than MAX_STATE_AGE are treated as stale
# SUT: enforce-post-merge-stop.sh via state-utils.sh staleness check
OUTPUT=$(MAX_STATE_AGE=7200 run_stop_hook)
if [ -z "$OUTPUT" ]; then
  echo "  PASS: stale post-merge state does not block stop"
  ((PASS++))
else
  echo "  FAIL: stale post-merge state is blocking stop"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== PR review state (needs_review) does not trigger post-merge block ==="

setup
create_state "https://github.com/Garsson-io/nanoclaw/pull/42" "1" "needs_review"

# INVARIANT: PR review state files are irrelevant to post-merge enforcement
# SUT: enforce-post-merge-stop.sh only looks for needs_post_merge status
OUTPUT=$(run_stop_hook)
if [ -z "$OUTPUT" ]; then
  echo "  PASS: PR review state does not trigger post-merge block"
  ((PASS++))
else
  echo "  FAIL: PR review state is triggering post-merge block"
  echo "    output: $OUTPUT"
  ((FAIL++))
fi

echo ""
echo "=== JSON output is valid ==="

setup
create_post_merge_state "https://github.com/Garsson-io/nanoclaw/pull/42"

# INVARIANT: Hook output is valid JSON with required fields
# SUT: enforce-post-merge-stop.sh JSON output format
OUTPUT=$(run_stop_hook)
DECISION=$(echo "$OUTPUT" | jq -r '.decision // empty')
REASON=$(echo "$OUTPUT" | jq -r '.reason // empty')

assert_eq "decision field is 'block'" "block" "$DECISION"
if [ -n "$REASON" ]; then
  echo "  PASS: reason field is non-empty"
  ((PASS++))
else
  echo "  FAIL: reason field is empty"
  ((FAIL++))
fi

teardown
print_results
