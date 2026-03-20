# Trim CLAUDE.md

Measure CLAUDE.md size, identify bloat, and extract verbose sections into reference docs or kaizen system files — leaving compact pointers behind.

CLAUDE.md is loaded into every conversation. Every line costs context. This skill keeps it lean.

## When to use

- CLAUDE.md exceeds ~250 lines
- A section has grown verbose during development (common after adding policies or procedures)
- After adding a new feature that introduced a large CLAUDE.md section
- Periodic maintenance (every ~10 PRs)

## The Process

### Step 1: Measure

```bash
# Total size
wc -l CLAUDE.md

# Per-section breakdown
awk '/^## /{if(section) printf "%3d lines: %s\n", NR-start, section; section=$0; start=NR} END{printf "%3d lines: %s\n", NR-start+1, section}' CLAUDE.md
```

**Target:** CLAUDE.md under 250 lines. If it's under 200, probably fine — don't trim for the sake of trimming.

### Step 2: Classify each section

For each section over ~15 lines, ask:

| Question | If yes → |
|----------|----------|
| Is this kaizen enforcement? (hooks, verification, workflow, policies learned from incidents) | `.claude/kaizen/{name}.md` |
| Is this a reference lookup? (architecture, procedures, recipes) | `docs/{name}.md` |
| Is this an interactive workflow with decision points? | `.claude/skills/{name}/SKILL.md` |
| Is this routing data? (trigger phrases → skills, key files, quick context) | **Keep in CLAUDE.md** |
| Is this a short rule or policy? (< 3 lines per item) | **Keep in CLAUDE.md** |

### Step 3: Decide what stays

**Always keep in CLAUDE.md** (agents need this in every conversation):
- Quick Context — project orientation
- Cases overview — core concept
- Key Files — navigation
- Skill trigger mappings — routing data (which phrases invoke which skills)
- Short policies — rules that fit in 1-2 lines each
- Database — query recipes
- Development — build/run commands
- Git Remotes — tiny, always needed

**Extract from CLAUDE.md** (agents only need when doing specific tasks):
- Detailed procedures (merging, deploying, IPC messaging)
- Verbose policies with sub-bullets and examples
- Architecture diagrams and layer tables
- Verification checklists
- Philosophical content (zen aphorisms)

### Step 4: Extract

For each section being extracted:

1. **Create the target file** with the full content, properly titled
2. **Replace in CLAUDE.md** with a 2-3 line pointer:
   ```markdown
   ## Section Name

   **Read [`path/to/file.md`](path/to/file.md)** when [trigger condition].

   Key points: [1-2 most important rules that agents should always remember].
   ```
3. **Verify** the pointer's path is correct and the file exists

### Step 5: Verify

```bash
# Check final size
wc -l CLAUDE.md

# Check all internal links resolve
grep -oE '\[.*?\]\((.*?)\)' CLAUDE.md | grep -oE '\(.*?\)' | tr -d '()' | while read link; do
  [ -f "$link" ] || echo "BROKEN: $link"
done
```

## Classification guide: kaizen vs not

**Belongs in `.claude/kaizen/`** if the content:
- Was learned from kaizen incidents (policies #11-17, verification discipline)
- Enforces the kaizen workflow (skill chain, reflection triggers)
- Would make sense if kaizen were extracted as a standalone system
- Is referenced by kaizen hooks or skills

**Does NOT belong in `.claude/kaizen/`** if the content:
- Is general engineering practice (TDD, dependency management)
- Is project infrastructure (merging, deploying, database)
- Is domain-specific (vertical architecture, IPC messaging)

When in doubt: if removing kaizen from the project would make this content irrelevant, it belongs in kaizen. If it would still be useful, it belongs elsewhere.

## Anti-patterns

- **Extracting too aggressively.** Short sections (< 10 lines) don't need extraction — the pointer overhead isn't worth it.
- **Losing routing data.** Skill trigger phrases MUST stay in CLAUDE.md. If agents can't see them, they won't invoke skills correctly.
- **Creating skills for passive content.** Reference docs are not skills. Only create a skill if the content is an interactive workflow with decision points.
- **Putting general dev practices in kaizen.** "Declare all dependencies" is not kaizen-specific. Keep it in CLAUDE.md.
