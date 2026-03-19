# Safe Word Dev Escalation — Specification

## 1. Problem Statement

Non-main groups (e.g., `telegram_garsson_print`) can only spawn **work agents**. When a trusted user asks for dev work, the system:

1. Spawns a work agent (no GitHub token, no worktree)
2. The agent tries `case_create` with `type: dev`
3. `case-auth.ts` rejects it: non-main → `suggested` status
4. A mangled notification appears in the main group asking for approval
5. The agent tells the user it can't proceed
6. The user replies in the main group, hits a *different* active case's agent, which has no context

**Who experiences this:** Aviad and Nir — the only two people who operate the system. Both are admins/owners.

**What happens today:** Dev work from non-main groups is effectively impossible without manual intervention in the main group.

**Cost of not solving:** The prints development group (`telegram_garsson_print`) is useless for dev work. All dev instructions must go through the main group, which is already noisy with work cases, emails, and notifications. Nir (who owns the prints vertical) can't trigger dev work from his natural context.

### Adjacent bugs discovered during investigation

These are not in scope for this spec but were found and should be filed separately:

1. **JSON leak in approval notification** (`ipc-cases.ts:523`): `d.description.slice(0, 200)` includes raw JSON when the description contains structured data. Example output: `"update CLAUDE.md and 8 workflow files to always present category options", "short_name": "Dev Options UX Apply`
2. **Case names are unreadable**: `260319-0356-apply-options-ux-changes-to-ga` — truncated, no human context.
3. **No GitHub issue link in notifications**: The approval notification doesn't include the issue URL even when one exists.

## 2. Desired End State

A trusted user includes a **safe word** in their message. The system detects it *before* spawning the container and escalates to dev mode:

```
Nir: @GarssonPrintsBot תברווז תתחיל לעבוד על הגלוסרי
                       ^^^^^^
                       safe word detected → dev mode
```

**What changes:**
- Container spawns with GitHub token
- `case-auth.ts` treats the case as pre-authorized (skips approval gate)
- Agent creates dev case in `active` status immediately
- Agent gets worktree access
- No notification to main group needed

**Without the safe word:** Everything works exactly as today — work agent, sandboxed, no GitHub.

**Configuration:**
- Global safe words: `DEV_SAFE_WORDS` in `src/config.ts` (default: `["תברווז"]`)
- Per-group safe words: `devSafeWords` array in `containerConfig` JSON column of `registered_groups` table
- Both are checked — global words apply to all groups, group-specific words apply only to that group

Example per-group config:
```json
{"additionalMounts": [...], "devSafeWords": ["תברווז"]}
```

**Out of scope:**
- Per-sender safe words
- Revoking dev mode mid-session
- UI for managing safe words

## 3. Roles & Boundaries

| Role | Can trigger dev mode | How |
|------|---------------------|-----|
| Admin (Aviad, Nir) | Yes | Include safe word in trigger message |
| Work agent (container) | No | Safe word is stripped before prompt reaches agent |
| Dev agent (container) | N/A | Already in dev mode |
| Case router | No | Routing happens after mode is determined |

**Security consideration:** The safe word is not a security boundary — it's an ergonomic escalation signal. The real security is that only registered senders in allowed groups can trigger agents at all (sender allowlist + trigger pattern). The safe word is a UX mechanism within an already-authenticated context.

## 4. Architecture — Where the Safe Word Is Detected

```
User message: "@GarssonPrintsBot תברווז fix the glossary"
                                  ↓
┌─────────────────────────────────────────────────────┐
│ Message Loop (src/index.ts)                         │
│                                                     │
│ 1. Trigger check ← existing (passes: has @trigger)  │
│ 2. ★ Safe word check ← NEW                         │
│    - Scan message content for safe word             │
│    - Set devModeRequested = true                    │
│    - Strip safe word from message text              │
│ 3. Case routing ← existing                          │
│ 4. runAgent() ← pass devModeRequested flag          │
└─────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────┐
│ runAgent() → runContainerAgent()                    │
│                                                     │
│ If devModeRequested:                                │
│   - Pass GITHUB_TOKEN to container                  │
│   - Set NANOCLAW_DEV_MODE=1 env var                 │
│   - Pass flag through to IPC context                │
└─────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────┐
│ Container agent calls case_create(type: dev)        │
│                    ↓                                │
│ IPC handler (src/ipc-cases.ts)                      │
│   - Reads NANOCLAW_DEV_MODE from IPC context        │
│   - Passes devModeRequested to case-auth            │
│                    ↓                                │
│ case-auth.ts                                        │
│   - If devModeRequested: status = 'active'          │
│     (bypass non-main approval gate)                 │
└─────────────────────────────────────────────────────┘
```

## 5. Interaction Models

### Happy path: Dev work from non-main group

```
1. Nir sends: "@GarssonPrintsBot תברווז תתחיל לעבוד על הגלוסרי"
2. Message loop detects "תברווז" in message content
3. devModeRequested = true
4. Safe word stripped from prompt: "תתחיל לעבוד על הגלוסרי"
5. Container spawns with:
   - GITHUB_TOKEN set
   - NANOCLAW_DEV_MODE=1
6. Agent calls case_create(type: 'dev', description: '...')
7. case-auth sees devModeRequested → returns status: 'active'
8. Case created immediately, worktree provisioned
9. Agent starts working with full dev capabilities
```

### Normal work (no safe word)

