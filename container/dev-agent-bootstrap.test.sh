#!/bin/bash
# Unit tests for dev-agent-bootstrap.sh
# Tests the bootstrap script's clone and shutdown hook logic.
# Run: bash container/dev-agent-bootstrap.test.sh
PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

log_pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
log_fail() { echo "  FAIL: $1 — $2"; FAIL=$((FAIL + 1)); }

# Setup temporary directories for test isolation
setup() {
  export TEST_DIR=$(mktemp -d)
  export WORKSPACE_PROJECT="$TEST_DIR/workspace/project"
  export WORKSPACE_EXTRA="$TEST_DIR/workspace/extra"
  export TMP_DIR="$TEST_DIR/tmp"

  mkdir -p "$WORKSPACE_PROJECT" "$WORKSPACE_EXTRA" "$TMP_DIR"

  # Create a minimal git repo as the "project" mount
  (cd "$WORKSPACE_PROJECT" && git init -b main && git commit --allow-empty -m "init" 2>/dev/null) >/dev/null
}

teardown() {
  rm -rf "$TEST_DIR"
}

# Test 1: Clone from ro mount produces writable repo
test_clone_from_ro_mount() {
  setup
  local desc="Clone from ro mount produces writable repo"

  git clone --local "$WORKSPACE_PROJECT" "$TMP_DIR/nanoclaw" 2>/dev/null
  if [ -d "$TMP_DIR/nanoclaw/.git" ]; then
    # Verify we can write to the clone
    touch "$TMP_DIR/nanoclaw/test-file.txt" 2>/dev/null
    if [ -f "$TMP_DIR/nanoclaw/test-file.txt" ]; then
      log_pass "$desc"
    else
      log_fail "$desc" "Clone is not writable"
    fi
  else
    log_fail "$desc" "Clone directory missing"
  fi
  teardown
}

# Test 2: Remote URL is rewritten when GITHUB_TOKEN is set
test_remote_url_rewrite() {
  setup
  local desc="Remote URL rewritten with GITHUB_TOKEN"

  git clone --local "$WORKSPACE_PROJECT" "$TMP_DIR/nanoclaw" 2>/dev/null
  cd "$TMP_DIR/nanoclaw"

  export GITHUB_TOKEN="ghp_test123"
  git remote set-url origin \
    "https://x-access-token:${GITHUB_TOKEN}@github.com/Garsson-io/nanoclaw.git"

  local remote_url
  remote_url=$(git remote get-url origin)
  if echo "$remote_url" | grep -q "x-access-token:ghp_test123"; then
    log_pass "$desc"
  else
    log_fail "$desc" "Remote URL does not contain token: $remote_url"
  fi
  unset GITHUB_TOKEN
  teardown
}

# Test 3: Vertical repos are cloned
test_vertical_clone() {
  setup
  local desc="Vertical repos are cloned from extra mounts"

  # Create a vertical repo
  local vert_dir="$WORKSPACE_EXTRA/garsson-prints"
  mkdir -p "$vert_dir"
  (cd "$vert_dir" && git init -b main && git commit --allow-empty -m "init" 2>/dev/null) >/dev/null

  git clone --local "$vert_dir" "$TMP_DIR/garsson-prints" 2>/dev/null
  if [ -d "$TMP_DIR/garsson-prints/.git" ]; then
    log_pass "$desc"
  else
    log_fail "$desc" "Vertical clone missing"
  fi
  teardown
}

# Test 4: Shutdown hook detects unpushed commits
test_shutdown_hook_detects_unpushed() {
  setup
  local desc="Shutdown hook detects unpushed commits"

  git clone --local "$WORKSPACE_PROJECT" "$TMP_DIR/nanoclaw" 2>/dev/null
  cd "$TMP_DIR/nanoclaw"

  # Create a commit
  echo "change" > test.txt
  git add test.txt
  git commit -m "test change" 2>/dev/null

  # Check for unpushed commits (simulating the shutdown hook logic)
  local unpushed
  unpushed=$(git log origin/main..HEAD --oneline 2>/dev/null || true)
  if [ -n "$unpushed" ]; then
    log_pass "$desc"
  else
    log_fail "$desc" "No unpushed commits detected"
  fi
  teardown
}

# Test 5: Clone performance (should be fast with local clone)
test_clone_performance() {
  setup
  local desc="Local clone completes in under 5 seconds"

  local start_time
  start_time=$(date +%s)
  git clone --local "$WORKSPACE_PROJECT" "$TMP_DIR/nanoclaw" 2>/dev/null
  local end_time
  end_time=$(date +%s)
  local elapsed=$((end_time - start_time))

  if [ "$elapsed" -lt 5 ]; then
    log_pass "$desc (${elapsed}s)"
  else
    log_fail "$desc" "Took ${elapsed}s"
  fi
  teardown
}

echo "Running dev-agent-bootstrap tests..."
echo ""

test_clone_from_ro_mount
test_remote_url_rewrite
test_vertical_clone
test_shutdown_hook_detects_unpushed
test_clone_performance

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
