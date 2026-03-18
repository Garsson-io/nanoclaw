# Test Side Effects & Kaizen Escalation — Specification

## 1. Problem Statement

### A. Test side effect: contract.json mutation

`generate-contract.test.ts` calls `tsx scripts/generate-contract.ts` which overwrites the tracked `contract.json` file with a fresh `generatedAt` timestamp. This happens during every `npm test` run. The surfaces are identical, but the timestamp diff leaves a dirty working tree.

**Who experiences the problem:** Dev agents. The `check-dirty-files` hook blocks `git push` when tracked files have uncommitted changes. The agent must manually `git checkout -- contract.json` before every push — and if they forget, the hook blocks them.

**What happened:** This exact issue blocked pushes **twice in the same session** (during PRs #103 and #110). Both times, the kaizen reflection correctly identified the root cause. Neither time was the fix applied — the agent just restored the file and moved on.

**Cost of not solving it:** Every future `npm test` run dirties `contract.json`. Every future push requires manual cleanup. The hook fires, the agent writes a kaizen reflection, restores the file, and pushes again. Wasted cycles, every time.

### B. Kaizen reflection doesn't escalate repeat issues

The kaizen reflection process (triggered by the `check-dirty-files` hook) asks three questions: what happened, what gap led to it, what would prevent it. The agent answered correctly both times. But answering correctly and fixing the problem are different things.

**The gap in the gap-analysis:** When the same root cause appears in multiple kaizen reflections within a session, the process should escalate. The CLAUDE.md kaizen policy already says this:

> "Has this type of failure happened before? If yes, the previous level wasn't enough — escalate."

But there's no mechanism to enforce it. The reflection is Level 1 (instructions). Repeated Level 1 reflections on the same issue should trigger Level 2 (a hook or automation that prevents the problem) or Level 3 (a code fix that eliminates the problem class entirely).

## 2. Desired End State

After this work:

1. **`npm test` does not dirty tracked files.** The generate-contract test writes to a temp path, not `contract.json`. The working tree is clean after tests.

2. **Kaizen reflections on repeated issues demand escalation.** When a dev agent writes a kaizen reflection on the same root cause for the second time, the process requires them to implement the fix (not just describe it) before proceeding.

### Out of scope

- Changing the `check-dirty-files` hook itself (it's working correctly — the problem is the test)
- Automated deduplication of kaizen reflections across sessions (useful but separate)

## 3. What Exists vs What Needs Building

### Already Solved

| Capability | Current implementation | Status |
|------------|----------------------|--------|
| Dirty file detection | `.claude/kaizen/hooks/check-dirty-files.sh` | Working — correctly blocks pushes |
| Contract generation | `scripts/generate-contract.ts` | Working — deterministic surfaces |
| Contract check (read-only) | `scripts/generate-contract.ts check` | Working — compares without writing |
| Kaizen reflection prompt | `check-dirty-files.sh` output | Working — asks the right questions |

### Needs Building

| Component | What | Why it doesn't exist yet |
|-----------|------|-------------------------|
| Test isolation for generate-contract | Test writes to temp file, not `contract.json` | Original test took the simplest path — calling the script directly |
| Kaizen escalation enforcement | Hook or process that detects repeated reflections and demands a fix | Kaizen reflections are currently fire-and-forget text responses |

## 4. Implementation

### Fix A: Isolate the generate-contract test

**Current code** (`scripts/generate-contract.test.ts`):
```typescript
function getGeneratedContract() {
  execSync('tsx scripts/generate-contract.ts', { cwd: ROOT, stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(contractPath, 'utf-8'));
}
```

This calls the CLI which writes to `contract.json`. The test also has a "check fails when stale" test that tampers with `contract.json` and restores it.

**Fix options:**

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A1: Restore after test | Save `contract.json` content before, restore in `afterAll` | Minimal change | Still writes to tracked file during run — race conditions with parallel test runners |
| A2: Write to temp dir | Pass output path as env var or arg; test uses temp dir | Clean isolation, no tracked file mutation | Requires small refactor to generator script |
| A3: Export and call directly | Import the generate function, compare in memory | No file I/O in tests, fastest | Requires refactoring generator to export `generateContract()` |

**Lean: A3** — the generator already has a `generateContract()` function. Export it, import it in the test, and compare the result in memory. The "check mode" test can use a temp file. This eliminates the side effect entirely.

For the "check fails when stale" test: write a tampered contract to a temp file, then run check against that temp file.

### Fix B: Kaizen escalation for repeated reflections

This is a process/culture fix more than a code fix. The key insight:

> **A kaizen reflection that identifies a fixable root cause but doesn't fix it is incomplete.**

The `check-dirty-files` hook already forces the agent to reflect. What's missing is the forcing function to act on repeated reflections.

**Proposed escalation rule** (for CLAUDE.md):

When writing a kaizen reflection, the agent MUST check: "Have I written a reflection on this same root cause before in this session?" If yes:
- The previous reflection was Level 1 (instruction to self)
- Level 1 failed (the problem recurred)
- The agent MUST now implement a Level 2 or Level 3 fix before proceeding
- "I'll fix it later" is not acceptable for a repeated issue

This is itself a Level 1 fix (an instruction in CLAUDE.md). If it fails — if agents keep writing repeated reflections without escalating — then it should become a Level 2 hook that checks for duplicate root causes in the session's reflection history.

## 5. Implementation Sequencing

```
Fix A (test isolation) ─── standalone, ~15min
Fix B (CLAUDE.md rule)  ─── standalone, ~5min
```

No dependencies between them. Fix A is the higher-value change (eliminates the recurring trigger). Fix B prevents the meta-failure pattern across all future kaizen reflections.

## 6. Open Questions

**Q1: Should the generate-contract script accept an output path argument?**
This would make it testable without any in-memory export. But A3 (export the function) is cleaner for testing. The CLI can keep writing to `contract.json` — only the test changes.
Lean: A3, no output path argument needed.
