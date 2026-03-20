#!/bin/bash
# overnight-dent — Autonomous batch kaizen runner (trampoline).
#
# This is the TRAMPOLINE — a thin outer loop that:
#   1. Parses args and creates the batch
#   2. Pulls main between runs (so merged improvements take effect)
#   3. Delegates each run to overnight-dent-run.sh (re-read from disk each time)
#   4. Prints the batch summary when done
#
# All real logic (prompt building, output parsing, safety) lives in
# overnight-dent-run.sh, which self-updates when PRs merge to main.
#
# Cross-run state is persisted to $LOG_DIR/state.json — survives crashes,
# enables --resume, and provides L4 reporting data.
#
# Usage:
#   ./scripts/overnight-dent.sh "focus on hooks reliability"
#   ./scripts/overnight-dent.sh --max-runs 5 --budget 5.00 "improve test coverage"
#   ./scripts/overnight-dent.sh --dry-run "test the prompt"
#
# Logs go to logs/overnight-dent/<batch-id>/
#
# See docs/horizons/autonomous-batch-operations.md for the full horizon spec.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Always resolve to the main checkout (not a worktree)
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||')"
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

# ── Defaults ──────────────────────────────────────────────────────────────────
MAX_RUNS=0              # 0 = unlimited
COOLDOWN=30             # seconds between runs
BUDGET=""               # per-run budget
MAX_FAILURES=3          # consecutive failures before stopping
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
  --max-failures N     Stop after N consecutive failures (default: 3)
  --dry-run            Show what would run without executing
  --help               Show this help

Self-update: between runs, the trampoline pulls main so that merged
improvements to the runner script take effect on the next iteration.

Examples:
  ./scripts/overnight-dent.sh "focus on hooks reliability"
  ./scripts/overnight-dent.sh --max-runs 5 --budget 5.00 "improve test coverage"
  ./scripts/overnight-dent.sh --max-runs 10 --budget 5.00 "fix area/skills issues"
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

# ── Initialize state file ────────────────────────────────────────────────────
STATE_FILE="$LOG_DIR/state.json"
cat > "$STATE_FILE" << STATEOF
{
  "batch_id": "$BATCH_ID",
  "guidance": $(printf '%s' "$GUIDANCE" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),
  "batch_start": $BATCH_START,
  "max_runs": $MAX_RUNS,
  "cooldown": $COOLDOWN,
  "budget": $(if [[ -n "$BUDGET" ]]; then echo "\"$BUDGET\""; else echo "null"; fi),
  "max_failures": $MAX_FAILURES,
  "run": 0,
  "consecutive_failures": 0,
  "current_cooldown": $COOLDOWN,
  "stop_reason": null,
  "prs": [],
  "issues_filed": [],
  "issues_closed": [],
  "cases": []
}
STATEOF

# ── Graceful shutdown ─────────────────────────────────────────────────────────
SHUTTING_DOWN=false
update_state() {
  # Update a field in state.json: update_state field value
  python3 -c "
import json, sys
sf = sys.argv[1]; k = sys.argv[2]; v = sys.argv[3]
with open(sf) as f: s = json.load(f)
s[k] = v
with open(sf, 'w') as f: json.dump(s, f, indent=2)
" "$STATE_FILE" "$1" "$2"
}

read_state() {
  python3 -c "
import json, sys
with open(sys.argv[1]) as f: s = json.load(f)
print(s.get(sys.argv[2], ''))
" "$STATE_FILE" "$1"
}

handle_shutdown() {
  if [[ "$SHUTTING_DOWN" = true ]]; then return; fi
  SHUTTING_DOWN=true
  echo ""
  echo ">>> Received shutdown signal. Finishing current run, then stopping..."
  update_state stop_reason "signal (SIGTERM/SIGINT)"
}
trap handle_shutdown SIGTERM SIGINT

# ── Banner ────────────────────────────────────────────────────────────────────

echo "╔══════════════════════════════════════════════════════════╗"
echo "║              overnight-dent (trampoline)                ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║ Batch ID:  $BATCH_ID"
echo "║ Guidance:  $GUIDANCE"
echo "║ Max runs:  $([ "$MAX_RUNS" -eq 0 ] && echo "unlimited" || echo "$MAX_RUNS")"
echo "║ Cooldown:  ${COOLDOWN}s"
[[ -n "$BUDGET" ]] && echo "║ Budget/run: \$$BUDGET"
echo "║ Max consecutive failures: $MAX_FAILURES"
echo "║ Logs:      $LOG_DIR"
echo "║ State:     $STATE_FILE"
echo "║ Self-update: enabled (pulls main between runs)"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

