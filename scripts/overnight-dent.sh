#!/bin/bash
# overnight-dent — Autonomous batch kaizen runner.
#
# Loops /make-a-dent runs with guidance, tracking results and safety.
#
# Features (L2: Tagged & Tracked):
#   - Unique batch ID for the entire session
#   - Per-run tagging passed to the agent
#   - Output parsing: extracts PRs created, issues filed/closed
#   - Per-run structured summary
#   - Batch summary with aggregate stats
#
# Safety (L3 basics):
#   - Consecutive failure detection (stops after N failures)
#   - Total batch budget cap
#   - Tight-loop prevention (fast-fail escalating cooldown)
#   - Graceful SIGTERM/SIGINT shutdown
#
# Usage:
#   ./scripts/overnight-dent.sh "focus on hooks reliability"
#   ./scripts/overnight-dent.sh --max-runs 5 --budget 5.00 "improve test coverage"
#   ./scripts/overnight-dent.sh --total-budget 30.00 "fix area/skills issues"
#   ./scripts/overnight-dent.sh --dry-run "test the prompt"
#
# Logs go to logs/overnight-dent/<batch-id>/
#
# See docs/horizons/autonomous-batch-operations.md for the full horizon spec.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Always resolve to the main checkout (not a worktree) since claude-wt creates its own worktrees
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||')"
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

# ── Defaults ──────────────────────────────────────────────────────────────────
MAX_RUNS=0              # 0 = unlimited
COOLDOWN=30             # seconds between runs
BUDGET=""               # per-run budget (empty = no limit)
TOTAL_BUDGET=""         # total batch budget (empty = no limit)
MAX_FAILURES=3          # consecutive failures before stopping
MIN_RUN_SECONDS=60      # runs shorter than this trigger fast-fail detection
DRY_RUN=false
GUIDANCE=""

# ── Usage ─────────────────────────────────────────────────────────────────────
usage() {
  cat <<'EOF'
overnight-dent — Autonomous batch kaizen runner

Usage: overnight-dent.sh [options] <guidance>

Options:
  --max-runs N         Stop after N iterations (default: unlimited)
  --cooldown N         Seconds between runs (default: 30)
  --budget N.NN        Max USD per run (passed to claude --max-budget-usd)
  --total-budget N.NN  Max USD for the entire batch
  --max-failures N     Stop after N consecutive failures (default: 3)
  --dry-run            Show what would run without executing
  --help               Show this help

Examples:
  ./scripts/overnight-dent.sh "focus on hooks reliability"
  ./scripts/overnight-dent.sh --max-runs 5 --budget 5.00 "improve test coverage"
  ./scripts/overnight-dent.sh --total-budget 30.00 --max-runs 10 "fix area/skills issues"
EOF
  exit 0
}

# ── Arg parsing ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help) usage ;;
    --max-runs) MAX_RUNS="$2"; shift 2 ;;
    --cooldown) COOLDOWN="$2"; shift 2 ;;
    --budget) BUDGET="$2"; shift 2 ;;
    --total-budget) TOTAL_BUDGET="$2"; shift 2 ;;
    --max-failures) MAX_FAILURES="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) GUIDANCE="$1"; shift ;;
  esac
done

if [[ -z "$GUIDANCE" ]]; then
  echo "Error: guidance prompt is required" >&2
  echo "Usage: overnight-dent.sh [options] <guidance>" >&2
  exit 1
fi

# ── Batch identity ────────────────────────────────────────────────────────────
BATCH_ID="batch-$(date +%y%m%d-%H%M)-$(printf '%04x' $RANDOM)"
BATCH_START=$(date +%s)
LOG_DIR="$REPO_ROOT/logs/overnight-dent/$BATCH_ID"
mkdir -p "$LOG_DIR"

# ── Tracking state ────────────────────────────────────────────────────────────
ALL_PRS=()
ALL_ISSUES_FILED=()
ALL_ISSUES_CLOSED=()
ALL_CASES=()
CONSECUTIVE_FAILURES=0
TOTAL_SPENT="0"
STOP_REASON=""
SHUTTING_DOWN=false

