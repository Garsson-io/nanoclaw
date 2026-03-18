# Restart-Pending Tracking — Specification

## 1. Problem Statement

After merging a PR that changes `src/`, `container/`, or `package.json`, the running NanoClaw service continues using the old compiled code. Today, the post-merge workflow in CLAUDE.md tells agents to "build and restart" — but this is L1 (instructions). In practice:

- **Autonomous agents merge at 3am** and shouldn't restart a live service without human awareness.
- **Multiple PRs accumulate** between sessions — nobody remembers which ones need a restart.
- **No visibility into drift** — there's no way to tell whether the running service matches the repo without comparing git commits manually.
- **The human forgets** — they open Claude Code, start new work, and the old service silently runs stale code.

**Concrete incident:** Kaizen #102 was merged and built manually because a human happened to be present. If the agent had been autonomous, the fix would have been in `dist/` but not running — and the next `case_create` failure would have been just as silent as before.

**Cost of not solving:** Merged fixes don't take effect. Humans debug problems that are already fixed in code but not deployed. Trust in the merge→deploy pipeline erodes.

## 2. Desired End State

After this system is built:

1. **Every merged `src/` change is auto-built** — the `dist/` output always matches the latest merge.
2. **A marker file tracks which PRs need a restart** — it accumulates across multiple merges.
3. **The human is notified** — via Telegram immediately, and via SessionStart hook when they open Claude Code.
4. **A `/deploy` skill** performs the full build→restart→verify cycle with one command.
5. **Service startup clears the marker** — the only proof of deployment is the service actually restarting.
6. **No autonomous restarts** — agents build but never restart without human presence or explicit instruction.

### Out of scope

- Automatic rollback on failed restart (the existing policy is "keep running old version, report failure")
- Blue-green deployment or zero-downtime restarts (10s downtime is acceptable for a single-user system)
- Container image auto-rebuild tracking (container builds are rarer and more expensive — tracked separately if needed)

## 3. Roles & Boundaries

| Role | Can do | Cannot do |
|------|--------|-----------|
| Dev agent (post-merge) | Build (`npm run build`), write marker, send notification | Restart service |
| Human (via /deploy) | Build, restart, verify, clear marker | N/A — full authority |
| SessionStart hook | Read marker, warn human | Restart, modify marker |
| Service process | Clear marker on startup | Write marker |

## 4. Architecture

```
Agent merges PR
       │
       ▼
  npm run build
       │
       ├── FAIL → report failure, do NOT write marker
       │
       ▼ SUCCESS
  Append to store/restart-pending.json
       │
       ▼
  Send Telegram notification via IPC
       │
       ▼
  (Agent stops or continues other work)

                    ┌─────────────────────┐
                    │  Human opens Claude  │
                    └──────────┬──────────┘
                               │
                    SessionStart hook reads marker
                               │
                    "⚠️ 2 PRs pending restart"
                               │
                    Human runs /deploy
                               │
                    ┌──────────▼──────────┐
                    │  Build (if needed)   │
                    │  Restart service     │
                    │  Verify health       │
                    │  Report completion   │
                    └──────────┬──────────┘
                               │
                    Service startup clears marker
```

### Marker file: `store/restart-pending.json`

```json
{
  "pending_prs": [
    {
      "number": 151,
      "title": "fix: write error result on case_create IPC failure",
      "merged_at": "2026-03-19T01:45:00Z",
      "change_type": "src"
    },
    {
      "number": 153,
      "title": "feat: add escalation timeout",
      "merged_at": "2026-03-19T03:20:00Z",
      "change_type": "src"
    }
  ],
  "last_build_at": "2026-03-19T03:22:00Z",
  "built_commit": "abc1234"
}
```

**Why `store/`?** It's the existing data directory, already gitignored, already survives restarts. No new conventions needed.

**Why JSON not a lockfile?** The marker needs to be read by three actors (agent, hook, service) across Node.js and bash. JSON is the common denominator.

### Change type classification

The marker tracks `change_type` so `/deploy` can report what kind of restart is needed:

| Change type | `change_type` value | Action needed |
|-------------|-------------------|---------------|
| `src/` code | `src` | `npm run build` + restart |
| `container/Dockerfile` or `agent-runner/` | `container` | `./container/build.sh` + restart |
| `package.json` deps | `deps` | `npm install` + build + restart |
| Combination | whichever is heaviest | All applicable steps |

The `/deploy` skill reads the change types and runs the appropriate steps.

## 5. Components — What Needs Building

### Component 1: Post-merge marker writer

**Where:** Integrate into the existing post-merge workflow. The `enforce-post-merge-stop.sh` hook already gates agent completion after merge. The kaizen reflection step (or a new step in the post-merge checklist) writes the marker.

**Logic:**
1. After `npm run build` succeeds, read existing `store/restart-pending.json` (or create empty)
2. Append current PR info to `pending_prs` array
3. Write updated marker
4. Send Telegram notification via IPC: "Build ready. Restart pending for: #151, #153 (2 PRs accumulated)"

