# Horizon: Autonomous Kaizen

*The system that improves itself faster than problems accumulate is the system that wins.*

## Taxonomy

| Level | Name | Description |
|-------|------|-------------|
| L0 | No process | Fix bugs as they come. No reflection, no backlog. |
| L1 | Manual reflection | Humans notice problems and file issues. Improvement is ad-hoc. |
| L2 | Prompted reflection | Agents reflect at checkpoints (case completion, PR merge). Reflection is text — may or may not produce action. |
| L3 | Enforced reflection | Hooks gate on reflection happening. Agent cannot stop without reflecting. But no check on quality or actionability. |
| L4 | Actionable reflection | Reflection must produce filed issues, not just prose. Enforced by MCP tools and post-merge gates. |
| L5a | Incident data infrastructure | Structured incident records with horizon labels and root-cause-class fields. Countable, queryable. The data that makes pattern detection possible. Mechanistic — bash hooks can count incidents per issue, per horizon, per level. |
| L5b | Pattern-driven level escalation | System detects cross-incident patterns and surfaces "you're repeating yourself at L1 — escalate to L2." Requires semantic reasoning (LLM judgment), not just counting. The reflection becomes smart enough to say "stop adding volume, go up a level." |
| L6 | Autonomous work selection | System selects its own next improvement from the backlog without human prompting. Balances momentum, diversity, and priority autonomously. |
| L7 | Autonomous implementation | Improvements ship without human approval for routine cases. Human approves scope (accept-case), system executes and merges. Escalation to human only for genuine judgment calls. |
| L8 | Self-modifying process | The improvement process modifies its own prompts, hooks, and skills based on accumulated meta-reflections. The taxonomy itself evolves. |

## You Are Here

**L3–L4**, with L5 just beginning.

- **L3 (achieved):** `enforce-post-merge-stop.sh` gates on `/kaizen` running. Agent cannot stop without reflecting.
- **L4 (in progress):** `kaizen-reflect.sh` and MCP enforcement (#57, #108) require that reflections produce filed issues, not just prose. PR #157 pending.
- **L5a (not started):** No structured incident data. Incidents are prose in issue comments — not countable, not queryable, not labeled by horizon or root-cause-class.
- **L5b (not started):** Agents reflect but don't check the backlog for pattern matches. Level classification is per-incident, never cross-incident. The Zen says "escalate the level, not the volume" but nothing detects when volume is being increased instead of level.
- **L6 (partial):** `/pick-work` skill exists but requires human to trigger it. No autonomous scheduling.

### The L5 problem in concrete terms

**What happens today (L4):** Agent encounters friction → files kaizen issue at L1 → moves on. Next agent encounters same class of friction → files another L1 issue → moves on. Third agent does the same. Three L1 issues exist for the same root cause pattern. Nobody notices they should be one L2 fix.

**What L5a enables:** Incidents are structured data with `horizon` and `root_cause_class` fields. A hook can count: "3 open L1 issues tagged `horizon:worktree-first` with `root_cause:path-resolution`." The data exists to detect the pattern.

**What L5b enables:** During reflection, the system searches the backlog, finds the cluster, and says: "You're about to file another L1 path-resolution fix. There are already 2 open. The fix level should be L2 — shared infrastructure, not another point fix." This requires semantic reasoning — matching "cli-kaizen DB path" to "worktree-lock.json gitignore" as the same root cause class.

**Why L5 was split:** L5a is mechanistic (structured data, counting, labeling). L5b requires LLM judgment (semantic pattern matching across issues). They have different enforcement characteristics: L5a can be a bash hook that validates incident format; L5b needs to be a skill-level prompt or an LLM-powered check. Conflating them made L5 feel unimplementable — splitting them shows the tractable first step.

## Next Steps (visible from here)

1. **Complete L4** — merge #157 (enforce actionable reflections), verify that reflections consistently produce issues
2. **L5a: Incident data infrastructure** — define structured incident format (horizon label, root-cause-class, impact), add to the `KAIZEN_IMPEDIMENTS` schema, build hook that validates structure. This is the Incident-Driven Kaizen horizon (L3: structured incidents) feeding into Autonomous Kaizen.
3. **L5b: Pattern detection prompt** — after L5a provides the data, add a reflection prompt step that queries the backlog for same-class issues and warns when level escalation is warranted. Start as L1 (prompt), evaluate whether it needs L2 (hook enforcement).
4. **L6 exploration** — what would it take for the system to autonomously run `/pick-work` → `/accept-case` on a schedule?

## What We Can't See Yet

L7+ is fog. We know the direction (more autonomy, less human intervention) but not the mechanism. That's fine — the taxonomy tells us where to walk. When we reach L6, L7 will come into focus.

## Relationship to Other Horizons

- **Incident-Driven Kaizen feeds Autonomous Kaizen** — incident data drives work selection (L6) and prioritization
- **Observability feeds Autonomous Kaizen** — autonomous selection requires data on what works and what doesn't
- **Cost Governance constrains Autonomous Kaizen** — autonomous agents need budgets to prevent runaway
- **Human-Agent Interface gates L7** — auto-merge requires stakeholder trust earned through HAI L1-L4
- **Security constrains L7** — auto-merge requires confidence agents weren't manipulated
- **Autonomous Kaizen drives improvement across all other horizons** — it's the engine that moves every other dimension forward
- **Extensibility L6 converges with L8** — self-extension and self-modification are the same capability
