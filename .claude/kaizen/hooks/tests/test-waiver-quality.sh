#!/bin/bash
# Tests for waiver quality enforcement in pr-kaizen-clear.sh (kaizen #280, #258, #198)
#
# INVARIANT UNDER TEST: Waivers with known-bad rationalization patterns are
# rejected. Meta-findings waived without impact_minutes are rejected.
# Meta-findings with high impact (>= 5 min/occurrence) cannot be waived.
# All waivers are logged to audit/waiver.log.
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

PR_URL="https://github.com/Garsson-io/nanoclaw/pull/42"

# ============================================================
# Blocklist enforcement tests
# ============================================================

echo "=== Waiver with 'low frequency' reason is BLOCKED ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"stacked PR gate confusion\", \"disposition\": \"waived\", \"reason\": \"low frequency — only happens when multiple PRs merge in the same session\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "stacked PR gate confusion", "disposition": "waived", "reason": "low frequency — only happens when multiple PRs merge in the same session"}]')

if has_pr_kaizen_state; then
  echo "  PASS: waiver with 'low frequency' blocked"
  ((PASS++))
else
  echo "  FAIL: waiver with 'low frequency' incorrectly cleared gate"
  ((FAIL++))
fi
assert_contains "mentions blocklisted rationalization" "blocklisted rationalization" "$OUTPUT"
assert_contains "mentions 'low frequency'" "low frequency" "$OUTPUT"

echo ""
echo "=== Waiver with 'overengineering' reason is BLOCKED ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"hook state cleanup\", \"disposition\": \"waived\", \"reason\": \"overengineering for a simple PR\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "hook state cleanup", "disposition": "waived", "reason": "overengineering for a simple PR"}]')

if has_pr_kaizen_state; then
  echo "  PASS: waiver with 'overengineering' blocked"
  ((PASS++))
else
  echo "  FAIL: waiver with 'overengineering' incorrectly cleared gate"
  ((FAIL++))
fi
assert_contains "mentions blocklisted" "blocklisted" "$OUTPUT"

echo ""
echo "=== Waiver with 'self-correcting' reason is BLOCKED ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"agents skip verification\", \"disposition\": \"waived\", \"reason\": \"self-correcting — agents learn from mistakes\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "agents skip verification", "disposition": "waived", "reason": "self-correcting — agents learn from mistakes"}]')

if has_pr_kaizen_state; then
  echo "  PASS: waiver with 'self-correcting' blocked"
  ((PASS++))
else
  echo "  FAIL: waiver with 'self-correcting' incorrectly cleared gate"
  ((FAIL++))
fi
assert_contains "mentions blocklisted" "blocklisted" "$OUTPUT"

echo ""
echo "=== Waiver with 'edge case' reason is BLOCKED ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"state file collision\", \"disposition\": \"waived\", \"reason\": \"edge case that rarely matters\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "state file collision", "disposition": "waived", "reason": "edge case that rarely matters"}]')

if has_pr_kaizen_state; then
  echo "  PASS: waiver with 'edge case' blocked"
  ((PASS++))
else
  echo "  FAIL: waiver with 'edge case' incorrectly cleared gate"
  ((FAIL++))
fi
assert_contains "mentions blocklisted" "blocklisted" "$OUTPUT"

echo ""
echo "=== Waiver with 'not worth' reason is BLOCKED ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"missing test\", \"disposition\": \"waived\", \"reason\": \"not worth the effort for this change\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "missing test", "disposition": "waived", "reason": "not worth the effort for this change"}]')

if has_pr_kaizen_state; then
  echo "  PASS: waiver with 'not worth' blocked"
  ((PASS++))
else
  echo "  FAIL: waiver with 'not worth' incorrectly cleared gate"
  ((FAIL++))
fi

echo ""
echo "=== Waiver with case-insensitive blocklist match is BLOCKED ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"something\", \"disposition\": \"waived\", \"reason\": \"Unlikely To Recur based on context\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "something", "disposition": "waived", "reason": "Unlikely To Recur based on context"}]')

if has_pr_kaizen_state; then
  echo "  PASS: case-insensitive blocklist match blocked"
  ((PASS++))
else
  echo "  FAIL: case-insensitive blocklist match incorrectly cleared gate"
  ((FAIL++))
fi

# ============================================================
# Valid waiver tests (should pass)
# ============================================================

