#!/bin/bash
# Tests for per-PR reflection tracking (kaizen #288)
# Verifies that reflection markers prevent repeated gate prompts
# for the same PR across create/merge events.
#
# INVARIANT UNDER TEST: After kaizen reflection is submitted for a PR,
# subsequent events (merge, cleanup) do NOT re-gate the agent.
source "$(dirname "$0")/test-helpers.sh"

REFLECT_HOOK="$(dirname "$0")/../kaizen-reflect.sh"
CLEAR_HOOK="$(dirname "$0")/../pr-kaizen-clear.sh"
ENFORCE_HOOK="$(dirname "$0")/../enforce-pr-kaizen.sh"
setup_test_env

setup() { reset_state; }
teardown() { reset_state; }

PR_URL="https://github.com/Garsson-io/nanoclaw/pull/99"

# Helper: simulate gh pr create
run_reflect_create() {
  local pr_url="$1"
  local input
  input=$(jq -n \
    --arg cmd "gh pr create --title 'test' --body 'body'" \
    --arg out "$pr_url" '{
    tool_name: "Bash",
    tool_input: { command: $cmd },
    tool_response: { stdout: $out, stderr: "", exit_code: 0 }
  }')
  echo "$input" | bash "$REFLECT_HOOK" 2>/dev/null
}

# Helper: simulate gh pr merge
run_reflect_merge() {
  local pr_url="$1"
  local input
  input=$(jq -n \
    --arg cmd "gh pr merge $pr_url --squash --delete-branch" \
    --arg out "Merged" '{
    tool_name: "Bash",
    tool_input: { command: $cmd },
    tool_response: { stdout: $out, stderr: "", exit_code: 0 }
  }')
  echo "$input" | bash "$REFLECT_HOOK" 2>/dev/null
}

# Helper: submit KAIZEN_IMPEDIMENTS to clear gate
run_clear_impediments() {
  local input
  input=$(jq -n '{
    tool_name: "Bash",
    tool_input: { command: "echo '\''KAIZEN_IMPEDIMENTS: [] clean implementation, no issues'\''" },
    tool_response: { stdout: "KAIZEN_IMPEDIMENTS: [] clean implementation, no issues", stderr: "", exit_code: 0 }
  }')
  echo "$input" | bash "$CLEAR_HOOK" 2>/dev/null
}

# Helper: check if kaizen state file exists
has_pr_kaizen_state() {
  local count
  count=$(find "$STATE_DIR" -name "pr-kaizen-*" 2>/dev/null | wc -l)
  [ "$count" -gt 0 ]
}

# Helper: check if reflection marker exists
has_reflection_marker() {
  local count
  count=$(find "$STATE_DIR" -name "kaizen-done-*" 2>/dev/null | wc -l)
  [ "$count" -gt 0 ]
}

# Helper: run the PreToolUse hook with a command
run_pretool_hook() {
  local command="$1"
  local input
  input=$(jq -n --arg cmd "$command" '{"tool_input":{"command":$cmd}}')
  echo "$input" | bash "$ENFORCE_HOOK" 2>/dev/null
}

echo "=== PR create sets gate (baseline) ==="

setup
OUTPUT=$(run_reflect_create "$PR_URL")
if has_pr_kaizen_state; then
  echo "  PASS: PR create sets kaizen gate state"
  ((PASS++))
else
  echo "  FAIL: PR create did NOT set kaizen gate state"
  ((FAIL++))
fi
assert_contains "reflect prompt shown" "KAIZEN REFLECTION" "$OUTPUT"

echo ""
echo "=== Clearing gate writes reflection marker ==="

setup
run_reflect_create "$PR_URL" >/dev/null
OUTPUT=$(run_clear_impediments)
assert_contains "gate cleared" "gate cleared" "$OUTPUT"

if has_reflection_marker; then
  echo "  PASS: clearing gate writes reflection marker"
  ((PASS++))
else
  echo "  FAIL: clearing gate did NOT write reflection marker"
  ((FAIL++))
fi

