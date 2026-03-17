#!/bin/bash
# Tests for check-test-coverage.sh hook
# Run: bash .claude/hooks/tests/test-check-test-coverage.sh
#
# INVARIANT: For gh pr merge, the hook checks the ACTUAL PR diff (via gh pr diff),
#   not the local worktree diff (git diff). Unrelated dirty files in the worktree
#   must NOT cause false positive denials.
# INVARIANT: For gh pr create, the hook uses git diff (local branch vs base).
# INVARIANT: When no source files are changed, the hook allows the command (exit 0).
# INVARIANT: When source files are changed without tests, merge is denied with JSON.
# SUT: check-test-coverage.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
HOOK="$HOOKS_DIR/check-test-coverage.sh"

PASS=0
FAIL=0

assert_eq() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name"
    echo "    expected: '$expected'"
    echo "    actual:   '$actual'"
    ((FAIL++))
  fi
}

assert_contains() {
  local test_name="$1"
  local needle="$2"
  local haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name"
    echo "    expected to contain: '$needle'"
    echo "    actual: '$haystack'"
    ((FAIL++))
  fi
}

assert_not_contains() {
  local test_name="$1"
  local needle="$2"
  local haystack="$3"
  if ! echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name"
    echo "    expected NOT to contain: '$needle'"
    echo "    actual: '$haystack'"
    ((FAIL++))
  fi
}

# Create mock dir
MOCK_DIR=$(mktemp -d)
trap 'rm -rf "$MOCK_DIR"' EXIT

setup_mocks() {
  local gh_files="$1"
  local git_files="$2"

  cat > "$MOCK_DIR/gh" << MOCK
#!/bin/bash
if echo "\$@" | grep -q "pr diff"; then
  echo "$gh_files"
  exit 0
fi
exit 1
MOCK
  chmod +x "$MOCK_DIR/gh"

  cat > "$MOCK_DIR/git" << MOCK
#!/bin/bash
if echo "\$@" | grep -q "diff --name-only"; then
  echo "$git_files"
  exit 0
fi
/usr/bin/git "\$@"
MOCK
  chmod +x "$MOCK_DIR/git"
}

run_hook() {
  local command="$1"
  local input
  input=$(jq -n --arg cmd "$command" '{"tool_input":{"command":$cmd}}')
  echo "$input" | PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>/dev/null
}

run_hook_stderr() {
  local command="$1"
  local input
  input=$(jq -n --arg cmd "$command" '{"tool_input":{"command":$cmd}}')
  echo "$input" | PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>&1 1>/dev/null
}

echo "=== Non-PR commands are ignored ==="

OUTPUT=$(echo '{"tool_input":{"command":"npm run build"}}' | bash "$HOOK" 2>&1)
assert_eq "npm command exits silently" "" "$OUTPUT"

OUTPUT=$(echo '{"tool_input":{"command":"git push origin main"}}' | bash "$HOOK" 2>&1)
assert_eq "git push exits silently" "" "$OUTPUT"

echo ""
echo "=== Merge: PR with no source files → allow ==="

# PR only touches .claude/ files — no source files
setup_mocks ".claude/hooks/check-test-coverage.sh" "src/index.ts
src/unrelated.ts"

OUTPUT=$(run_hook "gh pr merge 42")
assert_eq "no src in PR diff → no output (allow)" "" "$OUTPUT"

echo ""
echo "=== Merge: PR with source + tests → allow ==="

setup_mocks "src/index.ts
src/index.test.ts" "src/index.ts
src/unrelated-dirty.ts"

OUTPUT=$(run_hook "gh pr merge 42")
assert_contains "src with matching test → allow message" "Test coverage check" "$(run_hook_stderr "gh pr merge 42")"

echo ""
echo "=== CRITICAL: Merge uses PR diff, not worktree diff ==="

# gh pr diff returns ONLY .claude/ files (no src)
# git diff returns src/index.ts (dirty worktree)
# Merge should use gh pr diff → no src files → allow
setup_mocks ".claude/hooks/some-hook.sh" "src/index.ts
src/config.ts"

OUTPUT=$(run_hook "gh pr merge 42")
assert_eq "merge with clean PR but dirty worktree → allow" "" "$OUTPUT"
assert_not_contains "merge should not see worktree src files" "deny" "$OUTPUT"

echo ""
echo "=== Merge: PR with untested source → deny ==="

setup_mocks "src/index.ts
src/config.ts" ""

OUTPUT=$(run_hook "gh pr merge 42")
assert_contains "untested source in PR → deny" "deny" "$OUTPUT"
assert_contains "deny message lists files" "Test coverage policy" "$OUTPUT"

echo ""
echo "=== Create: uses git diff (local) ==="

# For create, the gh mock shouldn't matter — it should use git diff
setup_mocks "" "src/new-feature.ts"

OUTPUT=$(run_hook_stderr "gh pr create --title test --body 'test'")
assert_contains "create sees local git diff files" "Test coverage policy" "$OUTPUT"

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "All tests passed."
