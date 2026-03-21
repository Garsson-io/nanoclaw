# NanoClaw-Specific Kaizen Policies

These policies extend the generic kaizen policies for NanoClaw. They were learned from past incidents specific to this project.

12. **NEVER install system packages on the host machine** (no `sudo apt install`). System deps go in Dockerfiles. npm deps go in `package.json`.
13. **Research before installing.** Check existing skills first. Evaluate alternatives. Present findings before proceeding.
14. **Ask "harness or vertical?"** before writing any code. See `docs/harness-vertical-architecture.md`.
15. **Put durable knowledge in CLAUDE.md and docs/, not just local memory.** `~/.claude/` memory is not synced to git.
16. **Work agents get read-only tools.** Dev agents modify in worktrees.
17. **Write tests BEFORE production code (TDD).** RED -> GREEN -> REFACTOR.
18. **Skill branches must stay clean.** Never merge fork's main into a `skill/*` branch. Cherry-pick only.
19. **Declare ALL dependencies.** Every `require()` or `import` must have a `package.json` entry.
20. **Prefer simpler dependency stacks.** Fewer deps = fewer failure points.
21. **`--dangerously-skip-permissions` does NOT bypass hooks.** It auto-approves built-in tool permission prompts, but custom hooks still fire. Use `--bare` to skip hooks entirely.
