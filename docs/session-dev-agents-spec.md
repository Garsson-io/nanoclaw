# Session-Based Dev Agents — Clone-Inside-Container Architecture

Status: **Draft** | Author: Aviad + Claude | Date: 2026-03-19

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Architecture Decision: Clone Inside Container](#2-architecture-decision-clone-inside-container)
3. [Dev Agent Lifecycle](#3-dev-agent-lifecycle)
4. [Bot Identity & Interaction](#4-bot-identity--interaction)
5. [Container Setup & Filesystem Layout](#5-container-setup--filesystem-layout)
6. [Trigger Mechanisms](#6-trigger-mechanisms)
7. [Scenarios](#7-scenarios)
8. [Changes to Existing Architecture](#8-changes-to-existing-architecture)
9. [Security Model](#9-security-model)
10. [Phase 2: Coding as a Vertical](#10-phase-2-coding-as-a-vertical)
11. [Open Questions & Risks](#11-open-questions--risks)

---

## 1. Problem Statement

### 1.1 What We Want

Two capabilities within days:

1. **Scheduled kaizen picker**: Every hour, a dev agent autonomously selects a kaizen issue, implements it, runs tests, pushes a branch, and creates a PR.
2. **Work-to-dev escalation**: A work agent encounters friction, files a dev case. Aviad approves via Telegram. A dev agent picks it up, implements the fix, creates a PR.

### 1.2 Why the Current Architecture Blocks This

The current dev agent model mounts a **host git worktree read-write** into the container. This creates three problems:

**Problem 1: Mount security complexity.** `mount-security.ts` enforces `nonMainReadOnly` for non-main groups. Dev cases need an exception (`caseType` parameter plumbed through validation). Every new trust-level exception adds attack surface.

**Problem 2: Host filesystem risk.** A buggy dev agent can corrupt the host worktree, affecting other agents or the running service. The host worktree persists after the container dies -- corrupted state is permanent.

**Problem 3: Per-message lifecycle.** Containers are spawned per message and killed after responding. A dev agent that clones a repo on startup can't amortize that cost across a single message. Dev work requires sustained sessions -- reading code, modifying files, running tests, iterating -- not request-response cycles.

### 1.3 The Insight: Separate Code Access from Host Mounts

The dev agent doesn't need write access to host files. It needs:
- **Read access** to the current codebase (for reference)
- **Write access** to its own copy (for modifications)
- **Push access** to GitHub (to create branches and PRs)

Read access is already solved: repos are mounted read-only. Write access can be solved inside the container via `git clone --local`. Push access is already solved: `GITHUB_TOKEN` is injected for dev cases.

The output of a dev agent is a **GitHub PR**, not files on the host.

### 1.4 Comparison with OpenClaw

OpenClaw handles self-improvement by modifying markdown files directly on the host -- prompt files, skill definitions, configuration. This is fast but limited to Level 1 (instructions). OpenClaw agents cannot modify their own runtime code.

NanoClaw's dev agents go further: they modify actual source code, create PRs, and change the runtime after human review. This requires a more robust isolation model than "edit files in place."

The clone-inside-container model gives NanoClaw Level 3 self-improvement (architectural code changes) with the same safety properties as OpenClaw's Level 1 approach: the running system is never at risk.

---

## 2. Architecture Decision: Clone Inside Container

### 2.1 Three Options Evaluated

```
Option A: Host worktree mounted read-write (current design)
  Host creates worktree -> mounts rw into container -> agent works -> pushes
  X Requires mount-security exceptions (kaizen #128)
  X Host filesystem at risk from buggy agent
  X Worktree persists after container dies (cleanup burden)

Option B: Network clone inside container
  Container starts -> git clone from GitHub -> agent works -> pushes -> dies
  + Zero host risk
  X ~30s clone time per session (network dependent)
  X Requires network for setup

Option C: Local clone from read-only mount (CHOSEN)
  Container starts -> git clone /workspace/project /tmp/work -> agent works -> pushes -> dies
  + Zero host risk -- container filesystem is ephemeral
  + ~2-3s clone time (local, uses hardlinks)
  + No mount-security changes needed
  + Agent has full write access inside container
  + ro mount serves as fast local cache
```

### 2.2 Why Option C Wins

```
                          +-----------------------------+
                          |        Container             |
                          |                              |
  Host filesystem         |  /workspace/project (ro)  ---|---- Read reference
  -----------------       |       | git clone --local    |
  /home/user/projects/    |       v                      |
  nanoclaw/ --------------|  /tmp/nanoclaw/ (rw)      ---|---- Modify, commit
                          |       | git push             |
  /home/user/projects/    |       v                      |
  garsson-prints/ --------|  GitHub (remote)          ---|---- PR created
                          |                              |
                          |  /workspace/extra/prints (ro)|
                          |       | git clone --local    |
                          |       v                      |
                          |  /tmp/garsson-prints/ (rw)---|---- Modify vertical
                          |       |                      |
                          |       +-- tools/ (executable)|---- Run vertical tools
                          |                              |
                          +-----------------------------+
                                    |
                                    | Container dies
                                    v
                              Ephemeral filesystem
                              gone. Code lives on
                              GitHub only.
```

The read-only mount serves three purposes:
1. **Fast clone seed** -- `git clone /workspace/project /tmp/work` uses local objects (~2-3s)
2. **Reference** -- agent can diff against current main without network
3. **Vertical tools** -- agent can run tools from the mount or clone

### 2.3 Multiple Repos in One Session

A dev agent may need to modify both NanoClaw and a vertical repo in the same session:

```
Container filesystem layout:
  /workspace/project/              <- NanoClaw (ro mount from host)
  /workspace/extra/garsson-prints/ <- Vertical (ro mount from host)
  /tmp/nanoclaw/                   <- Writable clone of NanoClaw
  /tmp/garsson-prints/             <- Writable clone of vertical
```

Both clones are independent. Agent can modify, test, commit, and push both. The `GITHUB_TOKEN` has access to both repos.

Vertical tools (preflight.py, transform.py) run from the writable clone -- the agent can modify a tool AND test it in the same session, with full access to the container's installed dependencies (Pillow, PyMuPDF, Ghostscript, etc.).

---

## 3. Dev Agent Lifecycle

### 3.1 Session-Based, Not Message-Based

Work agents are message-based: receive message -> process -> respond -> idle timeout -> die.

Dev agents are **session-based**: activated -> work autonomously to completion -> push results -> notify -> die.

```
+----------------------------------------------------------+
|                   Dev Agent Lifecycle                     |
|                                                          |
|  1. ACTIVATION                                           |
|     Trigger: cron schedule, Telegram approval, or        |
|              safe-word escalation                         |
|     -> Claim bot identity from swarm pool                |
|     -> Spawn container with ro mounts + GITHUB_TOKEN     |
|                                                          |
|  2. SETUP (~2-3s)                                        |
|     -> git clone /workspace/project /tmp/nanoclaw        |
|     -> git clone /workspace/extra/* /tmp/*  (if needed)  |
|     -> Set remotes to GitHub URLs                        |
|     -> Create feature branch                             |
|                                                          |
|  3. WORK (5-30 minutes)                                  |
|     -> Read kaizen issue / case description              |
|     -> Implement changes                                 |
|     -> Run tests                                         |
|     -> Iterate until tests pass                          |
|     -> Can receive pings from admin via bot identity     |
|                                                          |
|  4. DELIVER                                              |
|     -> git push -u origin feature-branch                 |
|     -> gh pr create (with kaizen issue link)             |
|     -> Notify admin via Telegram: "PR created: [url]"    |
|                                                          |
|  5. CLEANUP                                              |
|     -> Mark case as DONE (if PR created successfully)    |
|     -> Kaizen reflection (impediments, suggestions)      |
|     -> Release bot identity back to pool                 |
|     -> Container dies. Ephemeral filesystem gone.        |
|                                                          |
|  FAILURE PATH:                                           |
|     -> If tests fail after N retries: push WIP branch    |
|     -> Mark case BLOCKED with reason                     |
|     -> Notify admin: "Stuck on [issue], WIP at [branch]" |
|     -> Release bot identity. Container dies.             |
|                                                          |
+----------------------------------------------------------+
```

### 3.2 Critical Safety Rule: Always Push Before Dying

The container filesystem is ephemeral. If the agent doesn't push, all work is lost.

**Enforcement (Level 3):** The container entrypoint includes a shutdown hook that checks for unpushed commits and pushes them to a WIP branch if the agent didn't push explicitly.

```bash
# Container shutdown hook (pseudocode)
on_exit() {
  for repo in /tmp/nanoclaw /tmp/garsson-*; do
    cd "$repo" 2>/dev/null || continue
    if [ -n "$(git log origin/main..HEAD 2>/dev/null)" ]; then
      git push -u origin "wip/$(cat /tmp/case-name)" --force 2>/dev/null || true
    fi
  done
}
trap on_exit EXIT
```

### 3.3 Timeout and Resource Limits

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max session duration | 30 minutes | Prevents runaway agents. Most kaizen issues complete in 10-20 min. |
| Idle timeout | 5 minutes | If agent stops producing output for 5 min, something is wrong. |
| Max cost per session | Configurable ($5 default?) | Token budget guard. Agent receives remaining budget in prompt. |
| Memory limit | 4GB | Enough for TypeScript compilation + Python tools. |

---

## 4. Bot Identity & Interaction

### 4.1 Dev Agents Claim Swarm Bots

When a dev agent session starts, it claims a bot identity from the Telegram swarm pool. This bot becomes the agent's communication channel for the duration of the case.

```
Bot Pool:
  +---------+  +---------+  +---------+  +---------+
  | DevAda  |  | DevBob  |  | DevCarol|  | DevDave |
  | [busy]  |  | [free]  |  | [free]  |  | [free]  |
  +---------+  +---------+  +---------+  +---------+
                    |
                    v
  Dev agent claims DevBob for case "260319-0554-k128"
  DevBob sends: "Starting work on kaizen #128: ..."
  ...
  DevBob sends: "PR created: https://github.com/..."
  DevBob released back to pool.
```

### 4.2 Admin Can Ping the Agent

While the dev agent is running, the admin can message the claimed bot to interact:

```
Aviad -> DevBob: "How's it going?"
DevBob -> Aviad: "Running tests. 3 passing, 1 failing -- working on the mount validation edge case."

Aviad -> DevBob: "Skip the edge case, ship what you have"
DevBob -> Aviad: "OK, pushing current state and creating PR."
```

**Implementation:** The container's IPC channel already supports inbound messages. The claimed bot routes incoming messages to the dev agent's container. The agent receives them as part of its conversation and can respond.

### 4.3 Bot-Case Assignment Table

```sql
CREATE TABLE bot_assignments (
  id INTEGER PRIMARY KEY,
  bot_id TEXT NOT NULL,          -- e.g., "pool_bot_2" (internal ID)
  bot_name TEXT NOT NULL,        -- e.g., "DevBob" (display name)
  case_id TEXT REFERENCES cases(id),
  group_folder TEXT NOT NULL,    -- which Telegram group
  assigned_at TEXT NOT NULL,
  released_at TEXT,              -- NULL while active
  UNIQUE(bot_id, released_at)   -- one active assignment per bot
);
```

**Assignment flow:**
1. Case activated -> query for free bot in group -> claim it (insert row)
2. Container spawned with `NANOCLAW_BOT_ID` env var
3. Agent uses `send_message` MCP with `sender` matching bot name
4. Case done -> update `released_at` -> bot available for next case

**Exhaustion handling:** If all bots are busy, the case enters a queue. The scheduler retries on the next cycle. Notification to admin: "All dev bots busy. Case [name] queued."

### 4.4 Naming Convention

Per the case-isolation spec, dev agents use distinct names from work agents to avoid confusion:

- **Work agents**: Service-oriented names (Alice, Bob, Carol)
- **Dev agents**: Engineer-themed names (Ada, Linus, Grace, Dijkstra) or D-prefixed (DevAda, DevBob)

This prevents a customer from confusing a dev bot with their work agent.

---

## 5. Container Setup & Filesystem Layout

### 5.1 Dev Container Mounts

```
MOUNTS (all read-only from host):
  -v /path/to/nanoclaw:/workspace/project:ro
  -v /path/to/garsson-prints:/workspace/extra/garsson-prints:ro
  -v /path/to/sessions/case/{id}:/home/node/.claude:rw     # session persistence
  -v /path/to/ipc/{group}/:/workspace/ipc:rw               # IPC for messaging

ENVIRONMENT:
  GITHUB_TOKEN=ghp_...
  GH_TOKEN=ghp_...
  NANOCLAW_CASE_ID=42
  NANOCLAW_CASE_NAME=260319-0554-k128-pass-casetype
  NANOCLAW_CASE_TYPE=dev
  NANOCLAW_DEV_MODE=1
  NANOCLAW_BOT_ID=pool_bot_2
  NANOCLAW_BOT_NAME=DevBob

NO read-write host mounts for code. Zero.
```

### 5.2 Entrypoint Bootstrap

The container entrypoint for dev agents performs setup before invoking the Claude agent:

```bash
#!/bin/bash
# dev-agent-bootstrap.sh
set -euo pipefail

# 1. Clone repos from ro mounts (fast, local)
if [ -d /workspace/project/.git ]; then
  git clone /workspace/project /tmp/nanoclaw
  cd /tmp/nanoclaw
  git remote set-url origin \
    "https://x-access-token:${GITHUB_TOKEN}@github.com/Garsson-io/nanoclaw.git"
fi

# 2. Clone any vertical repos
for extra in /workspace/extra/*/; do
  name=$(basename "$extra")
  if [ -d "$extra/.git" ]; then
    git clone "$extra" "/tmp/$name"
    # Remote URL set by agent based on case requirements
  fi
done

# 3. Register shutdown hook -- always push before dying
trap 'push_wip_if_needed' EXIT

# 4. Start the Claude agent
exec claude --resume "${SESSION_ID}" ...
```

### 5.3 Filesystem Layout Inside Container

```
/workspace/
  project/                    <- NanoClaw (ro mount, reference only)
  extra/
    garsson-prints/           <- Vertical (ro mount, reference + tool source)
  ipc/                        <- IPC channel (rw, for messaging)

/tmp/
  nanoclaw/                   <- Writable clone of NanoClaw
    src/                      <- Agent modifies code here
    dist/                     <- Agent can build here
    container/                <- Agent can modify Dockerfile
  garsson-prints/             <- Writable clone of vertical
    tools/                    <- Agent can modify AND run tools
    workflows/                <- Agent can modify workflow definitions
    config/                   <- Agent can modify vertical config

/home/node/.claude/           <- Session files (rw mount, persists)
```

---

## 6. Trigger Mechanisms

### 6.1 Scheduled Kaizen Picker (Cron)

```
+----------------------------------------------------+
|              Hourly Kaizen Cron                     |
|                                                     |
|  Every 1hr:                                         |
|    1. Query kaizen backlog (open, no status:active) |
|    2. Score issues (epic momentum, diversity)       |
|    3. Filter: approved=true OR auto-approvable      |
|    4. Select top issue                              |
|    5. Create dev case                               |
|    6. Claim bot identity                            |
|    7. Spawn dev container                           |
|    8. Agent works to completion                     |
|    9. PR created -> notify admin                    |
|   10. Container dies                                |
|                                                     |
|  Auto-approve criteria (configurable):              |
|    - Issue has "approved" label                     |
|    - Issue is in an approved epic                   |
|    - Estimated diff < N lines                       |
|                                                     |
|  Otherwise: notify admin, wait for approval         |
|  (picked up on next hourly cycle if approved)       |
+----------------------------------------------------+
```

### 6.2 Telegram-Triggered Dev Work

```
Admin flow:
  Aviad sees notification: "Work agent filed dev case: glossary lookup fails for Hebrew"
  Aviad in Telegram: "@DevBot accept case 260319-1200-fix-glossary"
  -> System creates dev case (or activates existing suggested case)
  -> Claims bot identity (e.g., DevBob)
  -> Spawns dev container
  -> DevBob: "Starting work on fix-glossary. I'll update you when I have a PR."
  ...
  -> DevBob: "PR created: https://... -- fixes Hebrew glossary lookup"
```

### 6.3 Work-to-Dev Escalation (Automated)

```
+----------------------+     +---------------------+
|     Work Agent       |     |    Dev Pipeline      |
|                      |     |                      |
|  Encounters friction |     |                      |
|  -> case_suggest_dev |---->|  Kaizen issue filed  |
|    (MCP tool)        |     |  status: suggested   |
|                      |     |                      |
|  Continues work      |     |  Admin notified      |
|  (not blocked)       |     |  via Telegram        |
|                      |     |                      |
+----------------------+     |  Admin approves      |
                             |  (or auto-approved)  |
                             |         |            |
                             |         v            |
                             |  Next cron cycle     |
                             |  picks it up         |
                             |         |            |
                             |         v            |
                             |  Dev agent runs      |
                             |  PR created          |
                             |  Admin notified      |
                             +---------------------+
```

---

## 7. Scenarios

### Scenario 1: Hourly Kaizen -- Happy Path

```
[10:00] Cron fires. Queries Garsson-io/kaizen for open issues.
        Finds #130: "Add retry logic to prepress preflight" (approved label).
        Scores highest (small diff, approved, unblocked).

[10:00] Creates dev case: 260319-1000-k130-preflight-retry
        Claims bot: DevAda
        Spawns container.

[10:00] DevAda in Telegram: "Starting kaizen #130 -- adding retry logic to
        prepress preflight."

[10:02] Container bootstrap: clones NanoClaw + garsson-prints from ro mounts (~3s).
        Agent reads issue, examines tools/preflight.py, plans fix.

[10:08] Agent modifies /tmp/garsson-prints/tools/preflight.py.
        Runs: python3 /tmp/garsson-prints/tools/preflight.py test.pdf -> passes.
        Writes test. Runs test suite -> all pass.

[10:12] git push -u origin fix/260319-1000-k130-preflight-retry
        gh pr create --title "fix: add retry logic to prepress preflight"
                     --body "Fixes Garsson-io/kaizen#130 ..."

[10:12] DevAda in Telegram: "PR created: https://github.com/.../pull/42
        Adds exponential backoff retry for transient PIL errors."

[10:13] Case marked DONE. Kaizen reflection filed. Bot released. Container dies.
```

### Scenario 2: Admin Interaction Mid-Session

```
[14:00] Dev agent (DevBob) working on kaizen #135: refactor container-runner.

[14:10] Aviad -> DevBob: "Are you touching the mount logic?"
        DevBob -> Aviad: "No, I'm extracting buildContainerArgs into a separate
                          file. The mount logic stays in container-runner.ts."

[14:15] Aviad -> DevBob: "Good. Also update CLAUDE.md architecture table."
        DevBob -> Aviad: "Will do."

[14:22] DevBob -> Aviad: "PR created: https://... -- extracts container arg
                          building to container-args.ts. Updated architecture
                          table in CLAUDE.md."
```

### Scenario 3: Failure -- Tests Don't Pass

```
[16:00] Dev agent (DevCarol) working on kaizen #140: add CMYK validation.

[16:15] Agent modifies transform.py. Runs tests. 2 failures.
[16:18] Agent tries fix. Runs tests. 1 failure.
[16:22] Agent tries another approach. Tests still fail.

[16:25] DevCarol in Telegram: "Stuck on kaizen #140. CMYK validation breaks
        the --flatten-bg option. Pushing WIP branch."

[16:25] git push -u origin wip/260319-1600-k140-cmyk-validation
        Case marked BLOCKED. Reason: "CMYK conversion conflicts with flatten-bg
        (both modify color space). Needs design decision."

[16:26] DevCarol released. Container dies. Code safe on GitHub in WIP branch.
```

### Scenario 4: Work Agent Files Dev Case

```
[09:00] Work agent (Alice) processing print order for customer.
        Tries to run preflight.py on customer's PDF.
        Tool crashes: "fitz.FileDataError: corrupted xref table"

[09:01] Alice to customer: "I'm having trouble reading your PDF. Let me flag
        this for our technical team."
        Alice calls case_suggest_dev: "preflight.py crashes on corrupted xref --
        needs graceful error handling instead of crash"

[09:01] Kaizen issue #142 created. Aviad notified via Telegram:
        "Work agent filed dev case: preflight.py crashes on corrupted xref"

[09:05] Aviad in Telegram: "approve #142"
        Issue gets "approved" label.

[10:00] Next cron cycle. Dev agent picks up #142.
        Implements try/except around fitz operations, returns structured error.
        Tests pass. PR created.

[10:15] Aviad reviews, merges. Vertical auto-updates (mounted live).
        Next time Alice runs preflight on a corrupted PDF, she gets a clean
        error instead of a crash.
```

### Scenario 5: All Dev Bots Busy

```
[11:00] Cron fires. DevAda and DevBob both active on cases.
        No free dev bots in pool.

[11:00] System logs: "All dev bots busy. Kaizen #145 queued."
        Aviad notified: "Dev bot pool exhausted. 1 issue queued."

[12:00] DevAda finishes. Released to pool.
        Cron fires. Claims DevAda for #145.
        Work proceeds normally.
```

---

## 8. Changes to Existing Architecture

### 8.1 What Changes

| Component | Current | New |
|-----------|---------|-----|
| `container-runner.ts` | Dev cases get rw host worktree mount | Dev cases get ro mount + clone bootstrap |
| `container-runner.ts` | Per-message lifecycle for all agents | Session-based lifecycle for dev agents |
| `mount-security.ts` | Needs caseType exception (kaizen #128) | **No changes needed** -- all mounts stay ro |
| Container Dockerfile | No clone bootstrap | Add dev-agent-bootstrap.sh entrypoint |
| `cases.ts` | Worktree created on host for dev cases | No host worktree needed for dev cases |
| Bot pool | Role-based naming, no case tracking | Bot-case assignment table |
| `task-scheduler.ts` | Runs work agent tasks | Also runs dev agent cron jobs |
| IPC | Messages routed to group containers | Messages routed to case containers via bot identity |

### 8.2 What Stays the Same

- **Work agents**: Unchanged. Per-message lifecycle, no code access, ro mounts.
- **Router**: Unchanged (not yet implemented, future work).
- **Case lifecycle**: Same states (SUGGESTED -> BACKLOG -> ACTIVE -> DONE -> REVIEWED -> PRUNED).
- **Kaizen issue tracking**: Same GitHub Issues backend.
- **mount-security.ts**: No changes. Everything stays read-only. **kaizen #128 becomes wontfix.**
- **Case auth**: Same approval gates for dev cases.

### 8.3 What Gets Removed (Eventually)

- Host worktree creation for dev cases (currently in `cases.ts`)
- `caseType` parameter in `buildVolumeMounts` (no rw mount logic needed)
- `enforce-case-exists.sh` hook's worktree checks (dev agents don't use host worktrees)

### 8.4 Implementation Phases

**Phase 1 (this spec):** Session-based dev agents with clone-inside-container. Minimal harness changes. Get autonomous kaizen working.

**Phase 2 (next):** Extract coding tools/workflows into `garsson-coding` vertical. Dev agents become regular work agents in the coding vertical. See section 10.

**Phase 3 (future, separate spec):** Router agent, work agent case routing, CRM integration -- as defined in `case-isolation-spec.md`.

---

## 9. Security Model

### 9.1 Trust Boundaries

```
+------------------------------------------------------+
| HOST (trusted)                                        |
|                                                       |
|  NanoClaw process                                     |
|  +-- Spawns containers                                |
|  +-- Manages bot pool                                 |
|  +-- Routes IPC messages                              |
|  +-- Never modified by agents                         |
|                                                       |
|  Host filesystem                                      |
|  +-- /projects/nanoclaw/     <- ro mount              |
|  +-- /projects/garsson-*/    <- ro mount              |
|  +-- Never written by agents                          |
|                                                       |
|------------------------------------------------------+
| CONTAINER (sandboxed)                                 |
|                                                       |
|  /workspace/project/  (ro)   <- can read, can't write |
|  /workspace/extra/*   (ro)   <- can read, can't write |
|  /tmp/*               (rw)   <- ephemeral, dies with  |
|                                 container             |
|  GITHUB_TOKEN                <- can push to GitHub    |
|                                                       |
|  Agent can:                                           |
|  +-- Clone repos locally (fast)                       |
|  +-- Modify cloned code                               |
|  +-- Run tools and tests                              |
|  +-- Push branches to GitHub                          |
|  +-- Create PRs                                       |
|  +-- Send messages via IPC                            |
|                                                       |
|  Agent cannot:                                        |
|  +-- Modify host filesystem                           |
|  +-- Affect other containers                          |
|  +-- Access customer data (no CRM tools)              |
|  +-- Survive container death (ephemeral)              |
|                                                       |
+------------------------------------------------------+
```

### 9.2 What If the Agent Goes Rogue?

| Threat | Mitigation |
|--------|------------|
| Agent pushes malicious code | PR requires human review before merge. Branch protection rules. |
| Agent pushes to main directly | Branch protection: main requires PR + CI + review. |
| Agent exhausts GitHub API | Token rate limits. Per-session cost cap. |
| Agent runs forever | 30-minute session timeout. Idle timeout. |
| Agent corrupts its own clone | Who cares -- it's ephemeral. Container dies, nothing persists. |
| Agent modifies ro mount | Docker enforces ro. Impossible without container escape. |
| Agent accesses customer data | No CRM MCP tools in dev container. No customer data mounted. |

### 9.3 Comparison: Host Worktree vs Clone-Inside-Container

| Risk | Host Worktree (old) | Clone-Inside-Container (new) |
|------|--------------------|-----------------------------|
| Host filesystem corruption | Possible (rw mount) | **Impossible** (ro mount) |
| Cross-agent contamination | Possible (shared host fs) | **Impossible** (ephemeral container fs) |
| Work lost on crash | No (host worktree persists) | Push-before-die hook mitigates |
| Stale worktree cleanup | Manual burden | **Automatic** (container dies = cleanup) |
| mount-security complexity | High (caseType exceptions) | **None** (all ro) |

---

## 10. Phase 2: Coding as a Vertical

### 10.1 The Vision

Phase 1 builds dev agents as a special case in the harness. Phase 2 refactors them into a proper vertical, eliminating the dev/work distinction entirely.

```
Garsson (harness)
+-- prints (vertical)
|   +-- capa_company        <- print work agents serve Capa
|   +-- delta_company       <- print work agents serve Delta
|
+-- insurance (vertical)
|   +-- ez_insurance        <- insurance agents serve EZ
|   +-- ynot_insurance      <- insurance agents serve Ynot
|
+-- coding (vertical)
    +-- garsson             <- coding agents modify the HARNESS
    +-- prints              <- coding agents modify the PRINTS VERTICAL
    +-- capa_company        <- coding agents modify Capa's configs/MDs
```

### 10.2 What Changes in Phase 2

| Concept | Phase 1 (harness) | Phase 2 (vertical) |
|---------|-------------------|--------------------|
| Dev agent | Special caseType in harness | Regular work agent in coding vertical |
| Git tools | Injected by harness for caseType=dev | Provided by coding vertical |
| GITHUB_TOKEN | Harness injects based on caseType | Vertical config declares credential needs |
| Kaizen issue | Filed to Garsson-io/kaizen | Filed as ticket with garsson-coding customer |
| Self-improvement | garsson improves itself | garsson-coding-garsson (just another customer) |
| Dev-work firewall | Explicit in harness code | Falls out of customer isolation |
| Access levels | Binary (dev or work) | Per-customer scoping (harness/vertical/config) |

### 10.3 Access Levels by Coding Customer

| Customer | What they can modify | Risk level |
|----------|---------------------|------------|
| `garsson-coding-capa_company` | `.md` files, `config/` in prints vertical | Low |
| `garsson-coding-prints` | Full prints vertical repo | Medium |
| `garsson-coding-garsson` | NanoClaw harness repo | High |

### 10.4 Why Phase 2 Is Not Phase 1

Phase 2 requires:
- Creating the `garsson-coding` repo with tools, workflows, customer configs
- Vertical-driven credential injection (harness passes creds based on vertical config)
- Customer onboarding flow for coding customers

This is more work than Phase 1, but Phase 1's dev agents are the **perfect tool to build Phase 2**. The first thing the dev agent builds is its own replacement as a vertical.

---

## 11. Open Questions & Risks

### 11.1 Open Questions

| Question | Options | Recommendation |
|----------|---------|----------------|
| **Max concurrent dev agents** | Fixed pool size (3-5 bots) | Start with 3, scale based on queue depth |
| **Auto-approve criteria** | Label-based, epic-based, size-based | Start with explicit "approved" label only |
| **Session persistence across retries** | Resume if agent fails | Yes -- use `--resume` with per-case session |
| **WIP branch naming** | `wip/{case-name}` vs `wip/{issue-number}` | `wip/{case-name}` -- contains timestamp + issue number |
| **Dev agent CLAUDE.md** | Same as host or specialized? | Specialized -- focused on dev workflow |
| **Cost tracking** | Per-session or per-case? | Per-case (may span retries) |
| **Clone depth** | Full clone or shallow? | Full -- agent may need git history for blame/log |

### 11.2 Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Unpushed work lost on crash** | Medium | Shutdown hook pushes WIP branch. Session files survive for retry. |
| **Clone diverges from main** | Low | 30 min max session. Agent can `git fetch` + `git merge` mid-session. |
| **Bot pool exhaustion** | Medium | Queue + admin notification. Easy to add more bots. |
| **Agent creates PR with failing CI** | Low | CI catches it. Agent can pre-run checks locally. |
| **Large repos slow to clone** | Low | Local clone uses hardlinks. ~5s max even for large repos. |
| **Vertical tool deps missing** | Low | Container Dockerfile includes deps. Vertical declares additional via config. |

---

## Appendix A: Sequence Diagrams

### A.1 Cron-Triggered Dev Agent

```
  Cron          Host           Container        GitHub        Telegram
   |              |               |               |              |
   |- tick ------>|               |               |              |
   |              |- query ------>|               |              |
   |              |  kaizen       |               |              |
   |              |  backlog      |               |              |
   |              |<- issue #130 -|               |              |
   |              |               |               |              |
   |              |- claim bot -->|               |              |
   |              |  (DevAda)     |               |              |
   |              |               |               |              |
   |              |- spawn ------>|               |              |
   |              |  container    |               |              |
   |              |               |- bootstrap -->|              |
   |              |               |  git clone    |              |
   |              |               |  (local, 2s)  |              |
   |              |               |               |              |
   |              |               |------- work -------->        |
   |              |               |  (5-20 min)   |              |
   |              |               |               |              |
   |              |               |-- IPC --------+------------->|
   |              |               |  "Starting    |    "Starting |
   |              |               |   #130"       |     #130"    |
   |              |               |               |              |
   |              |               |- git push --->|              |
   |              |               |- gh pr create>|              |
   |              |               |<- PR url -----|              |
   |              |               |               |              |
   |              |               |-- IPC --------+------------->|
   |              |               |  "PR created" |  "PR created"|
   |              |               |               |              |
   |              |<- exit -------|               |              |
   |              |- release bot >|               |              |
   |              |- case DONE -->|               |              |
```

### A.2 Admin-Triggered Dev Agent with Interaction

```
  Admin         Telegram        Host           Container       GitHub
   |              |               |               |              |
   |- "accept --->|               |               |              |
   |   case #42"  |-------------->|               |              |
   |              |               |- create case >|              |
   |              |               |- claim bot -->|              |
   |              |               |  (DevBob)     |              |
   |              |               |- spawn ------>|              |
   |              |               |               |- bootstrap ->|
   |              |               |               |              |
   |              |<--------------+-- IPC --------|              |
   |<- "DevBob:  -|               |  "Starting"   |              |
   |   Starting"  |               |               |              |
   |              |               |               |              |
   |- "How's it ->|               |               |              |
   |   going?"    |-------------->|               |              |
   |              |               |-- route to -->|              |
   |              |               |   DevBob's    |              |
   |              |               |   container   |              |
   |              |<--------------+-- IPC --------|              |
   |<- "Running --|               |  "3 pass,     |              |
   |   tests"     |               |   1 fail"     |              |
   |              |               |               |              |
   |              |               |               |- git push -->|
   |              |               |               |- gh pr ----->|
   |              |<--------------+-- IPC --------|              |
   |<- "PR: url" -|               |               |              |
```

---

## Appendix B: Relationship to Other Specs

| Spec | Relationship |
|------|-------------|
| `case-isolation-spec.md` | This spec refines the Dev Agent role (section 2.3). Layer 1 (container) is strengthened by eliminating rw host mounts. Layer 2 (worktree) is replaced by clone-inside-container. |
| `safe-word-dev-escalation-spec.md` | Safe word triggers remain valid. Instead of creating a host worktree, the escalation spawns a session-based dev container with clone bootstrap. |
| kaizen #128 | **Wontfix.** The problem (non-main groups get ro mounts for dev cases) is resolved by eliminating rw mounts entirely. |
| `case-isolation-spec.md` section 4.1 (Agent Swarm) | This spec adds bot-case assignment tracking on top of the existing swarm. Dev bots are claimed per case and released on completion. |
