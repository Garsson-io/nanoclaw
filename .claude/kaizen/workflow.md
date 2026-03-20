# Dev Work Skill Chain

When the conversation involves **selecting, evaluating, or starting dev work**, activate the right skills in sequence. Do NOT jump straight to writing code.

## Flow

```
User asks "where are the gaps", "analyze gaps", "what should we invest in"
  → /gap-analysis  (strategic: tooling/testing gaps, horizon concentration, unnamed dimensions)
    → produces: low-hanging fruit, feature PRD candidates, meta/horizon PRD candidates

User asks "make a dent", "hero mode", "fix the category", "deep dive", "autonomous fix"
  → /make-a-dent  (autonomous: find root cause category, fix bugs, add interaction tests, ship PR)

User asks "what's next", "pick work", "pick a kaizen", "what should we work on"
  → /pick-work  (filter claimed issues, score by momentum/diversity, present options)

User discusses a specific issue, PR, case, or spec
  → /accept-case  (collision check, evaluate, find low-hanging fruit, get admin input)

User greenlights: "lets do it", "go ahead", "build it", "do it", "yes", etc.
  → /implement-spec  (five-step algorithm, create case + worktree, then execute)
  → MUST pass githubIssue number when creating case for a kaizen issue

Work is large enough to need multiple PRs
  → /plan-work  (break into sequenced PRs with dependency graph)

Work is done
  → /kaizen  (reflect on impediments, suggest improvements)
```

## Key Triggers to Recognize

- **Strategic gap analysis:** "gap analysis", "analyze gaps", "where are problems concentrated", "tooling gaps", "testing gaps" → `/gap-analysis`
- **Autonomous deep-dive:** "make a dent", "hero mode", "fix the category", "deep dive kaizen", "autonomous fix" → `/make-a-dent`
- **Selecting work from backlog:** "pick a kaizen", "what's next", "what should we work on", "find work", "choose issue" → `/pick-work`
- **Evaluating specific work:** "look at issue #N", "check PR #N", "find low hanging fruit", "evaluate this" → `/accept-case`
- **Greenlighting work:** "lets do it", "go ahead", "build it", "start on this", "ship it", "make it happen" → `/implement-spec`
- **All dev work MUST be in a case.** If `/implement-spec` activates, create a case with worktree before writing any code.
- **Kaizen issue lifecycle:** When working on a kaizen issue, the `status:active`/`status:done` labels are auto-synced by `case-backend-github.ts`. Collision detection in `ipc-cases.ts` blocks duplicate case creation for the same issue.
