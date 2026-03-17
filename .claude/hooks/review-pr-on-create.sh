#!/bin/bash
# review-pr-on-create.sh — Level 2 kaizen enforcement (Issue #29)
# Fires after `gh pr create` succeeds. Outputs a structured self-review
# checklist so the creating agent reviews its own work before moving on.
#
# Runs as PostToolUse hook on Bash tool calls.
# Always exits 0 — advisory, not blocking.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
STDOUT=$(echo "$INPUT" | jq -r '.tool_output.stdout // empty')
STDERR=$(echo "$INPUT" | jq -r '.tool_output.stderr // empty')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_output.exit_code // "0"')

# Only trigger on successful commands
if [ "$EXIT_CODE" != "0" ]; then
  exit 0
fi

# Only trigger when a PR URL appears in output (confirms gh pr create succeeded)
PR_URL=$(echo "$STDOUT" | grep -oE 'https://github\.com/[^/]+/[^/]+/pull/[0-9]+' | head -1)
if [ -z "$PR_URL" ]; then
  PR_URL=$(echo "$STDERR" | grep -oE 'https://github\.com/[^/]+/[^/]+/pull/[0-9]+' | head -1)
fi

if [ -z "$PR_URL" ]; then
  exit 0
fi

cat <<EOF

📋 PR created: $PR_URL

MANDATORY SELF-REVIEW — complete before proceeding:

**Context & Purpose:**
- WHY: What problem does this PR solve?
- WHO: Who requested this work?
- WHAT: Is the purpose clear from title + description?
- HOW: Is the approach sound?
- HOW TO TEST: Are verification steps documented?
- IMPACT: What breaks if wrong? What improves if right?

**Code Quality:**
- Clear and understandable?
- Follows guidelines/conventions (CLAUDE.md, kaizen policies)?
- Designed for testability?
- Needs DRYing, reuse, or refactoring?

**Test Quality:**
- Clear INVARIANTS and SUT?
- Need harness, simulator, hypothesis, fixtures?
- Edge cases covered?
- Smoke tested (actually ran it)?

**Final Gate:**
- Achieving intended purpose?
- Purpose clear to first-time reader?
- Would you merge this reviewing someone else's PR?

Address each section, then proceed.
EOF

exit 0
