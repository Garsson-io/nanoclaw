---
name: kaizen
description: Recursive process improvement — core workflow for continuous improvement across all verticals. Escalation framework (Level 1→2→3), reflection triggers, backlog management. Triggers on "kaizen", "process improvement", "improve processes", "recursive kaizen".
---

# Recursive Kaizen — Core Workflow

Kaizen is not optional. It is a CORE part of every piece of work. Every case completion, every fix-PR, every incident triggers a kaizen reflection that produces concrete, actionable output.

**Recursive kaizen** means improving how we improve. When a process improvement doesn't work, escalate the enforcement mechanism — don't just write another instruction.

## The Kaizen Cycle

```
  WORK ──▶ REFLECT ──▶ IDENTIFY ──▶ CLASSIFY ──▶ IMPLEMENT ──▶ VERIFY
   ▲                                                              │
   └──────────────────────────────────────────────────────────────┘
```

Every step produces output. Nothing is "just thinking."

### 1. REFLECT (triggered automatically)

Reflection happens at these mandatory checkpoints:

| Trigger | What to reflect on | Output |
|---------|-------------------|--------|
| Case completion | Impediments, friction, what slowed you down | Kaizen suggestions in case conclusion |
| Fix-PR | Root cause, why it happened, is the fix level sufficient | Kaizen section in PR description |
| Incident (human time wasted) | What failed, why the process didn't catch it | Immediate escalation assessment |
| Periodic review | Kaizen backlog triage, pattern detection | Priority adjustments |

### 2. IDENTIFY the improvement

Be specific. Not "we should test more" but "the roeto-session.js stealth plugin import was never tested in the container — need a pre-merge check that runs imports."

### 3. CLASSIFY the level

## The Three Levels

### Level 1: Instructions

**What:** Text in CLAUDE.md, SKILL.md, workflow docs, PR descriptions.
**Enforcement:** None — relies on agent/human reading and following.
**When sufficient:** First occurrence, judgment-required situations, direction-setting.
**When to escalate:** Same type of failure happens again.

**Mechanisms:**
- `CLAUDE.md` (harness and vertical repos)
- `SKILL.md` files (skill documentation)
- `workflows/` docs (vertical-specific procedures)
- `groups/global/CLAUDE.md` (agent behavior instructions)

### Level 2: Hooks & Automated Checks

**What:** Code that runs automatically and can BLOCK actions.
**Enforcement:** Deterministic — blocks commit, merge, tool call, or agent completion.
**When sufficient:** Automatable checks, moderate failure cost.
**When to escalate:** Check is bypassed, or failure still happens despite the check.

**Mechanisms:**
- **Claude Code hooks** (`.claude/settings.json`):
  - `PreToolUse` — block dangerous commands, protect files
  - `PostToolUse` — auto-format, validate after edits
  - `Stop` — verify tests/checks before agent finishes
  - `UserPromptSubmit` — validate prompts
- **Git hooks** (`.husky/`) — pre-commit checks
- **CI pipeline** (`.github/workflows/`) — PR merge gates
- **CLI diagnostic tools** (`tools/`) — investigation aids

### Level 2.5: MCP Tools & Skills

**What:** Structured tools the agent calls via MCP protocol. Code that runs when invoked.
**Enforcement:** Semi-automatic — agent must call the tool, but the tool enforces the pattern correctly when called. Can be the ONLY way to perform an action (forcing correct behavior).
**When sufficient:** Complex operations that need guardrails but still require agent judgment on WHEN to act.

**Mechanisms:**
- **MCP tools** (`container/agent-runner/src/ipc-mcp-stdio.ts`) — `create_case`, `send_message`, `case_mark_done`
- **Skills** (`.claude/skills/`) — reusable capability packages with their own docs
- **Agent-browser** — structured web automation tool

**Key distinction from hooks:** Hooks fire automatically on events. MCP tools require agent initiative but enforce correctness when used. Example: `create_case` tool ensures proper case ID, workspace creation, DB insert, and user notification — the agent just decides WHEN to create a case.

### Level 3: Mechanistic / Architectural

**What:** System design makes the wrong thing impossible or the right thing automatic.
**Enforcement:** Structural — built into the code path, can't be bypassed. No agent decision-making.
**When sufficient:** High-cost failures, anything that wastes human time, repeat failures.