**Decision: Who triggers the build?** Today the agent manually runs `npm run build` when instructed. The new flow should make this automatic in the post-merge workflow — the enforce-post-merge hook already blocks the agent, so adding "build and write marker" to that checklist is natural. The agent builds; it just doesn't restart.

### Component 2: SessionStart hook

**Where:** `.claude/kaizen/hooks/` as a new SessionStart hook, registered in `.claude/settings.json`.

**Logic:**
1. Check if `store/restart-pending.json` exists
2. If yes, read it and output a warning:
   ```
   ⚠️ Service restart pending for 2 PRs:
     #151 — fix: write error result on case_create IPC failure (merged 2h ago)
     #153 — feat: add escalation timeout (merged 45m ago)
   Built at: 2026-03-19T03:22:00Z (commit abc1234)
   Run /deploy to restart the service.
   ```
3. If no, output nothing (allow session to start normally)

### Component 3: Service startup marker clearance

**Where:** `src/index.ts`, in the `main()` function, early in startup.

**Logic:**
1. Check if `store/restart-pending.json` exists
2. If yes, log the PRs being deployed: `logger.info({ prs: [...] }, 'Deploying pending PRs')`
3. Delete the file
4. This is the mechanical proof that the restart happened

### Component 4: `/deploy` skill

**Where:** `.claude/skills/deploy/SKILL.md`

**Triggers:** `/deploy`, "deploy", "restart service", "restart nanoclaw"

**Logic:**
1. Read `store/restart-pending.json` — show what's pending (or "service is up to date" if no marker)
2. Classify change types from marker
3. Run appropriate build steps:
   - `deps` → `npm install` + `npm run build`
   - `container` → `./container/build.sh`
   - `src` → `npm run build`
4. If build fails → report and stop. Do not restart.
5. If build succeeds → `systemctl --user restart nanoclaw`
6. Wait 2-3s, then `systemctl --user status nanoclaw` — verify active
7. Report: "Deployed 2 PRs: #151, #153. Service running on commit abc1234."

**The skill should also work when there's no marker** — a human might say "/deploy" after manually pulling code. In that case, just build and restart without marker context.

## 6. State Management

| State | Where | Survives restart? | Cleared by |
|-------|-------|-------------------|------------|
| Pending PRs marker | `store/restart-pending.json` | Yes (filesystem) | Service startup |
| Build artifacts | `dist/` | Yes | Next build overwrites |
| Service process | systemd | Yes (auto-restart on crash) | Manual stop |

**Edge case: service crashes and auto-restarts.** The marker is cleared — correct behavior, because the restarted service loads the latest `dist/`. The human doesn't need to do anything.

**Edge case: marker gets stale (nobody restarts for days).** SessionStart hook keeps warning. Telegram notification was already sent. The marker accumulates PRs with timestamps, so staleness is visible.

**Edge case: two agents merge simultaneously.** Branch protection's `strict: true` serializes merges to main. The marker file is written sequentially. No race condition.

## 7. What Exists vs What Needs Building

### Already Solved

| Capability | Current implementation | Status |
|------------|----------------------|--------|
| Post-merge gate | `enforce-post-merge-stop.sh` blocks agent stop until /kaizen runs | Working (L2) |
| Build + restart instructions | CLAUDE.md "Post-Merge: Deploy & Maintenance Policy" | Working (L1) |
| Telegram notification from agent | IPC message files in `data/ipc/{group}/messages/` | Working |
| SessionStart hooks | `.claude/settings.json` supports SessionStart event | Working |
| Service management | systemd user service | Working |

### Needs Building

| Component | What | Depends on |
|-----------|------|------------|
| Marker writer | Append PR to `store/restart-pending.json` after build | Post-merge workflow |
| SessionStart hook | Read marker, warn human | Marker file convention |
| Startup clearance | Delete marker on service start | `src/index.ts` change |
| `/deploy` skill | Build + restart + verify cycle | Marker file convention |
| Post-merge workflow update | Add "build and write marker" step | Marker writer |

## 8. Open Questions

1. **Should the Telegram notification be smart about batching?** If 3 PRs merge in quick succession, should it send 3 messages or batch into one? Lean: send per-merge, keep it simple. The human can glance at them.

2. **Should `/deploy` also handle container rebuilds?** Container builds take 1-5 minutes and are rarer. Lean: yes, track `change_type` in the marker so `/deploy` knows what to build. But don't auto-trigger container builds in the post-merge flow — they're too expensive.

3. **Should the marker track the human who was notified?** Useful if multiple admins exist. Lean: not yet — single-user system for now.

4. **Should the SessionStart hook block or just warn?** Lean: warn only. Blocking session start would prevent the human from doing anything, including deploying. A prominent warning is sufficient.

## 9. Implementation Sequencing

These components are loosely coupled. Suggested order:

1. **Marker file convention + startup clearance** — establishes the contract. Smallest useful PR.
2. **`/deploy` skill** — immediately useful even without the marker (manual build+restart).
3. **SessionStart hook** — reads the marker, warns the human.
4. **Post-merge marker writer + notification** — closes the loop, makes it fully automated.

Each PR is independently useful. PR 1+2 give humans `/deploy`. PR 3 adds passive awareness. PR 4 adds active notification.
