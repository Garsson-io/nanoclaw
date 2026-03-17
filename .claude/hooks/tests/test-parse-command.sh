#!/bin/bash
# Tests for lib/parse-command.sh shared utilities
# Run: bash .claude/hooks/tests/test-parse-command.sh
#
# INVARIANT: extract_pr_number returns ONLY the PR number from the correct
#   position in "gh pr <subcommand> <number>" — never from flags or other args.
# INVARIANT: get_pr_changed_files uses gh pr diff for merges, git diff for creates.
# SUT: lib/parse-command.sh functions (extract_pr_number, get_pr_changed_files)

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
source "$HOOKS_DIR/lib/parse-command.sh"

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

echo "=== extract_pr_number ==="

# Basic extraction
assert_eq "merge with PR number" \
  "42" \
  "$(extract_pr_number "gh pr merge 42" "merge")"

assert_eq "merge with PR number and flags" \
  "42" \
  "$(extract_pr_number "gh pr merge 42 --repo Garsson-io/nanoclaw" "merge")"

assert_eq "merge without PR number" \
  "" \
  "$(extract_pr_number "gh pr merge" "merge")"

assert_eq "merge without PR number but with flags" \
  "" \
  "$(extract_pr_number "gh pr merge --squash --repo Garsson-io/nanoclaw" "merge")"

# Should NOT match numbers from other flags
assert_eq "merge should not match repo numbers" \
  "" \
  "$(extract_pr_number "gh pr merge --delete-branch" "merge")"

# Different subcommands
assert_eq "view with PR number" \
  "99" \
  "$(extract_pr_number "gh pr view 99" "view")"

assert_eq "diff with PR number" \
  "7" \
  "$(extract_pr_number "gh pr diff 7 --name-only" "diff")"

# Multiple spaces
assert_eq "extra whitespace" \
  "123" \
  "$(extract_pr_number "gh  pr  merge  123" "merge")"

# Wrong subcommand should not match
assert_eq "create should not match merge pattern" \
  "" \
  "$(extract_pr_number "gh pr create --title foo" "merge")"

echo ""
echo "=== strip_heredoc_body ==="

assert_eq "simple command preserved" \
  "gh pr merge 42" \
  "$(strip_heredoc_body "gh pr merge 42")"

assert_eq "heredoc body stripped" \
  "gh pr create --title \"test\" --body \"\$(cat" \
  "$(strip_heredoc_body 'gh pr create --title "test" --body "$(cat
<<EOF
some body content
EOF
)"')"

echo ""
echo "=== is_gh_pr_command ==="

# Direct gh pr commands — should match
is_gh_pr_command "gh pr create --title test" "create" && \
  assert_eq "direct gh pr create matches" "0" "0" || \
  assert_eq "direct gh pr create matches" "0" "1"

is_gh_pr_command "gh pr merge 42" "merge" && \
  assert_eq "direct gh pr merge matches" "0" "0" || \
  assert_eq "direct gh pr merge matches" "0" "1"

is_gh_pr_command "gh pr merge 42 --repo Garsson-io/nanoclaw" "create|merge" && \
  assert_eq "merge matches create|merge" "0" "0" || \
  assert_eq "merge matches create|merge" "0" "1"

# After pipe — should match
is_gh_pr_command "npm build && gh pr create --title test" "create" && \
  assert_eq "gh pr create after && matches" "0" "0" || \
  assert_eq "gh pr create after && matches" "0" "1"

is_gh_pr_command "cat file | gh pr create" "create" && \
  assert_eq "gh pr create after pipe matches" "0" "0" || \
  assert_eq "gh pr create after pipe matches" "0" "1"

# FALSE POSITIVE: gh pr create inside echo/string — should NOT match
is_gh_pr_command "echo 'gh pr create' | bash hook.sh" "create" && \
  assert_eq "gh pr create inside echo should NOT match" "0" "1" || \
  assert_eq "gh pr create inside echo should NOT match" "0" "0"

is_gh_pr_command "echo '{\"command\":\"gh pr merge 42\"}' | bash -x hook.sh" "merge" && \
  assert_eq "gh pr merge inside JSON echo should NOT match" "0" "1" || \
  assert_eq "gh pr merge inside JSON echo should NOT match" "0" "0"

# Wrong subcommand — should NOT match
is_gh_pr_command "gh pr create --title test" "merge" && \
  assert_eq "create should not match merge" "0" "1" || \
  assert_eq "create should not match merge" "0" "0"

# git push — should NOT match gh pr
is_gh_pr_command "git push origin main" "create|merge" && \
  assert_eq "git push should not match gh pr" "0" "1" || \
  assert_eq "git push should not match gh pr" "0" "0"

echo ""
echo "=== get_pr_changed_files (with mocked gh/git) ==="

# Create temp dir with mock commands
MOCK_DIR=$(mktemp -d)
trap 'rm -rf "$MOCK_DIR"' EXIT

# Mock gh that returns known file list
cat > "$MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
# Simulate gh pr diff --name-only
if echo "$@" | grep -q "pr diff"; then
  echo "src/index.ts"
  echo "src/config.ts"
  exit 0
fi
exit 1
MOCK
chmod +x "$MOCK_DIR/gh"

# Mock git that returns a different (larger) file list — simulating dirty worktree
cat > "$MOCK_DIR/git" << 'MOCK'
#!/bin/bash
if echo "$@" | grep -q "diff --name-only"; then
  echo "src/index.ts"
  echo "src/config.ts"
  echo "src/unrelated-dirty-file.ts"
  echo ".claude/hooks/some-hook.sh"
  exit 0
fi
# Pass through other git commands
/usr/bin/git "$@"
MOCK
chmod +x "$MOCK_DIR/git"

# Test with mocks in PATH
export PATH="$MOCK_DIR:$PATH"

# For merge: should use gh pr diff (2 files), NOT git diff (4 files)
MERGE_FILES=$(get_pr_changed_files "gh pr merge 42" "true")
MERGE_COUNT=$(echo "$MERGE_FILES" | wc -l | tr -d ' ')
assert_eq "merge uses gh pr diff (2 files from PR)" \
  "2" \
  "$MERGE_COUNT"

DIRTY_COUNT=$(echo "$MERGE_FILES" | grep -c "unrelated-dirty-file" || true)
assert_eq "merge result does NOT contain unrelated dirty file" \
  "0" \
  "$DIRTY_COUNT"

# For create: should use git diff (4 files)
CREATE_FILES=$(get_pr_changed_files "gh pr create --title test" "false")
CREATE_COUNT=$(echo "$CREATE_FILES" | wc -l | tr -d ' ')
assert_eq "create uses git diff (4 files from worktree)" \
  "4" \
  "$CREATE_COUNT"

# Test fallback: gh fails, should fall back to git diff
cat > "$MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
exit 1
MOCK
chmod +x "$MOCK_DIR/gh"

FALLBACK_FILES=$(get_pr_changed_files "gh pr merge 42" "true" 2>/dev/null)
FALLBACK_COUNT=$(echo "$FALLBACK_FILES" | wc -l | tr -d ' ')
assert_eq "merge falls back to git diff when gh fails (4 files)" \
  "4" \
  "$FALLBACK_COUNT"

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "All tests passed."