echo ""
echo "=== After reflection done, PR create for same PR skips gate ==="

setup
# Simulate: create PR, submit reflection, then somehow create same PR again
run_reflect_create "$PR_URL" >/dev/null
run_clear_impediments >/dev/null

# Now simulate another create for same PR — should be skipped
OUTPUT=$(run_reflect_create "$PR_URL")
assert_eq "second create skipped (no output)" "" "$OUTPUT"

echo ""
echo "=== After reflection done, PR merge skips gate but shows post-merge steps ==="

setup
# Simulate: create PR, submit reflection
run_reflect_create "$PR_URL" >/dev/null
run_clear_impediments >/dev/null

# Now merge — should skip gate but show post-merge reminder
OUTPUT=$(run_reflect_merge "$PR_URL")
assert_contains "merge shows already-completed message" "Already completed" "$OUTPUT"
assert_not_contains "merge does NOT show gate block" "GATED" "$OUTPUT"
assert_contains "merge shows post-merge steps" "post-merge" "$OUTPUT"

# Verify no new gate state was created
if ! has_pr_kaizen_state; then
  echo "  PASS: no new kaizen gate state after skipped merge"
  ((PASS++))
else
  echo "  FAIL: new kaizen gate state created after merge (should be skipped)"
  ((FAIL++))
fi

echo ""
echo "=== After reflection done, enforce hook does not block ==="

setup
# Create gate, clear it
run_reflect_create "$PR_URL" >/dev/null
run_clear_impediments >/dev/null

# Gate is cleared, commands should pass
OUTPUT=$(run_pretool_hook "npm run build")
assert_eq "commands pass after gate cleared" "" "$OUTPUT"

echo ""
echo "=== Without reflection, merge still gates ==="

setup
# Directly merge without prior reflection
OUTPUT=$(run_reflect_merge "$PR_URL")
assert_contains "merge without prior reflection shows gate" "GATED" "$OUTPUT"
if has_pr_kaizen_state; then
  echo "  PASS: merge without prior reflection sets gate"
  ((PASS++))
else
  echo "  FAIL: merge without prior reflection did NOT set gate"
  ((FAIL++))
fi

echo ""
echo "=== Different PR URLs are tracked independently ==="

setup
PR_URL2="https://github.com/Garsson-io/nanoclaw/pull/100"

# Reflect on PR #99
run_reflect_create "$PR_URL" >/dev/null
run_clear_impediments >/dev/null

# PR #100 should still gate
OUTPUT=$(run_reflect_create "$PR_URL2")
assert_contains "different PR still gates" "KAIZEN REFLECTION" "$OUTPUT"

echo ""
echo "=== Stale marker is ignored ==="

setup
# Create a reflected marker, then backdate it
run_reflect_create "$PR_URL" >/dev/null
run_clear_impediments >/dev/null

# Backdate the marker to make it stale
MARKER_FILE=$(find "$STATE_DIR" -name "kaizen-done-*" | head -1)
if [ -n "$MARKER_FILE" ]; then
  backdate_file "$MARKER_FILE" 3
fi

# After marker is stale, gate should fire again
OUTPUT=$(run_reflect_create "$PR_URL")
assert_contains "stale marker allows re-gating" "KAIZEN REFLECTION" "$OUTPUT"

echo ""
echo "=== Cross-worktree: marker from other branch is ignored ==="

setup
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

# Create a marker as if from another branch
source "$(dirname "$0")/../lib/state-utils.sh"
KEY=$(pr_url_to_state_key "$PR_URL")
mkdir -p "$STATE_DIR"
printf 'PR_URL=%s\nBRANCH=%s\nTIMESTAMP=%s\nSTATUS=reflected\n' \
  "$PR_URL" "wt/other-branch" "$(date +%s)" > "$STATE_DIR/kaizen-done-$KEY"

# Gate should still fire because marker is from different branch
OUTPUT=$(run_reflect_create "$PR_URL")
assert_contains "other branch marker allows gating" "KAIZEN REFLECTION" "$OUTPUT"

teardown
print_results
