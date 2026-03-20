# Merging PRs

Branch protection has `strict: true` status checks. Auto-merge is enabled. The agent handles the full merge loop autonomously — do NOT ask the user unless something is genuinely broken after retries.

## Required Status Checks

All must pass before merge:

- **ci** — typecheck, format, contract check, unit tests (harness + agent-runner)
- **pr-policy** — test coverage for changed source files, verification section in PR body
- **e2e** — container build + Tier 1 (MCP tool registration) + Tier 2 (IPC round-trip with stub API). Uses BuildKit with GHA cache; skips expensive steps on docs-only PRs via path filter.

## Merge Procedure

```bash
# Step 1: Queue auto-merge (non-blocking — GitHub merges when CI passes + branch is current)
gh pr merge <url> --repo Garsson-io/nanoclaw --squash --delete-branch --auto

# Step 2: Actively monitor CI (do NOT use `gh run watch` — it blocks with no visibility)
# Poll job-level status every 15-30s:
gh run view <run-id> --repo Garsson-io/nanoclaw --json jobs --jq '.jobs[] | "\(.name): \(.status) \(.conclusion)"'
# IMPORTANT: Interleave PR state checks — auto-merge fires as soon as checks pass.
# Check PR state every 2-3 CI polls to detect completion promptly:
gh pr view <url> --repo Garsson-io/nanoclaw --json state --jq .state
# If state is "MERGED", skip to step 4. Do NOT keep polling CI after merge completes.
# When a job completes, note its duration. When the last job is running, check step-level progress:
gh run view <run-id> --repo Garsson-io/nanoclaw --json jobs --jq '.jobs[] | select(.status=="in_progress") | .steps[] | "\(.name): \(.status) \(.conclusion)"'
# If Docker build > 2min, check logs for cache misses. If all layers CACHED but still slow, it's I/O (image export).
# Report progress proactively: "CI: 2/3 jobs passed, e2e running — Docker build 57s all cached, now running IPC tests"

# Step 3: Verify merge completed
gh pr view <url> --repo Garsson-io/nanoclaw --json state --jq .state
# Expected: "MERGED"

# Step 4: Sync main (stay in your worktree — use git -C, NEVER cd to main checkout)
MAIN_CHECKOUT="$(git worktree list --porcelain | head -1 | sed 's/^worktree //')"
git -C "$MAIN_CHECKOUT" fetch origin main && git -C "$MAIN_CHECKOUT" merge --ff-only origin/main
# If follow-up work is needed, stay in this worktree:
#   git fetch origin main && git merge origin/main && git checkout -b fix/whatever
```

## Troubleshooting

**If CI fails**: fix the issue, commit, push. Auto-merge stays queued — CI re-runs automatically. Go back to step 2.

**If branch is behind main**: `git fetch origin main && git merge origin/main --no-edit && git push`. CI re-runs, auto-merge retries. Go back to step 2.

**If state is not MERGED after CI passes**: check `gh pr view --json mergeStateStatus` for the reason and fix it. This is rare — usually means another PR merged during your CI run and `strict` requires re-running. Push triggers a new CI run and auto-merge retries.

## Post-Merge: Auto-Deploy

After merging to main, sync local main — the `.husky/post-merge` hook automatically triggers `scripts/deploy.sh` which builds, restarts, health-checks, and notifies on Telegram. See [`auto-deploy.md`](auto-deploy.md) for full details.

### After every merge: sync local main

After merging a PR (via `gh pr merge`), always sync local main immediately:

```bash
MAIN_CHECKOUT="$(git worktree list --porcelain | head -1 | sed 's/^worktree //')"
git -C "$MAIN_CHECKOUT" fetch origin main && git -C "$MAIN_CHECKOUT" merge --ff-only origin/main
```

This triggers the post-merge hook which handles build + restart + notification automatically. The `git worktree list` resolution works from any worktree and doesn't depend on username or install location.

**NEVER `cd` to the main checkout.** The main checkout is the production instance — other agents may be using it, and dirtying it can cause cross-agent contamination. Always use `git -C` for the sync and stay in your worktree.

### Deploy Safety Rules

- **Build BEFORE restart** — if the build fails, old version keeps running
- **Leads are auto-notified** on Telegram at start, success, and failure
- **If anything fails, keep running on the old version** — availability > new features
- **Manual override**: `./scripts/deploy.sh --dry-run` to preview, `--build-only` to skip restart
