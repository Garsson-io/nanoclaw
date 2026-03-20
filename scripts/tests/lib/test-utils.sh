#!/bin/bash
# Shared test utilities for infrastructure script tests (scripts/tests/).
#
# Provides assertion helpers, stderr-capturing test runner, and result reporting.
# Source from test files: source "$(dirname "$0")/lib/test-utils.sh"
#
# See also: .claude/kaizen/hooks/tests/test-helpers.sh (hook-specific test utils)
# The two are separate because hooks tests need mock gh/git setup, PR state
# helpers, and harness integration that infrastructure tests don't.

set -u

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
    ((FAIL++))
  fi
}

assert_true() {
  local test_name="$1"
  local condition="$2"
  if eval "$condition"; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name"
    echo "    condition was false: $condition"
    ((FAIL++))
  fi
}

# Run a command, capture stdout/stderr/exit separately.
# Usage: run_capturing COMMAND [ARGS...]
# Sets: RUN_OUTPUT, RUN_STDERR, RUN_EXIT
run_capturing() {
  local stderr_file
  stderr_file=$(mktemp)
  RUN_EXIT=0
  RUN_OUTPUT=$("$@" 2>"$stderr_file") || RUN_EXIT=$?
  RUN_STDERR=$(<"$stderr_file")
  rm -f "$stderr_file"
}

# Assert no shell/script errors in RUN_STDERR (set by run_capturing).
# Known-benign stderr (git warnings, cli-kaizen resolution) is allowed.
# Shell errors (syntax error, arithmetic, unbound variable, etc.) cause failure.
SCRIPT_ERROR_PATTERN='syntax error|bad substitution|unbound variable|command not found|arithmetic|not a valid identifier|unexpected token'
assert_no_script_errors() {
  local test_name="$1"
  if echo "$RUN_STDERR" | grep -qiE "$SCRIPT_ERROR_PATTERN"; then
    echo "  FAIL: $test_name — script errors on stderr"
    echo "    stderr: $RUN_STDERR"
    ((FAIL++))
  else
    echo "  PASS: $test_name"
    ((PASS++))
  fi
}

# Print final results and exit with appropriate code.
# Call at the end of every test file.
print_results() {
  echo ""
  echo "================================"
  echo "Results: $PASS passed, $FAIL failed"
  if [ "$FAIL" -gt 0 ]; then
    exit 1
  fi
  echo "All tests passed."
}