**Mechanisms:**
- **Harness code** (`src/`) — IPC handlers, message processing, container runner
- **Container architecture** — read-only mounts, credential proxy, isolation
- **Automated handlers** — cookie auto-handler, timeout progress messages
- **Data validation** — schema enforcement at parse time
- **Message middleware** — pattern detection in incoming messages (e.g., auto-detect cookie JSON)

## Escalation Rules

```
Is this the first occurrence?
  YES → Level 1 (instructions)
  NO  → Has this type of failure happened before?
          YES → Level 2 (hooks/checks) minimum
          NO  → Level 1, but note it for escalation if it recurs

Does this failure waste human time?
  YES → Level 3 (mechanistic) — humans should never wait on agent mistakes

Could an agent bypass this fix by ignoring instructions?
  YES → Must be Level 2+ (enforcement, not just guidelines)

Does the operation need agent judgment on WHEN but not HOW?
  YES → Level 2.5 (MCP tool) — agent decides when, tool enforces correctness

Is the check fully automatable (no judgment needed)?
  YES → Level 2 (hooks) or Level 3 (mechanistic) — why rely on agent memory?
```

## Kaizen Backlog

All improvements that are too large for the current PR go to:
**[github.com/Garsson-io/kaizen/issues](https://github.com/Garsson-io/kaizen/issues)**

Issue format:
- **Title:** `[L{level}] Brief description`
- **Labels:** `kaizen`, `level-1`/`level-2`/`level-3`, relevant repo
- **Body:**
  - What failed (incident description)
  - Why it failed (root cause)
  - Current level of fix (if any)
  - Proposed improvement and target level
  - Verification: how to confirm the fix works

## PR Kaizen Section

Every fix-PR MUST include a kaizen section:

```markdown
## Kaizen
- **Root cause:** [what actually caused this]
- **Fix level:** L[1/2/3] — [instructions/hook/mechanistic]
- **Repeat failure?** [yes/no — if yes, what was the previous fix and why wasn't it enough?]
- **Escalation needed?** [yes/no — should this be a higher level?]
- **Backlog issue:** [link to kaizen issue if filed, or "N/A — implemented in this PR"]
```

## Recursive Kaizen

Improving how we improve:

- **Level 1 kaizen:** Improving the work itself (fixing bugs, adding features)
- **Level 2 kaizen:** Improving HOW we work (better processes, hooks, checks)
- **Level 3 kaizen:** Improving how we improve (the kaizen system itself, reflection triggers, escalation criteria)

When the kaizen system itself fails (e.g., reflections happen but don't produce action, or improvements are identified but never implemented), that's a signal to apply kaizen to kaizen — recursive improvement.

## Current Enforcement Inventory

| Mechanism | Level | Location | What it enforces |
|-----------|-------|----------|-----------------|
| CLAUDE.md policies | 1 | Both repos | Direction, guidelines, decision frameworks |
| Global agent CLAUDE.md | 1 | `groups/global/CLAUDE.md` | Response timing, close-the-loop, formatting |
| Prettier pre-commit | 2 | `.husky/pre-commit` | Code formatting |
| CI pipeline | 2 | `.github/workflows/ci.yml` | Typecheck, tests, format |
| Git LFS | 3 | `.gitattributes` | Binary files tracked correctly |
| Container read-only mounts | 3 | `container-runner.ts` | Work agents can't modify tools |
| Credential proxy | 3 | `credential-proxy.ts` | Secrets never exposed to containers |
| Mechanistic error notifications | 3 | `src/index.ts` | Users always informed of failures (no silent errors) |
| Immediate ⏳ ack | 3 | `src/index.ts` | Users always know message was received |

## Pending Escalations

These are currently Level 1 (instructions) but should be higher:

| Issue | Current | Target | Kaizen Issue |
|-------|---------|--------|-------------|
| Cookie expired, human response ignored | L1 (CLAUDE.md) | L3 (auto-detect cookie JSON, save, test) | TODO: file |
| Agent silent during long processing | L1 (CLAUDE.md "send early reply") | L3 (harness timeout sends progress) | TODO: file |
| Untested code merged | L1 (CLAUDE.md "test first") | L2 (Stop hook runs tests) | TODO: file |
