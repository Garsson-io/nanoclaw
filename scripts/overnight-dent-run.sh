#!/bin/bash
# overnight-dent-run — Execute a single make-a-dent run.
#
# Called by the trampoline (overnight-dent.sh). Re-read from disk each
# iteration, so merged improvements take effect on the next run.
#
# Usage: overnight-dent-run.sh <state-file>
#
# Reads batch config and cross-run state from state.json.
# Writes results back after the run completes.

set -euo pipefail

STATE_FILE="${1:?Usage: overnight-dent-run.sh <state-file>}"

if [[ ! -f "$STATE_FILE" ]]; then
  echo "ERROR: State file not found: $STATE_FILE" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||')"
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

LOG_DIR="$(dirname "$STATE_FILE")"
MIN_RUN_SECONDS=60

# ── Read state ────────────────────────────────────────────────────────────────
read_state() {
  python3 -c "
import json, sys
with open('$STATE_FILE') as f: s = json.load(f)
print(s.get(sys.argv[1], ''))
" "$1"
}

BATCH_ID=$(read_state batch_id)
GUIDANCE=$(read_state guidance)
BUDGET=$(read_state budget)
RUN_NUM=$(python3 -c "import json; s=json.load(open('$STATE_FILE')); print(s['run'] + 1)")
COOLDOWN=$(read_state cooldown)

# ── Build prompt ──────────────────────────────────────────────────────────────
RUN_TAG="${BATCH_ID}/run-${RUN_NUM}"

PROMPT="Use /make-a-dent with this guidance: $GUIDANCE

Run tag: $RUN_TAG
Include this run tag in any PR descriptions or commit messages you create.

Run to completion. Do not ask for confirmation — make autonomous decisions."

