#!/bin/bash
# Shared test helpers for hook tests.
# Source from test files: source "$(dirname "$0")/test-helpers.sh"

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

# Assert a function returns success (exit 0)
assert_ok() {
  local test_name="$1"
  shift
  if "$@" 2>/dev/null; then
    echo "  PASS: $test_name"
    ((PASS++))
  else
    echo "  FAIL: $test_name"
    echo "    expected success, got failure"
    ((FAIL++))
  fi
}

# Assert a function returns failure (non-zero exit)
assert_fails() {
  local test_name="$1"
  shift
  if "$@" 2>/dev/null; then
    echo "  FAIL: $test_name"
    echo "    expected failure, got success"
    ((FAIL++))
  else
    echo "  PASS: $test_name"
    ((PASS++))
  fi
}

# Print final results and exit with appropriate code
print_results() {
  echo ""
  echo "================================"
  echo "Results: $PASS passed, $FAIL failed"
  if [ "$FAIL" -gt 0 ]; then
    exit 1
  fi
  echo "All tests passed."
}
