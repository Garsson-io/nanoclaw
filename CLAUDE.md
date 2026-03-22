# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Cases — Isolated Work Items

Every piece of work is a **case**. Cases provide isolated containers, sessions, and (for dev) git worktrees. See `.claude/skills/cases/SKILL.md` for full docs.

**Architecture:** Cases are backed by a cloud CRM (GitHub Issues for the demo company, replaceable with any CRM). SQLite is a **local cache** — fast and offline-capable, but not the source of truth. All case access goes through the domain model (`cases.ts`) or MCP abstraction — never raw SQL.

- **work** cases use tooling to do useful work. **dev** cases improve tooling/workflows.
- Lifecycle: `SUGGESTED → BACKLOG → ACTIVE → DONE → REVIEWED → PRUNED`
- Kaizen: on completion, agents reflect on impediments and suggest dev improvements.
- With 2+ active cases, Haiku routes incoming messages to the right case.
- Replies are prefixed `[case: name]` in Telegram.
- **All dev work MUST be in a case with its own worktree.** Never modify code in main checkout. Enforced by `enforce-case-exists.sh` (L2 hook — blocks source edits in worktrees without a case).
- **Dev safe word escalation:** Non-main groups normally spawn work agents. Including a configured safe word in the trigger message escalates to dev mode. See `docs/safe-word-dev-escalation-spec.md`.
- Case naming: `YYMMDD-HHMM-kebab-description` (e.g., `260315-1430-fix-auth`)
- **Kaizen case naming:** `YYMMDD-HHMM-kNN-kebab-description` (e.g., `260318-2107-k21-fix-newline-prefix`). The `kNN` embeds the kaizen issue number.

## Harness / Vertical Architecture

NanoClaw is a **harness** powering multiple private vertical business repos. **Read [`docs/harness-vertical-architecture.md`](docs/harness-vertical-architecture.md)** when deciding where code/deps belong (harness vs vertical, Dockerfile vs package.json).

Key rules: Never install system packages on the host. Domain code goes in the vertical repo. Verticals are mounted at `/workspace/extra/{name}/`.

## Architecture Layers & File Naming

**Read [`docs/architecture-layers.md`](docs/architecture-layers.md)** when writing new files or modifying layer boundaries. File names encode which layer they belong to — do not mix layers.

Key pattern: `mcp-*` (container) → `ipc-*` (handlers) → `{domain}.ts` (model) → `{domain}-backend-{provider}.ts` (sync) → `{provider}-api.ts` (REST).

## Key Files