# Add exclusion context from previous runs
PREV_CLOSED=$(python3 -c "
import json
s = json.load(open('$STATE_FILE'))
if s['issues_closed']:
    print(' '.join(s['issues_closed']))
" 2>/dev/null || true)

PREV_PRS=$(python3 -c "
import json
s = json.load(open('$STATE_FILE'))
if s['prs']:
    print(' '.join(s['prs']))
" 2>/dev/null || true)

if [[ -n "$PREV_CLOSED" ]]; then
  PROMPT="$PROMPT

Issues already addressed in previous runs (do not rework): $PREV_CLOSED"
fi

if [[ -n "$PREV_PRS" ]]; then
  PROMPT="$PROMPT

PRs already created in this batch (avoid overlapping work): $PREV_PRS"
fi

PROMPT="$PROMPT

When done, summarize what was accomplished. List all PRs created, issues filed, and issues closed with full URLs."

# ── Build claude-wt args ─────────────────────────────────────────────────────
RUN_ARGS=(-p "$PROMPT")
if [[ -n "$BUDGET" && "$BUDGET" != "null" ]]; then
  RUN_ARGS+=(--max-budget-usd "$BUDGET")
fi

TIMESTAMP=$(date +%y%m%d-%H%M%S)
LOG_FILE="$LOG_DIR/run-${RUN_NUM}-${TIMESTAMP}.log"

echo "Tag: $RUN_TAG"
echo "Log: $LOG_FILE"

# ── Execute ───────────────────────────────────────────────────────────────────
RUN_START=$(date +%s)
EXIT_CODE=0
(cd "$REPO_ROOT" && "$REPO_ROOT/scripts/claude-wt.sh" "${RUN_ARGS[@]}") 2>&1 | tee "$LOG_FILE" || EXIT_CODE=$?
RUN_END=$(date +%s)
RUN_DURATION=$(( RUN_END - RUN_START ))

# ── Parse output ──────────────────────────────────────────────────────────────
RUN_PRS=$(grep -oP 'https://github\.com/[^/]+/[^/]+/pull/\d+' "$LOG_FILE" 2>/dev/null | sort -u | tr '\n' ' ' || true)
RUN_ISSUES_FILED=$(grep -oP 'https://github\.com/[^/]+/[^/]+/issues/\d+' "$LOG_FILE" 2>/dev/null | sort -u | tr '\n' ' ' || true)
RUN_ISSUES_CLOSED=$(grep -oiP '(?:closes?|closed|fix(?:es|ed)?|resolves?)\s+#\d+' "$LOG_FILE" 2>/dev/null | grep -oP '#\d+' | sort -u | tr '\n' ' ' || true)
RUN_CASES=$(grep -oP 'case[:\s]+\d{6}-\d{4}-[\w-]+' "$LOG_FILE" 2>/dev/null | sed 's/^case[: ]*//' | sort -u | tr '\n' ' ' || true)

# ── Append metadata to log ───────────────────────────────────────────────────
{
  echo ""
  echo "--- overnight-dent metadata ---"
  echo "batch_id=$BATCH_ID"
  echo "run=$RUN_NUM"
  echo "exit_code=$EXIT_CODE"
  echo "duration_seconds=$RUN_DURATION"
  echo "prs=$RUN_PRS"
  echo "issues_filed=$RUN_ISSUES_FILED"
  echo "issues_closed=$RUN_ISSUES_CLOSED"
  echo "cases=$RUN_CASES"
} >> "$LOG_FILE"

# ── Per-run summary ──────────────────────────────────────────────────────────
STATUS="success"
if [[ "$EXIT_CODE" -ne 0 ]]; then
  STATUS="failed (exit $EXIT_CODE)"
fi

echo ""
echo "  ┌─ Run #$RUN_NUM Summary ─────────────────────────────"
echo "  │ Status:   $STATUS"
echo "  │ Duration: ${RUN_DURATION}s"
for pr in $RUN_PRS; do echo "  │ PR:       $pr"; done
for issue in $RUN_ISSUES_FILED; do echo "  │ Issue:    $issue"; done
[[ -n "$RUN_ISSUES_CLOSED" ]] && echo "  │ Closed:   $RUN_ISSUES_CLOSED"
for case_name in $RUN_CASES; do echo "  │ Case:     $case_name"; done
echo "  └──────────────────────────────────────────────────"
echo ""

# ── Update state file ─────────────────────────────────────────────────────────
python3 << PYEOF
import json

with open("$STATE_FILE") as f:
    s = json.load(f)

# Increment run counter
s["run"] = $RUN_NUM

# Append new results (deduplicated)
for pr in "$RUN_PRS".split():
    if pr and pr not in s["prs"]:
        s["prs"].append(pr)

for issue in "$RUN_ISSUES_FILED".split():
    if issue and issue not in s["issues_filed"]:
        s["issues_filed"].append(issue)

for closed in "$RUN_ISSUES_CLOSED".split():
    if closed and closed not in s["issues_closed"]:
        s["issues_closed"].append(closed)

for case in "$RUN_CASES".split():
    if case and case not in s["cases"]:
        s["cases"].append(case)

# Safety: consecutive failure tracking
has_prs = len("$RUN_PRS".split()) > 0 and "$RUN_PRS".strip() != ""
if $EXIT_CODE != 0 and not has_prs:
    s["consecutive_failures"] = s.get("consecutive_failures", 0) + 1
    print(f">>> Consecutive failures: {s['consecutive_failures']} / {s['max_failures']}")
else:
    s["consecutive_failures"] = 0
    s["current_cooldown"] = s["cooldown"]  # reset on success

# Fast-fail detection
has_issues = len("$RUN_ISSUES_FILED".split()) > 0 and "$RUN_ISSUES_FILED".strip() != ""
if $RUN_DURATION < $MIN_RUN_SECONDS and not has_prs and not has_issues:
    print(f">>> Fast fail detected (${RUN_DURATION}s < ${MIN_RUN_SECONDS}s threshold, no output)")
    s["current_cooldown"] = min(s.get("current_cooldown", $COOLDOWN) * 2, 600)
    print(f">>> Escalated cooldown to {s['current_cooldown']}s")

with open("$STATE_FILE", "w") as f:
    json.dump(s, f, indent=2)
PYEOF

exit $EXIT_CODE
