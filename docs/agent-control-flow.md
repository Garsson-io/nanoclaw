# Agent Control Flow

<!-- TODO: rename this document to "kAIzen Agent Control Flow" — the name
     reflects that this is a kaizen-driven, AI-native development workflow,
     not just generic "agent control." -->

This document describes the automated development flow NanoClaw is trying to enforce, independent of whether the enforcement mechanism is Claude hooks, git hooks, CI, MCP tools, or harness code.

The goal is not "use Claude hooks." The goal is to preserve the workflow invariants below with the strongest portable control layer available.

## Why this exists

The current repo has good local hook comments and clear kaizen levels, but the overall enforcement story is spread across:

- `CLAUDE.md`
- `.claude/settings.json`
- `.claude/hooks/*.sh`
- `.claude/hooks/tests/*`

That makes it harder to answer:

- What exact developer flow are we trying to enforce?
- Which checks are advisory versus blocking?
- Which controls are portable to Codex or plain git workflows?
- What is gained or lost when a Claude hook moves to another layer?

This document is the canonical answer.

## Desired Flow

The intended dev workflow is:

1. Start from awareness of existing WIP.
2. Do dev work in an isolated worktree, never in the main checkout.
3. Prevent source-code writes in the main checkout.
4. Before shipping code, make a conscious decision about every dirty file.
5. Before PR creation or merge, think explicitly about tests and verification.
6. After PR creation, force a self-review loop before unrelated work continues.
7. Before the agent declares completion, run build/test verification.
8. After merge, trigger deployment verification, kaizen reflection, and cleanup.

The mechanisms may change. The flow should not.

## Core Invariants

These are the invariants the control system protects.

### Workspace isolation

- Dev work must happen in worktrees, not the main checkout.
- Main-checkout source code should not be edited directly.
- One worktree must not interfere with another worktree's state.

### Main checkout: what is and isn't allowed

The main checkout is the **running production instance**. It is not a development workspace. The only legitimate operations are:

| Operation | Allowed? | Why |
|-----------|----------|-----|
| `git fetch` | Yes | Read-only, no state change |
| `git pull origin main` (ff-only) | Yes | Required after every PR merge to sync production |
| `git worktree add/list/prune` | Yes | Managing worktrees is a main-checkout responsibility |
| Service ops (restart, build, status) | Yes | Main checkout is the deployment target |
| `git commit` (any branch) | **No** | Committing = dev work, dev work belongs in worktrees |
| `git push` (any branch) | **No** | If you have commits to push, you committed in the wrong place |
| `git checkout -b feature` + dev work | **No** | Creating a branch doesn't make the main checkout a workspace |
| Source file edits | **No** | Enforced by `enforce-worktree-writes.sh` |

**Walkthrough: why blocking only `main` branch is insufficient.**

Consider this scenario in the main checkout:

```bash
git checkout -b hotfix-typo    # create branch — still in main checkout
vim src/config.ts              # edit source — in the production directory
git add -A && git commit       # commit — if only "main" is blocked, this succeeds
git push -u origin hotfix-typo # push — if only "main" is blocked, this succeeds
```

This violates the workspace isolation invariant even though the branch isn't `main`. The developer is doing dev work in the production checkout. The branch name is irrelevant — what matters is **where** the work happens, not **what branch** it's on.

The correct enforcement is: block all commits and pushes from the main checkout, regardless of branch. The only way to get commits to push is to commit first, and if committing is blocked, there's nothing to push. The pre-push hook is defense-in-depth against `--no-verify` bypass of pre-commit.

### Shipping discipline

- Commits and pushes should come from an isolated worktree.
- PR creation should not happen with forgotten dirty files.
- Test and verification expectations must be explicit before merge.

### Review discipline

- Creating or updating a PR is not the end of the work.
- The agent must perform self-review before resuming unrelated work.
- Review state must be scoped to the current worktree only.

### Completion discipline

- The agent should not stop after changing code without verification.
- Merged changes require explicit post-merge verification and communication.
- Kaizen reflection must happen at workflow boundaries, not only when humans remember.

## Control Layers

These map directly to the kaizen model in `.claude/skills/kaizen/SKILL.md`.

### Level 1: Instructions

Examples:

- `CLAUDE.md`
- `SKILL.md`
- docs

Use when:

- judgment is required
- direction-setting matters
- the failure is new

Limitation:

- no enforcement

### Level 2: Automatic checks

Examples:

- Claude `PreToolUse` / `Stop`
- git hooks
- CI / branch protection

Use when:

- the rule is deterministic
- the failure can be checked automatically
- the cost of failure is moderate to high

Strength:

- blocks or fails the action automatically

Limitation:

- often tied to a specific event model

### Level 2.5: Structured tools

Examples:

- MCP tools
- dedicated workflow commands that become the approved path for a task

Use when:

- the agent must decide when to act
- the system should decide how the action is performed safely

