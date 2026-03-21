---
name: agents
description: "Analyze running Claude Code agents — what they're working on, elapsed time, session progress, issues, PRs, git status. Triggers on \"agents\", \"running agents\", \"who's running\", \"agent status\", \"what agents are doing\", \"what's running\"."
---

# /agents — Running Agent Analysis

Show what Claude Code agents are currently running, what they're working on, and their progress.

## Usage

```bash
python3 .claude/kaizen/skills/agents/agent-status.py
```

Options:
- `--json` — machine-readable JSON output
- `--no-session` — skip session JSONL parsing (faster, less detail)
- `--no-gh` — skip GitHub API calls (no PR lookup, faster)

Run the script and present the output to the user. The script handles all data gathering:
process discovery, session JSONL parsing, git status, case/lock file info, subagent counting,
issue detection, and PR lookup.

## Issue & PR Detection

The script resolves issues and PRs from multiple sources (in priority order):

| Source | How | Example |
|--------|-----|---------|
| `.worktree-context.json` | Written automatically | `{"issue_number": 280, ...}` |
| Case name `kNN` pattern | Parsed from lock file | `260318-2107-k21-fix-newline` -> kaizen #21 |
| CLI prompt `#NNN` | Parsed from `-p` flag | `-p "Fix #280"` -> #280 |
| Commit messages `#NNN` | Parsed from git log | `fix: (kaizen #280)` -> #280 |
| `gh pr list --head` | GitHub API lookup | Finds open PR for the branch |

## `.worktree-context.json` — Automatic Tracking

This file is written automatically at two points:

1. **Case creation** (`ipc-cases.ts`): writes case metadata and issue info when
   a dev case is created via IPC. Fields: `case_id`, `case_name`, `description`,
   `issue_number`, `issue_repo`, `issue_url`.

2. **PR creation** (`capture-worktree-context.sh` PostToolUse hook): merges PR
   info when `gh pr create` succeeds. Fields: `pr_number`, `pr_url`, `pr_title`.
   Preserves all existing fields (additive merge).

Example after both stages:
```json
{
  "case_id": "case-123",
  "case_name": "260321-0149-k280-fix-waiver",
  "description": "Fix waiver quality enforcement",
  "issue_number": 280,
  "issue_repo": "Garsson-io/kaizen",
  "issue_url": "https://github.com/Garsson-io/kaizen/issues/280",
  "pr_number": 238,
  "pr_url": "https://github.com/Garsson-io/nanoclaw/pull/238",
  "pr_title": "fix: waiver quality enforcement"
}
```

The file lives in the worktree root, is never committed, and uses additive merges
(new fields are added, existing fields are preserved).