```
1. Nir sends: "@GarssonPrintsBot turn this pdf into jpg"
2. Message loop: no safe word found
3. devModeRequested = false
4. Container spawns as work agent (no GitHub token)
5. If agent tries case_create(type: 'dev'):
   - case-auth: non-main, no devMode → suggested (existing behavior)
6. Work proceeds normally in sandbox
```

### Edge case: Safe word in non-trigger message

```
1. Nir sends: "תברווז something" (no @trigger prefix)
2. Message loop: trigger check fails first → message ignored
3. Safe word detection never runs
4. Correct behavior — safe word without trigger has no effect
```

### Edge case: Safe word with existing active case

```
1. There's already an active work case in the prints group
2. Nir sends: "@GarssonPrintsBot תברווז pick kaizen #89"
3. Safe word detected → devModeRequested = true
4. Case routing: may route to existing case or create new
5. If routed to existing work case: container still gets GitHub token
   (the dev mode flag applies to the container session, not just case creation)
6. Agent can create a new dev case from within the session
```

## 6. State Management

No new persistent state. The safe word is a per-message signal:

| State | Scope | Storage | Survives restart |
|-------|-------|---------|-----------------|
| `devModeRequested` flag | Single message processing | In-memory (message loop) | N/A — per-request |
| `NANOCLAW_DEV_MODE` env var | Container lifetime | Container env | No — new container, new flag |
| IPC `devMode` context | IPC request | JSON file | No — consumed once |

## 7. What Exists vs What Needs Building

### Already Solved

| Capability | Current implementation | Status |
|------------|----------------------|--------|
| Trigger detection | `TRIGGER_PATTERN` regex in message loop | Works |
| GitHub token passing | `container-runner.ts:270` — passes when `caseType === 'dev'` | Works, but only for pre-existing dev cases |
| Case authorization | `case-auth.ts` — `authorizeCaseCreation()` | Works, needs new `devModeRequested` param |
| Approval gate | `ipc-cases.ts:472-527` — routes to suggested status | Works, needs bypass path |
| Sender allowlist | `sender-allowlist.ts` | Works — already limits who can trigger |

### Needs Building

| Component | What | Why it doesn't exist yet |
|-----------|------|-------------------------|
| Safe word detection | Scan message for "תברווז", set flag, strip from prompt | New feature |
| Dev mode flag threading | Pass `devModeRequested` through `runAgent()` → `runContainerAgent()` → IPC context | Plumbing — no current mechanism to pass pre-spawn decisions to post-spawn case creation |
| `container-runner.ts` change | Pass GitHub token when `devModeRequested`, not just when `caseType === 'dev'` | Currently only checks existing case type |
| `case-auth.ts` change | Accept `devModeRequested` param, return `active` status | Currently only checks `isMain` |
| `ipc-cases.ts` change | Read dev mode from IPC context, pass to `authorizeCaseCreation` | Currently no way to receive pre-spawn auth decisions |
| Config for safe word | Hardcoded constant in `config.ts` for future extensibility | New |

## 8. Open Questions & Known Risks

### Q1: How does the IPC context carry the dev mode flag?

The container creates cases via IPC JSON files. The host's `ipc-cases.ts` processes them. How does the dev mode flag get from the container spawn to the IPC handler?

**Options:**
1. **Environment variable** — Container gets `NANOCLAW_DEV_MODE=1`. The agent-runner reads it and includes `devMode: true` in the `case_create` IPC request. The host trusts it because it set the env var.
2. **Host-side marker file** — The host writes a `.dev-mode` marker in the group's IPC dir before spawning. The IPC handler checks for it. No container-side changes needed. Marker is cleaned up when container exits.

**Lean:** Option 2 (marker file). Simpler — no container-side changes needed. The host controls both writing and reading the marker. The container doesn't even need to know about dev mode — it just creates cases normally, and the host's auth gate sees the marker and authorizes.

### Q2: Should the safe word be stripped from the prompt?

**Decision:** Yes. Strip it. The safe word is a control signal to the system, not content for the agent. Leaving it in the prompt would confuse the agent.

### Q3: Should we notify the main group when dev mode is used?

**Lean:** Yes, but as an informational log, not an approval request:
```
🔧 Dev mode activated in telegram_garsson_print by Nir
Working on: fix the glossary
```

Gives Aviad visibility without blocking Nir.

### Q4: What if the agent doesn't create a dev case?

The safe word gives the container dev *capabilities* (GitHub token). If the agent decides to do work that doesn't need a dev case, no harm — it just has extra capabilities it doesn't use. The GitHub token is already scoped and the container is still sandboxed.

## 9. Implementation Sequencing

This is a small feature. One PR, ~5 files:

```
1. src/config.ts — Add DEV_SAFE_WORDS constant (["תברווז"])
2. src/index.ts — Detect safe word in message, set flag, strip from prompt
3. src/container-runner.ts — Pass GitHub token + NANOCLAW_DEV_MODE when devModeRequested
4. src/case-auth.ts — Accept devModeRequested param, bypass approval gate
5. src/ipc-cases.ts — Read dev mode context (marker file), pass to case-auth
6. Tests for each changed file
```

**Estimated scope:** ~50-80 lines of production code, ~100-150 lines of tests.

**Dependencies:** None — all changes are additive and backward-compatible.

**Risk:** Low — the safe word detection is pre-spawn (before any container or case logic runs), and the fallback is existing behavior (no safe word = work agent).
