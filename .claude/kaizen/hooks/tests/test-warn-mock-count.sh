#!/bin/bash
# Tests for warn-mock-count.sh hook (kaizen #89)
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../warn-mock-count.sh"
TMPDIR_TEST=$(mktemp -d)
trap 'rm -rf "$TMPDIR_TEST"' EXIT

run_write_hook() {
  local file_path="$1"
  local input
  input=$(jq -n --arg fp "$file_path" '{"tool_input":{"file_path":$fp}}')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

echo "Testing warn-mock-count.sh"
echo ""

# Test 1: Non-test file — no warning
echo "1. Non-test file produces no output"
OUTPUT=$(run_write_hook "$TMPDIR_TEST/src/index.ts")
assert_eq "non-test file silent" "" "$OUTPUT"

# Test 2: Test file with 0 mocks — no warning
echo "2. Test file with no mocks"
cat > "$TMPDIR_TEST/clean.test.ts" << 'EOF'
import { describe, test, expect } from 'vitest';
describe('clean tests', () => {
  test('no mocks needed', () => {
    expect(1 + 1).toBe(2);
  });
});
EOF
OUTPUT=$(run_write_hook "$TMPDIR_TEST/clean.test.ts")
assert_eq "zero mocks silent" "" "$OUTPUT"

# Test 3: Test file with 2 mocks — under threshold, no warning
echo "3. Test file with 2 mocks (under threshold)"
cat > "$TMPDIR_TEST/low.test.ts" << 'EOF'
import { describe, test, expect, vi } from 'vitest';
vi.mock('./dep-a.js', () => ({ a: vi.fn() }));
vi.mock('./dep-b.js', () => ({ b: vi.fn() }));
describe('low mock count', () => {
  test('ok', () => { expect(true).toBe(true); });
});
EOF
OUTPUT=$(run_write_hook "$TMPDIR_TEST/low.test.ts")
assert_eq "2 mocks silent" "" "$OUTPUT"

# Test 4: Test file with 3 mocks — at threshold, no warning
echo "4. Test file with 3 mocks (at threshold)"
cat > "$TMPDIR_TEST/threshold.test.ts" << 'EOF'
import { describe, test, expect, vi } from 'vitest';
vi.mock('./dep-a.js', () => ({ a: vi.fn() }));
vi.mock('./dep-b.js', () => ({ b: vi.fn() }));
vi.mock('./dep-c.js', () => ({ c: vi.fn() }));
describe('at threshold', () => {
  test('ok', () => { expect(true).toBe(true); });
});
EOF
OUTPUT=$(run_write_hook "$TMPDIR_TEST/threshold.test.ts")
assert_eq "3 mocks (at threshold) silent" "" "$OUTPUT"

# Test 5: Test file with 5 mocks — over threshold, WARNING
echo "5. Test file with 5 mocks (over threshold)"
cat > "$TMPDIR_TEST/heavy.test.ts" << 'EOF'
import { describe, test, expect, vi } from 'vitest';
vi.mock('./dep-a.js', () => ({ a: vi.fn() }));
vi.mock('./dep-b.js', () => ({ b: vi.fn() }));
vi.mock('./dep-c.js', () => ({ c: vi.fn() }));
vi.mock('./dep-d.js', () => ({ d: vi.fn() }));
vi.mock('./dep-e.js', () => ({ e: vi.fn() }));
describe('heavy mocks', () => {
  test('works but smells', () => { expect(true).toBe(true); });
});
EOF
OUTPUT=$(run_write_hook "$TMPDIR_TEST/heavy.test.ts")
assert_contains "warns on 5 mocks" "High mock count" "$OUTPUT"
assert_contains "shows count" "5 mocks" "$OUTPUT"

# Test 6: Test file with jest.mock — also counted
echo "6. jest.mock calls are also counted"
cat > "$TMPDIR_TEST/jest.test.js" << 'EOF'
const { describe, test } = require('jest');
jest.mock('./a');
jest.mock('./b');
jest.mock('./c');
jest.mock('./d');
describe('jest mocks', () => {});
EOF
OUTPUT=$(run_write_hook "$TMPDIR_TEST/jest.test.js")
assert_contains "warns on jest.mock" "High mock count" "$OUTPUT"

# Test 7: .spec.ts extension also works
echo "7. .spec.ts extension is detected"
cat > "$TMPDIR_TEST/heavy.spec.ts" << 'EOF'
import { vi } from 'vitest';
vi.mock('./a');
vi.mock('./b');
vi.mock('./c');
vi.mock('./d');
EOF
OUTPUT=$(run_write_hook "$TMPDIR_TEST/heavy.spec.ts")
assert_contains ".spec.ts works" "High mock count" "$OUTPUT"

# Test 8: Always exits 0 (advisory only)
echo "8. Always exits 0 even when warning"
INPUT=$(jq -n --arg fp "$TMPDIR_TEST/heavy.test.ts" '{"tool_input":{"file_path":$fp}}')
echo "$INPUT" | bash "$HOOK" >/dev/null 2>&1
assert_eq "exit code is 0" "0" "$?"

# Test 9: Non-existent file — no crash
echo "9. Non-existent test file doesn't crash"
OUTPUT=$(run_write_hook "$TMPDIR_TEST/nonexistent.test.ts")
EXIT_CODE=$?
assert_eq "non-existent file exits 0" "0" "$EXIT_CODE"

print_results