echo ""
echo "=== Waiver with legitimate reason PASSES ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"test output noisy\", \"disposition\": \"waived\", \"reason\": \"cosmetic — no agent/human time lost, just visual noise in test output\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "test output noisy", "disposition": "waived", "reason": "cosmetic — no agent/human time lost, just visual noise in test output"}]')

if ! has_pr_kaizen_state; then
  echo "  PASS: legitimate waiver cleared gate"
  ((PASS++))
else
  echo "  FAIL: legitimate waiver did NOT clear gate"
  ((FAIL++))
fi
assert_contains "output mentions gate cleared" "gate cleared" "$OUTPUT"

echo ""
echo "=== Mixed: filed + valid waiver PASSES ==="

setup
create_pr_kaizen_state "$PR_URL"

MIXED_JSON='[
  {"impediment": "hook confusion", "disposition": "filed", "ref": "#280"},
  {"impediment": "cosmetic log noise", "disposition": "waived", "reason": "purely visual, no time impact"}
]'

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
$MIXED_JSON
IMPEDIMENTS" \
  "KAIZEN_IMPEDIMENTS:
$MIXED_JSON")

if ! has_pr_kaizen_state; then
  echo "  PASS: mixed filed + valid waiver cleared gate"
  ((PASS++))
else
  echo "  FAIL: mixed filed + valid waiver did NOT clear gate"
  ((FAIL++))
fi

echo ""
echo "=== Mixed: filed + blocklisted waiver is BLOCKED ==="

setup
create_pr_kaizen_state "$PR_URL"

MIXED_BAD='[
  {"impediment": "hook confusion", "disposition": "filed", "ref": "#280"},
  {"impediment": "state accumulation", "disposition": "waived", "reason": "low frequency issue, not critical"}
]'

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
$MIXED_BAD
IMPEDIMENTS" \
  "KAIZEN_IMPEDIMENTS:
$MIXED_BAD")

if has_pr_kaizen_state; then
  echo "  PASS: mixed filed + blocklisted waiver blocked"
  ((PASS++))
else
  echo "  FAIL: mixed filed + blocklisted waiver incorrectly cleared"
  ((FAIL++))
fi

# ============================================================
# Meta-finding impact_minutes enforcement
# ============================================================

echo ""
echo "=== Meta-finding waived WITHOUT impact_minutes is BLOCKED ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"finding\": \"kaizen system lacks self-audit\", \"type\": \"meta\", \"disposition\": \"waived\", \"reason\": \"addressed in separate session\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"finding": "kaizen system lacks self-audit", "type": "meta", "disposition": "waived", "reason": "addressed in separate session"}]')

if has_pr_kaizen_state; then
  echo "  PASS: meta-finding without impact_minutes blocked"
  ((PASS++))
else
  echo "  FAIL: meta-finding without impact_minutes incorrectly cleared gate"
  ((FAIL++))
fi
assert_contains "mentions impact_minutes" "impact_minutes" "$OUTPUT"

echo ""
echo "=== Meta-finding waived with HIGH impact_minutes (>= 5) is BLOCKED ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"finding\": \"agents waste 10 min per waiver review\", \"type\": \"meta\", \"disposition\": \"waived\", \"reason\": \"will fix later\", \"impact_minutes\": 10}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"finding": "agents waste 10 min per waiver review", "type": "meta", "disposition": "waived", "reason": "will fix later", "impact_minutes": 10}]')

if has_pr_kaizen_state; then
  echo "  PASS: high-impact meta-finding waiver blocked"
  ((PASS++))
else
  echo "  FAIL: high-impact meta-finding waiver incorrectly cleared gate"
  ((FAIL++))
fi
assert_contains "mentions impact too high" "too high to waive" "$OUTPUT"

echo ""
echo "=== Meta-finding waived with LOW impact_minutes (< 5) PASSES ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"finding\": \"test output verbose\", \"type\": \"meta\", \"disposition\": \"waived\", \"reason\": \"cosmetic only, no time lost\", \"impact_minutes\": 1}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"finding": "test output verbose", "type": "meta", "disposition": "waived", "reason": "cosmetic only, no time lost", "impact_minutes": 1}]')

if ! has_pr_kaizen_state; then
  echo "  PASS: low-impact meta-finding waiver cleared gate"
  ((PASS++))
else
  echo "  FAIL: low-impact meta-finding waiver did NOT clear gate"
  ((FAIL++))
fi

