#!/bin/bash
# Unit tests for image-lib.sh
# Tests pure functions: sanitize_branch, detect_branch, find_project_root
# Run: bash container/image-lib.test.sh
PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

log_pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
log_fail() { echo "  FAIL: $1 — $2"; FAIL=$((FAIL + 1)); }

source "$SCRIPT_DIR/image-lib.sh"

# -- sanitize_branch tests --

echo "sanitize_branch:"

test_sanitize_simple_branch() {
  local desc="Simple branch name passes through"
  local result
  result=$(sanitize_branch "main")
  if [ "$result" = "main" ]; then
    log_pass "$desc"
  else
    log_fail "$desc" "Expected 'main', got '$result'"
  fi
}

test_sanitize_slash_to_dash() {
  local desc="Slashes are replaced with dashes"
  local result
  result=$(sanitize_branch "case/260319-k182-docker-lifecycle")
  if [ "$result" = "case-260319-k182-docker-lifecycle" ]; then
    log_pass "$desc"
  else
    log_fail "$desc" "Expected 'case-260319-k182-docker-lifecycle', got '$result'"
  fi
}

test_sanitize_nested_slashes() {
  local desc="Multiple slashes are all replaced"
  local result
  result=$(sanitize_branch "feature/user/auth/login")
  if [ "$result" = "feature-user-auth-login" ]; then
    log_pass "$desc"
  else
    log_fail "$desc" "Expected 'feature-user-auth-login', got '$result'"
  fi
}

test_sanitize_special_chars() {
  local desc="Special characters are stripped"
  local result
  result=$(sanitize_branch "feat@branch#1!name")
  if [ "$result" = "featbranch1name" ]; then
    log_pass "$desc"
  else
    log_fail "$desc" "Expected 'featbranch1name', got '$result'"
  fi
}

test_sanitize_dots_underscores_preserved() {
  local desc="Dots and underscores are preserved"
  local result
  result=$(sanitize_branch "v1.0_release")
  if [ "$result" = "v1.0_release" ]; then
    log_pass "$desc"
  else
    log_fail "$desc" "Expected 'v1.0_release', got '$result'"
  fi
}

test_sanitize_truncation() {
  local desc="Long names are truncated to 128 chars"
  local long_name
  long_name=$(printf 'a%.0s' {1..200})
  local result
  result=$(sanitize_branch "$long_name")
  local len=${#result}
  if [ "$len" -eq 128 ]; then
    log_pass "$desc"
  else
    log_fail "$desc" "Expected length 128, got $len"
  fi
}

test_sanitize_empty() {
  local desc="Empty input returns empty"
  local result
  result=$(sanitize_branch "")
  if [ -z "$result" ]; then
    log_pass "$desc"
  else
    log_fail "$desc" "Expected empty, got '$result'"
  fi
}

test_sanitize_typical_case_branch() {
  local desc="Typical case branch name sanitizes correctly"
  local result
  result=$(sanitize_branch "case/260319-1557-k182-docker-lifecycle")
  if [ "$result" = "case-260319-1557-k182-docker-lifecycle" ]; then
    log_pass "$desc"
  else
    log_fail "$desc" "Expected 'case-260319-1557-k182-docker-lifecycle', got '$result'"
  fi
}

# -- find_project_root tests --

echo ""
echo "find_project_root:"

test_find_project_root_from_container() {
  local desc="Finds project root from container/ directory"
  local result
  result=$(find_project_root "$SCRIPT_DIR")
  # The project root should contain package.json
  if [ -f "$result/package.json" ]; then
    log_pass "$desc"
  else
    log_fail "$desc" "No package.json at '$result'"
  fi
}

# -- calculate_soft_cap tests --

echo ""
echo "calculate_soft_cap:"

test_soft_cap_formula() {
  local desc="Soft cap is (active_cases + 1) * 2"
  # Override active_case_count to return a fixed value for testing
  active_case_count() { echo "3"; }
  local result
  result=$(calculate_soft_cap)
  if [ "$result" = "8" ]; then
    log_pass "$desc"
  else
    log_fail "$desc" "Expected 8, got '$result'"
  fi
}

test_soft_cap_zero_cases() {
  local desc="Soft cap with zero active cases is 2"
  active_case_count() { echo "0"; }
  local result
  result=$(calculate_soft_cap)
  if [ "$result" = "2" ]; then
    log_pass "$desc"
  else
    log_fail "$desc" "Expected 2, got '$result'"
  fi
}

test_soft_cap_one_case() {
  local desc="Soft cap with one active case is 4"
  active_case_count() { echo "1"; }
  local result
  result=$(calculate_soft_cap)
  if [ "$result" = "4" ]; then
    log_pass "$desc"
  else
    log_fail "$desc" "Expected 4, got '$result'"
  fi
}

# Run all tests
test_sanitize_simple_branch
test_sanitize_slash_to_dash
test_sanitize_nested_slashes
test_sanitize_special_chars
test_sanitize_dots_underscores_preserved
test_sanitize_truncation
test_sanitize_empty
test_sanitize_typical_case_branch
test_find_project_root_from_container
test_soft_cap_formula
test_soft_cap_zero_cases
test_soft_cap_one_case

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