if [[ "$DRY_RUN" = true ]]; then
  echo "[dry-run] Would execute per run:"
  echo "  $REPO_ROOT/scripts/overnight-dent-run.sh $STATE_FILE"
  echo ""
  echo "[dry-run] State file:"
  cat "$STATE_FILE"
  exit 0
fi

# ── Main loop (trampoline) ────────────────────────────────────────────────────
# This loop is intentionally minimal. All real logic is in the runner.
while true; do
  if [[ "$SHUTTING_DOWN" = true ]]; then break; fi

  # Read current state
  RUN=$(read_state run)
  CONSEC_FAIL=$(read_state consecutive_failures)
  CUR_COOLDOWN=$(read_state current_cooldown)
  NEXT_RUN=$((RUN + 1))

  # Stop conditions (checked in trampoline so they work even if runner changes)
  if [[ "$MAX_RUNS" -gt 0 && "$NEXT_RUN" -gt "$MAX_RUNS" ]]; then
    update_state stop_reason "max runs reached ($MAX_RUNS)"
    break
  fi

  if [[ "$CONSEC_FAIL" -ge "$MAX_FAILURES" ]]; then
    echo ">>> Stopping: $MAX_FAILURES consecutive failures"
    update_state stop_reason "$MAX_FAILURES consecutive failures"
    break
  fi

  # ── Self-update: pull main before each run ──────────────────────────────
  echo ">>> Pulling main for self-update..."
  if git -C "$REPO_ROOT" pull --ff-only origin main 2>/dev/null; then
    echo ">>> Main updated."
  else
    echo ">>> Main already up-to-date (or pull failed, continuing with current)."
  fi

  # ── Resolve runner (re-resolve after pull in case it was added/moved) ───
  RUNNER="$REPO_ROOT/scripts/overnight-dent-run.sh"
  if [[ ! -x "$RUNNER" ]]; then
    echo ">>> ERROR: Runner not found: $RUNNER"
    echo ">>> This may happen if the trampoline PR merged but the runner isn't on main yet."
    update_state stop_reason "runner not found"
    break
  fi

  # ── Execute the runner (re-read from disk each time) ────────────────────
  echo "━━━ Run #$NEXT_RUN starting at $(date) ━━━"
  EXIT_CODE=0
  "$RUNNER" "$STATE_FILE" || EXIT_CODE=$?

  # Runner updates state.json with results
  if [[ "$SHUTTING_DOWN" = true ]]; then break; fi

  # ── Cooldown ────────────────────────────────────────────────────────────
  CUR_COOLDOWN=$(read_state current_cooldown)

  # Check max-runs after run
  COMPLETED_RUNS=$(read_state run)
  if [[ "$MAX_RUNS" -gt 0 && "$COMPLETED_RUNS" -ge "$MAX_RUNS" ]]; then
    update_state stop_reason "max runs reached ($MAX_RUNS)"
    break
  fi

  if [[ "$SHUTTING_DOWN" = true ]]; then break; fi

  echo "Cooling down for ${CUR_COOLDOWN}s before next run..."
  sleep "$CUR_COOLDOWN" &
  SLEEP_PID=$!
  wait $SLEEP_PID 2>/dev/null || true
done

# ── Batch summary ─────────────────────────────────────────────────────────────
python3 - "$STATE_FILE" << 'PYEOF'
import json, sys, time

with open(sys.argv[1]) as f:
    s = json.load(f)

duration = int(time.time()) - s["batch_start"]
hours = duration // 3600
mins = (duration % 3600) // 60

print()
print("╔══════════════════════════════════════════════════════════╗")
print("║             overnight-dent — Batch Summary              ║")
print("╠══════════════════════════════════════════════════════════╣")
print(f"║ Batch ID:  {s['batch_id']}")
print(f"║ Guidance:  {s['guidance']}")
print(f"║ Runs:      {s['run']}")
print(f"║ Duration:  {hours}h {mins}m")
print(f"║ Stop:      {s.get('stop_reason') or 'completed'}")
print("╠══════════════════════════════════════════════════════════╣")

if s["prs"]:
    print("║ PRs created:")
    for pr in s["prs"]:
        print(f"║   {pr}")
else:
    print("║ PRs created: none")

if s["issues_filed"]:
    print("║ Issues filed:")
    for issue in s["issues_filed"]:
        print(f"║   {issue}")

if s["issues_closed"]:
    print(f"║ Issues closed: {' '.join(s['issues_closed'])}")

print("╚══════════════════════════════════════════════════════════╝")
print()

# Finalize state
if not s.get('stop_reason'):
    s['stop_reason'] = 'completed'
s['batch_end'] = int(time.time())
with open(sys.argv[1], 'w') as f:
    json.dump(s, f, indent=2)

print(f"State: {sys.argv[1]}")
PYEOF