echo ""
echo "=== Meta-finding waived with impact_minutes exactly 5 is BLOCKED ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"finding\": \"borderline impact\", \"type\": \"meta\", \"disposition\": \"waived\", \"reason\": \"maybe worth filing\", \"impact_minutes\": 5}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"finding": "borderline impact", "type": "meta", "disposition": "waived", "reason": "maybe worth filing", "impact_minutes": 5}]')

if has_pr_kaizen_state; then
  echo "  PASS: meta-finding with impact_minutes=5 blocked (boundary)"
  ((PASS++))
else
  echo "  FAIL: meta-finding with impact_minutes=5 incorrectly cleared gate"
  ((FAIL++))
fi

echo ""
echo "=== Meta-finding with impact_minutes=4 PASSES ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"finding\": \"minor friction\", \"type\": \"meta\", \"disposition\": \"waived\", \"reason\": \"brief delay, resolved quickly\", \"impact_minutes\": 4}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"finding": "minor friction", "type": "meta", "disposition": "waived", "reason": "brief delay, resolved quickly", "impact_minutes": 4}]')

if ! has_pr_kaizen_state; then
  echo "  PASS: meta-finding with impact_minutes=4 cleared gate"
  ((PASS++))
else
  echo "  FAIL: meta-finding with impact_minutes=4 did NOT clear gate"
  ((FAIL++))
fi

# ============================================================
# Non-meta impediments don't require impact_minutes
# ============================================================

echo ""
echo "=== Regular impediment waived without impact_minutes PASSES ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"slow build\", \"disposition\": \"waived\", \"reason\": \"one-time occurrence due to cache miss\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "slow build", "disposition": "waived", "reason": "one-time occurrence due to cache miss"}]')

if ! has_pr_kaizen_state; then
  echo "  PASS: regular impediment waiver without impact_minutes cleared"
  ((PASS++))
else
  echo "  FAIL: regular impediment waiver without impact_minutes blocked"
  ((FAIL++))
fi

# ============================================================
# Waiver audit logging
# ============================================================

echo ""
echo "=== Waiver is logged to audit/waiver.log ==="

setup
create_pr_kaizen_state "$PR_URL"

HOOK_REAL_DIR="$(cd "$(dirname "$HOOK")" && pwd)"
TEST_WAIVER_LOG="${HOOK_REAL_DIR}/../audit/waiver.log"
rm -f "$TEST_WAIVER_LOG"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"test for audit\", \"disposition\": \"waived\", \"reason\": \"cosmetic only, no impact\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "test for audit", "disposition": "waived", "reason": "cosmetic only, no impact"}]')

if [ -f "$TEST_WAIVER_LOG" ]; then
  WAIVER_CONTENT=$(cat "$TEST_WAIVER_LOG")
  if echo "$WAIVER_CONTENT" | grep -q "test for audit"; then
    echo "  PASS: waiver logged with description"
    ((PASS++))
  else
    echo "  FAIL: waiver log missing description"
    echo "    content: $WAIVER_CONTENT"
    ((FAIL++))
  fi
  if echo "$WAIVER_CONTENT" | grep -q "cosmetic only"; then
    echo "  PASS: waiver logged with reason"
    ((PASS++))
  else
    echo "  FAIL: waiver log missing reason"
    echo "    content: $WAIVER_CONTENT"
    ((FAIL++))
  fi
else
  echo "  FAIL: waiver log file not created"
  echo "    expected at: $TEST_WAIVER_LOG"
  ((FAIL++))
  ((FAIL++))
fi

# Clean up
rm -f "$TEST_WAIVER_LOG"

# ============================================================
# Error message quality
# ============================================================

echo ""
echo "=== Blocklist rejection includes helpful guidance ==="

setup
create_pr_kaizen_state "$PR_URL"

OUTPUT=$(run_posttool_bash \
  "echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[{\"impediment\": \"test thing\", \"disposition\": \"waived\", \"reason\": \"too much effort to file\"}]
IMPEDIMENTS" \
  'KAIZEN_IMPEDIMENTS:
[{"impediment": "test thing", "disposition": "waived", "reason": "too much effort to file"}]')

assert_contains "mentions kaizen #280" "kaizen #280" "$OUTPUT"
assert_contains "mentions filing takes 2 min" "2 min" "$OUTPUT"
assert_contains "mentions gh issue create" "gh issue create" "$OUTPUT"

# ============================================================
# Done
# ============================================================

cleanup_test_env
print_results