| File                                | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `src/index.ts`                      | Orchestrator: state, message loop, agent invocation        |
| `src/cases.ts`                      | Case model, DB ops, workspace management, lifecycle        |
| `src/case-auth.ts`                  | Case creation authorization gate                           |
| `src/case-backend.ts`               | Backend-agnostic sync adapter interface                    |
| `src/case-backend-github.ts`        | GitHub Issues CRM backend implementation                   |
| `src/case-router.ts`               | Haiku-based message routing to cases                       |
| `src/channels/registry.ts`          | Channel registry (self-registration at startup)            |
| `src/ipc.ts`                        | IPC watcher + dispatcher                                   |
| `src/ipc-cases.ts`                  | Case lifecycle IPC handlers                                |
| `src/github-api.ts`                 | GitHub REST API client (shared by CRM + kaizen)            |
| `src/router.ts`                     | Message formatting and outbound routing                    |
| `src/config.ts`                     | Trigger pattern, paths, intervals                          |
| `src/container-runner.ts`           | Spawns agent containers with mounts                        |
| `src/task-scheduler.ts`             | Runs scheduled tasks                                       |
| `src/db.ts`                         | SQLite operations                                          |
| `store/messages.db`                 | SQLite database (messages, chats, cases, api_usage)        |
| `groups/{name}/CLAUDE.md`           | Per-group memory (isolated)                                |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill               | When to Use                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/setup`            | First-time installation, authentication, service configuration                                                        |
| `/customize`        | Adding channels, integrations, changing behavior                                                                      |
| `/debug`            | Container issues, logs, troubleshooting                                                                               |
| `/update-nanoclaw`  | Bring upstream NanoClaw updates into a customized install                                                             |
| `/contribute-skill` | Build and submit a new skill to the NanoClaw ecosystem                                                                |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch                                                         |
| `/get-qodo-rules`   | Load org- and repo-level coding rules from Qodo before code tasks                                                     |

<!-- BEGIN KAIZEN PLUGIN — managed by /kaizen-setup. Do not edit this section manually. -->

## Kaizen — Continuous Improvement

Kaizen is installed as a plugin at `.kaizen/`. It provides enforcement hooks, reflection workflows, and dev workflow skills. Configuration in `kaizen.config.json`.

### Kaizen Skills

| Skill | When to Use |
|-------|-------------|
| `/kaizen-reflect` | Post-work reflection — classify impediments, file issues (Level 1→2→3) |
| `/kaizen-pick` | Select next kaizen issue — filters claimed, balances epic momentum vs diversity |
| `/kaizen-gaps` | Strategic analysis — tooling/testing gaps, horizon concentration, unnamed dimensions |
| `/kaizen-deep-dive` | Autonomous deep-dive — fix root cause category behind repeated issues |
| `/kaizen-audit-issues` | Periodic issue taxonomy audit — label coverage, epic health, incidents |

### Dev work skill chain — MUST follow this workflow

**Full workflow docs:** [`.kaizen/.claude/kaizen/workflow.md`](.kaizen/.claude/kaizen/workflow.md)

Key triggers — activate the right skill for the user's intent:

- "gap analysis", "analyze gaps", "tooling gaps" → `/kaizen-gaps`
- "make a dent", "hero mode", "deep dive" → `/kaizen-deep-dive`
- "what's next", "pick work", "pick a kaizen" → `/kaizen-pick`
- "look at issue #N", "evaluate this" → `/kaizen-evaluate`
- "lets do it", "go ahead", "build it", "ship it" → `/kaizen-implement`

### The Zen of Kaizen

Run `/kaizen-zen` to see the full commentary ([`.kaizen/.claude/kaizen/zen.md`](.kaizen/.claude/kaizen/zen.md)).

### Kaizen Policies

**Generic policies:** [`.kaizen/.claude/kaizen/policies.md`](.kaizen/.claude/kaizen/policies.md) — recursive kaizen, hooks infrastructure, worktree isolation, co-commit tests, smoke tests ship with feature.

**Host-specific policies:** [`.claude/kaizen/policies-local.md`](.claude/kaizen/policies-local.md) — project-specific enforcement rules.

### Verification Discipline

**Read [`.kaizen/.claude/kaizen/verification.md`](.kaizen/.claude/kaizen/verification.md)** before writing fixes or tests. Covers: path tracing, invariant statements, runtime artifact verification, smoke tests.

### Kaizen Backlog

Future work tracked as GitHub Issues. Issue taxonomy in [`.kaizen/docs/issue-taxonomy.md`](.kaizen/docs/issue-taxonomy.md). Every issue MUST have: `kaizen` + level (`level-1`/`level-2`/`level-3`) + area label.

<!-- END KAIZEN PLUGIN -->

## Dev Agent Policies

These policies were learned from past mistakes. Follow them strictly.

1. **Architecture decisions require explicit approval.** Present options with tradeoffs and ask Aviad before proceeding.
2. **NEVER install system packages on the host machine** (no `sudo apt install`). System deps go in Dockerfiles. npm deps go in `package.json`.
3. **Research before installing.** Check existing skills first. Evaluate alternatives. Present findings before proceeding.
4. **Ask "harness or vertical?"** before writing any code. See [`docs/harness-vertical-architecture.md`](docs/harness-vertical-architecture.md).
5. **Put durable knowledge in CLAUDE.md and docs/, not just local memory.** `~/.claude/` memory is not synced to git.
6. **Work agents get read-only tools.** Dev agents modify in worktrees.
7. **Write tests BEFORE production code (TDD).** RED → GREEN → REFACTOR. See kaizen #120.
8. **Skill branches must stay clean.** Never merge fork's main into a `skill/*` branch. Cherry-pick only.
9. **Declare ALL dependencies.** Every `require()` or `import` must have a `package.json` entry.
10. **Prefer simpler dependency stacks.** Fewer deps = fewer failure points.

11. **`--dangerously-skip-permissions` does NOT bypass hooks.** It auto-approves built-in tool permission prompts, but custom hooks (PreToolUse deny, PostToolUse gates) still fire and enforce. Use `--bare` to skip hooks entirely (also skips CLAUDE.md, skills, LSP). See kaizen #353.

**All dev work MUST be in a case.** If `/kaizen-implement` activates, create a case with worktree before writing any code. **Kaizen issue lifecycle:** `status:active`/`status:done` labels are auto-synced by `case-backend-github.ts`. Collision detection in `ipc-cases.ts` blocks duplicate case creation for the same issue.

Host-side case ops: `npx tsx src/cli-cases.ts case-create|case-list|case-by-branch|case-update-status`.

## Merging PRs & Post-Merge Deploy

**Read [`docs/merging-prs.md`](docs/merging-prs.md)** for the full merge procedure, CI monitoring, troubleshooting, and post-merge auto-deploy.

Key points: Use `gh pr merge --squash --delete-branch --auto`. Monitor CI with `gh run view`. After merge, sync main with `git -C "$MAIN_CHECKOUT" fetch origin main && git -C "$MAIN_CHECKOUT" merge --ff-only origin/main`. **NEVER `cd` to the main checkout.**

## Database

SQLite at `store/messages.db`. Uses `better-sqlite3` (NOT `sqlite3` CLI). **For cases, use the CLI:**

```bash
npx tsx src/cli-cases.ts case-list                              # all cases
npx tsx src/cli-cases.ts case-list --status active,blocked       # filter by status
npx tsx src/cli-cases.ts case-by-branch <branch-name>            # find case for a branch
npx tsx src/cli-cases.ts case-update-status <name> <status>      # update case status
```

For other tables: `node -e "const db=require('better-sqlite3')('store/messages.db'); ..."`

Tables: `messages`, `chats`, `cases`, `sessions`, `api_usage`, `usage_categories`, `scheduled_tasks`, `task_run_logs`, `registered_groups`, `router_state`.

## Development

Run commands directly — don't tell the user to run them.

```bash
npm install          # Install deps (also installs container/agent-runner deps via postinstall)
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:

```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** Run `/add-whatsapp` to install the separate channel fork. Existing auth and groups are preserved.

## Sending Messages via IPC

**Read [`docs/ipc-messaging.md`](docs/ipc-messaging.md)** for how to send Telegram messages from the host via IPC files. Key: type is `"message"` (not `"send_message"`), directory is `messages/` (not `tasks/`).

## End-of-Session Cleanup

1. **Dirty files** — `git status` on main and all verticals. Commit meaningful changes, discard noise.
2. **Stale branches** — delete local branches for merged PRs (`git branch -d`). Use `-d` not `-D`.
3. **Stale worktrees** — prune ONLY worktrees you created. **NEVER force-remove others'.**
4. **Kaizen issues** — close any resolved issues in `Garsson-io/kaizen`.
5. **Service health** — `systemctl --user status nanoclaw` — verify active and running.
6. **Notify leads** if any pending action items remain.

## Git Remotes

- `origin` = `Garsson-io/nanoclaw` (our fork — PRs go here)
- `upstream` = `qwibitai/nanoclaw` (upstream — only for skill contributions)

**Always use `--repo Garsson-io/nanoclaw`** with `gh` commands.

## Docker Image Lifecycle

**Read [`docs/docker-image-lifecycle.md`](docs/docker-image-lifecycle.md)** for build rotation, garbage collection, and cache policy.

Key: `./container/build.sh` (build), `./container/gc.sh` (cleanup), `./container/status.sh` (status). **Never run `docker builder prune --all`** — it nukes base layers.
