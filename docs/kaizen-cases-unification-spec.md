# Kaizen Cases Unification — Specification

## 1. Problem Statement

Kaizen issues are created and managed via raw `gh` CLI calls, bypassing the cases abstraction entirely. This creates a split-brain architecture where customer work goes through `cases.ts → case-backend.ts → GitHub`, but kaizen work goes through raw `gh issue create/edit/list`. The consequences:

- **No validation or required fields.** Agents can create kaizen issues with missing labels, malformed titles, or no body structure. Kaizen #97 was filed this way — itself a violation of the pattern it should describe.
- **No collision detection.** Two agents can create duplicate kaizen issues for the same problem.
- **No local cache.** Every `/pick-work` or `/accept-case` invocation makes multiple GitHub API calls. If GitHub is slow or rate-limited, skills fail.
- **Not CRM-agnostic.** The `gh` CLI is hardcoded throughout skills. Switching to a different issue tracker requires rewriting every skill.

### Who experiences this

- **Dev agents** creating kaizen issues after reflections, filing improvement suggestions, or running `/write-prd`.
- **Aviad (admin)** receiving malformed or duplicate issues that require manual cleanup.
- **The system** accumulating technical debt as each skill implements its own GitHub interaction pattern.

### What happens today

| Operation | Current path | Problem |
|-----------|-------------|---------|
| Create kaizen issue | Raw `gh issue create` in skills | No validation, no abstraction |
| Read backlog | Raw `gh issue list` in /pick-work | GitHub-dependent, no cache |
| Update labels | Raw `gh issue edit` in /accept-case | Bypasses backend sync |
| Close issue | Auto-close via PR `Fixes` keyword | Works but fragile |
| Create dev case for kaizen | `case_create` IPC with `githubIssue` | **This part works** |

The last row is the model we want everywhere — all kaizen operations going through the cases/backend abstraction.

## 2. Desired End State

All kaizen issue lifecycle operations go through the cases abstraction. No agent ever calls `gh issue create/edit/list --repo Garsson-io/kaizen` directly.

```
Skills (/write-prd, /pick-work, /accept-case, /kaizen)
        ↓
IPC / MCP tools (case_create, case_query, case_list_backlog)
        ↓
Domain model (cases.ts)
        ↓
Case backend interface (case-backend.ts)
        ↓
GitHub adapter (case-backend-github.ts)
        ↓
Garsson-io/kaizen (CRM instance)
```

**What agents can do:**
- Create kaizen issues through MCP tools (validated, with required fields)
- Query active cases from local cache (fast, offline-capable)
- Fetch full backlog from CRM on demand (for /pick-work)
- Update issue state (labels, status) through the backend adapter

**What agents cannot do:**
- Call `gh issue create` directly (blocked by L2 hook)
- Bypass validation (required fields enforced at MCP/IPC layer)
- Create duplicate issues (collision detection in domain model)

**What is NOT in scope:**
- Changing how customer/work cases operate (already correct)
- Bidirectional sync for the full backlog (too complex, not needed)
- Moving off GitHub as the kaizen CRM (abstraction enables this later)

## 3. Roles & Boundaries

| Role | Can do | Cannot do |
|------|--------|-----------|
| Dev agent (in container) | Create kaizen issues via MCP tool, query cases | Call `gh` directly for kaizen |
| Skills (/pick-work, etc.) | Read backlog via MCP/domain model | Call `gh issue list` directly |
| Case backend adapter | CRUD on GitHub Issues | Be called directly by agents |
| L2 hook | Block raw `gh issue create --repo kaizen` | Block `gh` for non-kaizen repos |

## 4. Architecture

### Current layers

```
Container agent
    ↓ (IPC file)
ipc-cases.ts (case_create, case_mark_done, ...)
    ↓
cases.ts (domain model, SQLite cache)
    ↓
case-backend.ts → case-backend-github.ts
    ↓
GitHub Issues API (github-api.ts)
```

### What needs to change

**New MCP/IPC operations for kaizen lifecycle:**

| Operation | IPC type | Purpose | Current path |
|-----------|----------|---------|-------------|
| `kaizen_suggest` | New | Create a kaizen issue in CRM | Raw `gh issue create` |
| `kaizen_list_backlog` | New | Fetch open issues from CRM | Raw `gh issue list` |
| `kaizen_view` | New | Read a specific issue | Raw `gh issue view` |
| `kaizen_update` | New | Update labels/status on issue | Raw `gh issue edit` |

These operations route through the backend adapter, which handles:
- Required field validation (title format, labels, body structure)
- Collision detection (duplicate title/description matching)
- Local cache update (for active/claimed issues)

**Host-side skill access:**

Skills run on the host (not in containers), so they can't use IPC files. They should call the domain model directly via the compiled module — the same pattern the `enforce-case-exists.sh` hook now uses.

Alternatively, a thin CLI wrapper (`node dist/cli-kaizen.js list-backlog`) could expose the domain model to shell scripts.

### Read path: hybrid cache

| Data | Source | Cache? | Rationale |
|------|--------|--------|-----------|
| Active/claimed kaizen issues | Local SQLite | Yes | Fast routing, offline-capable |
| Full backlog (for /pick-work) | GitHub API (on demand) | No | Changes frequently, needs freshness |
| Specific issue details | GitHub API (on demand) | No | Infrequent, needs latest state |