Strength:

- preserves guided workflows across multiple agent runtimes

Limitation:

- weaker than Level 2 if raw commands remain available as a bypass

### Level 3: Mechanistic / architectural

Examples:

- read-only mounts
- mandatory worktree launcher
- protected merge/deploy wrappers
- harness code that makes the right thing automatic

Use when:

- humans should never pay for agent mistakes
- repeated failures have shown that checks are not enough
- the wrong thing should become impossible

Strength:

- strongest portability and strongest enforcement

Limitation:

- higher implementation cost

## Current Claude Hook Flow

The current hook orchestration is defined in `.claude/settings.json`:

- `SessionStart`
  - `check-wip.sh`
- `PreToolUse` on `Bash`
  - `enforce-pr-review.sh`
  - `enforce-case-worktree.sh`
  - `check-test-coverage.sh`
  - `check-verification.sh`
  - `check-dirty-files.sh`
- `PreToolUse` on `Edit|Write`
  - `enforce-worktree-writes.sh`
- `PostToolUse` on `Bash`
  - `pr-review-loop.sh`
  - `kaizen-reflect.sh`
- `Stop`
  - `verify-before-stop.sh`
  - `check-cleanup-on-stop.sh`

This yields the following control flow:

### 1. Session start

- Warn if the agent started in the main checkout.
- Surface existing WIP so the agent does not create duplicate or conflicting work.

### 2. During editing

- Block source-code writes in the main checkout.
- Keep runtime and memory directories writable.

### 3. During commit / push / PR actions

- Block commit or push outside a worktree.
- Block or warn on dirty files depending on the action.
- Warn or block around test coverage and verification requirements.

### 4. After PR creation or push

- Start or advance a review-state machine.
- Force self-review before unrelated work continues.

### 5. When stopping

- Verify changed TypeScript still typechecks and tests pass.
- Warn about local cleanup issues.

### 6. After merge

- Prompt kaizen reflection.
- Surface post-merge verification.
- Remind about cleanup.

## Portability Strategy

The right migration target is not "find a Codex replacement for every Claude hook event."

The right target is:

1. Move command-centric checks to git hooks.
2. Move PR policy and merge policy to CI and branch protection.
3. Move multi-step guided workflows to MCP tools.
4. Move high-cost invariants to architecture.
5. Keep agent-runtime-native reminders only where they are additive rather than essential.

## What is gained and lost by layer

### Moving a Claude hook to git hooks

Gained:

- works for Codex, Claude, and humans
- true Level 2 enforcement remains
- simple mental model

Lost:

- no transcript-native feedback
- only git events are covered
- cannot block arbitrary non-git commands

Best for:

- commit/push discipline
- local verification

### Moving a Claude hook to CI / branch protection

Gained:

- runtime-agnostic enforcement
- strong merge boundary protection
- transparent reviewable policy

Lost:

- feedback comes later
- weaker inner-loop ergonomics

Best for:

- PR metadata requirements
- merge-time tests and policy gates

### Moving a Claude hook to MCP tools

Gained:

- portable guided workflows
- one tool can enforce the safe way to do a complex operation
- maps well to Level 2.5

Lost:

- weaker if raw commands remain available
- requires more design than a simple hook

Best for:

- PR creation workflow
- review workflow
- task completion workflow

### Moving a Claude hook to Level 3 architecture

Gained:

- strongest enforcement
- no dependence on agent obedience
- portable across runtimes

Lost:

- less flexibility
- higher implementation cost

Best for:

- worktree isolation
- main-checkout write protection
- credential and trust-boundary rules

## Migration Plan

### Phase 1: document and normalize

- Add this document.
- Add a portability matrix for every hook.
- Make each hook header point back to this document.

Outcome:

- one shared control narrative
- easier migration planning

### Phase 2: portable Level 2

- Move commit/push discipline to git hooks.
- Move PR-body and merge policy to GitHub Actions.
- Keep Claude hooks as an early-feedback layer during transition.

Outcome:

- portable blocking checks for the most important command boundaries

### Phase 3: Level 2.5 workflow tools

- Introduce MCP tools for:
  - PR creation with required metadata and checks
  - review rounds
  - marking work done with verification
  - post-merge maintenance flow

Outcome:

- guided workflow that works in both Claude and Codex

### Phase 4: Level 3 hardening

- make the normal agent launcher open a worktree automatically
- make main-checkout source edits impossible or highly constrained
- move any human-time-critical invariants into architecture

Outcome:

- strongest, runtime-independent enforcement

## Design Rule

If a control exists only because a specific agent runtime offers a convenient event hook, it is not yet at its strongest form.

Prefer the strongest portable layer that preserves the intended workflow:

- architecture over hooks
- hooks over instructions
- structured tools over agent memory

Claude hooks remain useful, but they should be treated as one adapter for the control system, not the control system itself.