# ── Output parsing ────────────────────────────────────────────────────────────
# Extract PRs, issues, and cases from a run's log file
parse_run_output() {
  local log_file="$1"

  # PR URLs (github.com/.../pull/N)
  RUN_PRS=($(grep -oP 'https://github\.com/[^/]+/[^/]+/pull/\d+' "$log_file" 2>/dev/null | sort -u || true))

  # Issue URLs created/filed (github.com/.../issues/N)
  RUN_ISSUES_FILED=($(grep -oP 'https://github\.com/[^/]+/[^/]+/issues/\d+' "$log_file" 2>/dev/null | sort -u || true))

  # Issue numbers closed (patterns like "Closes #N", "Fixed #N", "closed issue #N")
  RUN_ISSUES_CLOSED=($(grep -oiP '(?:closes?|closed|fix(?:es|ed)?|resolves?)\s+#\d+' "$log_file" 2>/dev/null | grep -oP '#\d+' | sort -u || true))

  # Case names (YYMMDD-HHMM pattern from case creation)
  RUN_CASES=($(grep -oP 'case[:\s]+\d{6}-\d{4}-[\w-]+' "$log_file" 2>/dev/null | sed 's/^case[: ]*//' | sort -u || true))
}

# Format a per-run summary
print_run_summary() {
  local run_num="$1" duration="$2" exit_code="$3"

  local status="success"
  if [[ "$exit_code" -ne 0 ]]; then
    status="failed (exit $exit_code)"
  fi

  echo ""
  echo "  ┌─ Run #$run_num Summary ─────────────────────────────"
  echo "  │ Status:   $status"
  echo "  │ Duration: ${duration}s"

  if [[ ${#RUN_PRS[@]} -gt 0 ]]; then
    for pr in "${RUN_PRS[@]}"; do
      echo "  │ PR:       $pr"
    done
  fi

  if [[ ${#RUN_ISSUES_FILED[@]} -gt 0 ]]; then
    for issue in "${RUN_ISSUES_FILED[@]}"; do
      echo "  │ Issue:    $issue"
    done
  fi

  if [[ ${#RUN_ISSUES_CLOSED[@]} -gt 0 ]]; then
    echo "  │ Closed:   ${RUN_ISSUES_CLOSED[*]}"
  fi

  if [[ ${#RUN_CASES[@]} -gt 0 ]]; then
    for case_name in "${RUN_CASES[@]}"; do
      echo "  │ Case:     $case_name"
    done
  fi

  echo "  └──────────────────────────────────────────────────"
  echo ""
}

# ── Batch summary ─────────────────────────────────────────────────────────────
print_batch_summary() {
  local batch_end
  batch_end=$(date +%s)
  local total_duration=$(( batch_end - BATCH_START ))
  local hours=$(( total_duration / 3600 ))
  local mins=$(( (total_duration % 3600) / 60 ))

  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║             overnight-dent — Batch Summary              ║"
  echo "╠══════════════════════════════════════════════════════════╣"
  echo "║ Batch ID:  $BATCH_ID"
  echo "║ Guidance:  $GUIDANCE"
  echo "║ Runs:      $RUN"
  echo "║ Duration:  ${hours}h ${mins}m"
  echo "║ Stop:      ${STOP_REASON:-completed}"
  echo "╠══════════════════════════════════════════════════════════╣"

  if [[ ${#ALL_PRS[@]} -gt 0 ]]; then
    echo "║ PRs created:"
    for pr in "${ALL_PRS[@]}"; do
      echo "║   $pr"
    done
  else
    echo "║ PRs created: none"
  fi

  if [[ ${#ALL_ISSUES_FILED[@]} -gt 0 ]]; then
    echo "║ Issues filed:"
    for issue in "${ALL_ISSUES_FILED[@]}"; do
      echo "║   $issue"
    done
  fi

  if [[ ${#ALL_ISSUES_CLOSED[@]} -gt 0 ]]; then
    echo "║ Issues closed: ${ALL_ISSUES_CLOSED[*]}"
  fi

  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""

  # Write batch summary to a file for later use
  {
    echo "batch_id=$BATCH_ID"
    echo "guidance=$GUIDANCE"
    echo "runs=$RUN"
    echo "total_duration_seconds=$total_duration"
    echo "stop_reason=${STOP_REASON:-completed}"
    echo "prs=${ALL_PRS[*]:-}"
    echo "issues_filed=${ALL_ISSUES_FILED[*]:-}"
    echo "issues_closed=${ALL_ISSUES_CLOSED[*]:-}"
    echo "cases=${ALL_CASES[*]:-}"
  } > "$LOG_DIR/batch-summary.txt"

  echo "Batch summary: $LOG_DIR/batch-summary.txt"
}

# ── Graceful shutdown ─────────────────────────────────────────────────────────
handle_shutdown() {
  if [[ "$SHUTTING_DOWN" = true ]]; then
    return
  fi
  SHUTTING_DOWN=true
  echo ""
  echo ">>> Received shutdown signal. Finishing current run, then stopping..."
  STOP_REASON="signal (SIGTERM/SIGINT)"
  # The current run will finish naturally; the loop checks SHUTTING_DOWN
}

trap handle_shutdown SIGTERM SIGINT

# ── Build prompt ──────────────────────────────────────────────────────────────
build_prompt() {
  local run_num="$1"
  local run_tag="${BATCH_ID}/run-${run_num}"

  local prompt="Use /make-a-dent with this guidance: $GUIDANCE

Run tag: $run_tag
Include this run tag in any PR descriptions or commit messages you create.

Run to completion. Do not ask for confirmation — make autonomous decisions."

  # Add exclusion context from previous runs
  if [[ ${#ALL_ISSUES_CLOSED[@]} -gt 0 ]]; then
    prompt="$prompt

Issues already addressed in previous runs (do not rework): ${ALL_ISSUES_CLOSED[*]}"
  fi

  if [[ ${#ALL_PRS[@]} -gt 0 ]]; then
    prompt="$prompt

PRs already created in this batch (avoid overlapping work): ${ALL_PRS[*]}"
  fi

  prompt="$prompt

When done, summarize what was accomplished. List all PRs created, issues filed, and issues closed with full URLs."

  echo "$prompt"
}

# ── Main display ──────────────────────────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                  overnight-dent                         ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║ Batch ID:  $BATCH_ID"
echo "║ Guidance:  $GUIDANCE"
echo "║ Max runs:  $([ "$MAX_RUNS" -eq 0 ] && echo "unlimited" || echo "$MAX_RUNS")"
echo "║ Cooldown:  ${COOLDOWN}s"
[[ -n "$BUDGET" ]] && echo "║ Budget/run: \$$BUDGET"
[[ -n "$TOTAL_BUDGET" ]] && echo "║ Total budget: \$$TOTAL_BUDGET"
echo "║ Max consecutive failures: $MAX_FAILURES"
echo "║ Logs:      $LOG_DIR"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

if [[ "$DRY_RUN" = true ]]; then
  echo "[dry-run] Would execute per run:"
  echo "  (cd $REPO_ROOT && $REPO_ROOT/scripts/claude-wt.sh -p <prompt> ${BUDGET:+--max-budget-usd $BUDGET})"
  echo ""
  echo "[dry-run] Sample prompt for run 1:"
  echo "---"
  build_prompt 1
  echo "---"
  exit 0
fi

# ── Main loop ─────────────────────────────────────────────────────────────────
RUN=0
CURRENT_COOLDOWN=$COOLDOWN

while true; do
  # Check shutdown
  if [[ "$SHUTTING_DOWN" = true ]]; then
    break
  fi

  RUN=$((RUN + 1))

  if [[ "$MAX_RUNS" -gt 0 && "$RUN" -gt "$MAX_RUNS" ]]; then
    STOP_REASON="max runs reached ($MAX_RUNS)"
    break
  fi

  # Check consecutive failures
  if [[ "$CONSECUTIVE_FAILURES" -ge "$MAX_FAILURES" ]]; then
    STOP_REASON="$MAX_FAILURES consecutive failures"
    echo ">>> Stopping: $STOP_REASON"
    break
  fi

  TIMESTAMP=$(date +%y%m%d-%H%M%S)
  LOG_FILE="$LOG_DIR/run-${RUN}-${TIMESTAMP}.log"
  RUN_PROMPT=$(build_prompt "$RUN")

  # Build claude-wt args for this run
  RUN_ARGS=(-p "$RUN_PROMPT")
  if [[ -n "$BUDGET" ]]; then
    RUN_ARGS+=(--max-budget-usd "$BUDGET")
  fi

  echo "━━━ Run #$RUN starting at $(date) ━━━"
  echo "Tag: ${BATCH_ID}/run-${RUN}"
  echo "Log: $LOG_FILE"

  # Time the run
  RUN_START=$(date +%s)
  EXIT_CODE=0
  (cd "$REPO_ROOT" && "$REPO_ROOT/scripts/claude-wt.sh" "${RUN_ARGS[@]}") 2>&1 | tee "$LOG_FILE" || EXIT_CODE=$?
  RUN_END=$(date +%s)
  RUN_DURATION=$(( RUN_END - RUN_START ))

  # Parse output
  parse_run_output "$LOG_FILE"

  # Accumulate results
  ALL_PRS+=("${RUN_PRS[@]}")
  ALL_ISSUES_FILED+=("${RUN_ISSUES_FILED[@]}")
  ALL_ISSUES_CLOSED+=("${RUN_ISSUES_CLOSED[@]}")
  ALL_CASES+=("${RUN_CASES[@]}")

  # Append metadata to log
  {
    echo ""
    echo "--- overnight-dent metadata ---"
    echo "batch_id=$BATCH_ID"
    echo "run=$RUN"
    echo "exit_code=$EXIT_CODE"
    echo "duration_seconds=$RUN_DURATION"
    echo "prs=${RUN_PRS[*]:-}"
    echo "issues_filed=${RUN_ISSUES_FILED[*]:-}"
    echo "issues_closed=${RUN_ISSUES_CLOSED[*]:-}"
    echo "cases=${RUN_CASES[*]:-}"
  } >> "$LOG_FILE"

  # Print per-run summary
  print_run_summary "$RUN" "$RUN_DURATION" "$EXIT_CODE"

  # ── Safety checks ────────────────────────────────────────────────────────

  # Consecutive failure tracking
  if [[ "$EXIT_CODE" -ne 0 ]] && [[ ${#RUN_PRS[@]} -eq 0 ]]; then
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    echo ">>> Consecutive failures: $CONSECUTIVE_FAILURES / $MAX_FAILURES"
  else
    CONSECUTIVE_FAILURES=0
    CURRENT_COOLDOWN=$COOLDOWN  # reset cooldown on success
  fi

  # Fast-fail detection: run completed too quickly with no output
  if [[ "$RUN_DURATION" -lt "$MIN_RUN_SECONDS" ]] && [[ ${#RUN_PRS[@]} -eq 0 ]] && [[ ${#RUN_ISSUES_FILED[@]} -eq 0 ]]; then
    echo ">>> Fast fail detected (${RUN_DURATION}s < ${MIN_RUN_SECONDS}s threshold, no output)"
    # Escalate cooldown: double it each time, cap at 600s
    CURRENT_COOLDOWN=$(( CURRENT_COOLDOWN * 2 ))
    if [[ "$CURRENT_COOLDOWN" -gt 600 ]]; then
      CURRENT_COOLDOWN=600
    fi
    echo ">>> Escalated cooldown to ${CURRENT_COOLDOWN}s"
  fi

  # Check max-runs
  if [[ "$MAX_RUNS" -gt 0 && "$RUN" -ge "$MAX_RUNS" ]]; then
    STOP_REASON="max runs reached ($MAX_RUNS)"
    break
  fi

  # Check shutdown between runs
  if [[ "$SHUTTING_DOWN" = true ]]; then
    break
  fi

  echo "Cooling down for ${CURRENT_COOLDOWN}s before next run..."
  sleep "$CURRENT_COOLDOWN" &
  SLEEP_PID=$!
  # Allow SIGTERM/SIGINT to interrupt sleep
  wait $SLEEP_PID 2>/dev/null || true
done

# ── Batch complete ────────────────────────────────────────────────────────────
print_batch_summary