Active issues are cached because they're linked to cases (which already live in SQLite). The full backlog is fetched fresh because `/pick-work` needs to see new issues, closed issues, and label changes that happened since last fetch.

### L2 enforcement hook

A new PreToolUse(Bash) hook that blocks `gh issue create --repo Garsson-io/kaizen` and `gh issue edit --repo Garsson-io/kaizen` commands. Must allowlist:
- `gh issue view` (read-only, always allowed)
- `gh issue list` (read-only, transitional — eventually replaced by domain model)
- Commands from within hook/skill context that are part of the backend adapter

## 5. Interaction Models

### Creating a kaizen issue (happy path)

1. Agent identifies improvement during `/kaizen` reflection
2. Agent calls `kaizen_suggest` MCP tool with: description, level (L1/L2/L3), context
3. IPC handler validates required fields
4. `case-backend-github.ts` creates issue in `Garsson-io/kaizen` with standard format
5. Issue number returned to agent for reference
6. Local cache updated (if issue is immediately claimed)

### /pick-work reading the backlog

1. Skill calls `kaizen_list_backlog` (or domain model function)
2. Domain model fetches from GitHub API: open issues, no `status:active` label
3. Cross-references with local cache: filters out issues with active cases
4. Returns scored/filtered list to skill
5. No local cache update needed (read-only)

### Error: agent tries raw `gh issue create`

1. Agent runs `gh issue create --repo Garsson-io/kaizen`
2. PreToolUse hook detects the command pattern
3. Hook blocks with: "Use the kaizen_suggest MCP tool instead of raw gh CLI"
4. Agent uses MCP tool (which goes through the backend adapter)

## 6. State Management

| Component | State | Storage | Survives restart? |
|-----------|-------|---------|-------------------|
| Active kaizen cases | Case record with `github_issue` link | SQLite (cache) | Yes |
| Kaizen backlog | Full issue list | GitHub (source of truth) | N/A (external) |
| Issue metadata | Labels, body, comments | GitHub (source of truth) | N/A (external) |
| Collision index | Active issue numbers | SQLite (derived from cases) | Yes |

## 7. What Exists vs What Needs Building

### Already Solved

| Capability | Current implementation | Status |
|------------|----------------------|--------|
| Case → GitHub Issue sync | `case-backend-github.ts` | Working |
| Dev case → kaizen issue link | `ipc-cases.ts` `githubIssue` param | Working |
| Collision detection (same issue) | `getActiveCasesByGithubIssue()` | Working |
| Status label auto-sync | `case-backend-github.ts` updateCase | Working |
| GitHub API client | `github-api.ts` | Working |
| Domain model case queries | `cases.ts` | Working |

### Needs Building

| Component | What | Why it doesn't exist yet |
|-----------|------|-------------------------|
| `kaizen_suggest` IPC/MCP tool | Validated kaizen issue creation through backend | Skills use raw `gh` instead |
| `kaizen_list_backlog` domain function | Fetch+filter backlog from GitHub through adapter | Skills call `gh issue list` directly |
| `kaizen_view` domain function | Read single issue through adapter | Skills call `gh issue view` directly |
| `kaizen_update` domain function | Update labels/status through adapter | Skills call `gh issue edit` directly |
| L2 hook blocking raw kaizen `gh` commands | PreToolUse(Bash) hook | No enforcement exists today |
| Skill migration | Update /write-prd, /pick-work, /accept-case, /kaizen to use new tools | Skills hardcode `gh` CLI |

## 8. Open Questions

1. **Should the backend adapter handle issue body formatting?** Currently skills format issue bodies differently (/kaizen uses `[L{level}]` prefix, /write-prd uses a different structure). Should the adapter enforce a standard format, or should each skill format its own body and pass it through?

2. **How to handle the transition?** Skills currently call `gh` directly. Migration options:
   - Big bang: update all skills at once
   - Gradual: add the hook as advisory first, migrate skills one by one, then make it blocking

3. **Should `gh issue list` reads be blocked?** The hook could block writes immediately but allow reads (transitional), then block reads once the domain model read path is built.

4. **CLI wrapper vs direct module import for host-side skills?** Skills are markdown prompts — they tell the agent what commands to run. A CLI wrapper (`node dist/cli-kaizen.js suggest --desc "..." --level 2`) is more natural for prompt-based skills than importing modules.

## 9. Implementation Sequencing

```
Phase 1: Domain model + backend adapter (kaizen CRUD)
    ↓
Phase 2: IPC/MCP tools (kaizen_suggest, kaizen_list_backlog)
    ↓
Phase 3: L2 hook (block raw gh issue create for kaizen)
    ↓
Phase 4: Skill migration (/kaizen, /write-prd, /pick-work, /accept-case)
```

Each phase is independently valuable:
- Phase 1 alone gives a clean API for future use
- Phase 2 makes it available to container agents
- Phase 3 prevents bypassing
- Phase 4 completes the migration

Phases 1-2 can be one PR. Phase 3 is a separate PR. Phase 4 may be one PR per skill or bundled.
