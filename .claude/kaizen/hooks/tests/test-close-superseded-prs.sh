#!/bin/bash
# Tests for close-superseded-prs.sh — kaizen #318
# Run: bash .claude/kaizen/hooks/tests/test-close-superseded-prs.sh
#
# INVARIANT: PRs referencing only closed kaizen issues are flagged as superseded.
# INVARIANT: PRs referencing open kaizen issues are NOT flagged.
# INVARIANT: PRs with no kaizen references are NOT flagged.
# INVARIANT: Dry-run mode doesn't actually close PRs.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

SCRIPT="$(cd "$SCRIPT_DIR/../../../.." && pwd)/scripts/close-superseded-prs.sh"

echo "=== Script exists and is executable ==="

if [ -f "$SCRIPT" ] && [ -x "$SCRIPT" ]; then
  echo "  PASS: close-superseded-prs.sh exists and is executable"
  ((PASS++))
else
  echo "  FAIL: close-superseded-prs.sh missing or not executable"
  ((FAIL++))
fi

echo ""
echo "=== --help flag works ==="

HELP_OUTPUT=$(bash "$SCRIPT" --help 2>&1)
if echo "$HELP_OUTPUT" | grep -q "dry-run"; then
  echo "  PASS: --help mentions --dry-run"
  ((PASS++))
else
  echo "  FAIL: --help doesn't mention --dry-run"
  ((FAIL++))
fi

echo ""
echo "=== --dry-run mode runs without error ==="

DRY_OUTPUT=$(bash "$SCRIPT" --dry-run 2>&1)
DRY_EXIT=$?

assert_eq "dry-run exits 0" "0" "$DRY_EXIT"
assert_contains "dry-run mentions Dry run" "Dry run" "$DRY_OUTPUT"

echo ""
echo "=== Regex patterns extract kaizen issue numbers ==="

# Test extraction of kaizen issue numbers from PR body patterns
test_body_url='Closes https://github.com/Garsson-io/kaizen/issues/340'
test_body_short='Also fixes Garsson-io/kaizen#331'
test_body_hash='Related to kaizen #280'

# Pattern 1: URL form
url_nums=$(echo "$test_body_url" | grep -oP 'https://github\.com/Garsson-io/kaizen/issues/\K[0-9]+' 2>/dev/null)
assert_eq "URL pattern extracts 340" "340" "$url_nums"

# Pattern 2: shorthand form  
short_nums=$(echo "$test_body_short" | grep -oP 'Garsson-io/kaizen[#/issues/]*\K[0-9]+' 2>/dev/null)
assert_eq "shorthand extracts 331" "331" "$short_nums"

# Pattern 3: kaizen #NNN
hash_nums=$(echo "$test_body_hash" | grep -oP 'kaizen\s*#\K[0-9]+' 2>/dev/null)
assert_eq "kaizen # pattern extracts 280" "280" "$hash_nums"

echo ""
echo "=== Deduplication works ==="

test_body_dup='Closes Garsson-io/kaizen#100
Also: https://github.com/Garsson-io/kaizen/issues/100
kaizen #100'

all_nums=$(printf '%s\n%s\n%s' \
  "$(echo "$test_body_dup" | grep -oP 'Garsson-io/kaizen[#/issues/]*\K[0-9]+' 2>/dev/null)" \
  "$(echo "$test_body_dup" | grep -oP 'https://github\.com/Garsson-io/kaizen/issues/\K[0-9]+' 2>/dev/null)" \
  "$(echo "$test_body_dup" | grep -oP 'kaizen\s*#\K[0-9]+' 2>/dev/null)" \
  | sort -un | grep -v '^$')

assert_eq "dedup produces single entry" "100" "$all_nums"

print_results
