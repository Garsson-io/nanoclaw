#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# warn-mock-count.sh — Advisory warning for high mock counts (kaizen #89)
# Warns when a test file has >3 vi.mock() calls, suggesting the code
# under test has too many dependencies and should be refactored.
#
# Runs as PostToolUse hook on Edit|Write tool calls.
# Always exits 0 (advisory only — never blocks).
# Upgrade to exit 1 (blocking) if warnings are repeatedly ignored.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only check test files
if [[ ! "$FILE_PATH" =~ \.(test|spec)\.(ts|js|tsx|jsx)$ ]]; then
  exit 0
fi

# Only check files that exist (Write creates them)
if [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

# Count vi.mock() calls
MOCK_COUNT=$(grep -c 'vi\.mock\|jest\.mock\|vi\.spyOn.*mockImplementation' "$FILE_PATH" 2>/dev/null || echo "0")

THRESHOLD=3

if [ "$MOCK_COUNT" -gt "$THRESHOLD" ]; then
  # Get the file under test (heuristic: remove .test/.spec from filename)
  SUT_FILE=$(echo "$FILE_PATH" | sed -E 's/\.(test|spec)\.(ts|js|tsx|jsx)$/.\2/')

  SUT_IMPORTS=""
  if [ -f "$SUT_FILE" ]; then
    SUT_IMPORTS=$(grep -c '^import ' "$SUT_FILE" 2>/dev/null || echo "?")
  fi

  cat <<EOF

⚠️  High mock count: $MOCK_COUNT mocks in $(basename "$FILE_PATH")

This suggests the code under test has too many dependencies.
Consider extracting the logic you're testing into a pure function
or separate file with fewer dependencies — then test that directly.

$([ -n "$SUT_IMPORTS" ] && [ "$SUT_IMPORTS" != "?" ] && echo "  Source file $(basename "$SUT_FILE") has $SUT_IMPORTS imports.")
  Threshold: $THRESHOLD mocks (current: $MOCK_COUNT)

See: Zen of Kaizen — "Avoiding overengineering is not a license to underengineer."

EOF
fi

exit 0
