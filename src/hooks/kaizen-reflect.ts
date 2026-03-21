#!/usr/bin/env npx tsx
/**
 * kaizen-reflect.ts — Triggers kaizen reflection after gh pr create/merge.
 *
 * Port of .claude/kaizen/hooks/kaizen-reflect.sh (197 lines) to TypeScript.
 * PostToolUse hook on Bash — always exits 0 (advisory, not blocking).
 *
 * Triggers:
 *   1. gh pr create — set kaizen gate + output reflection instructions
 *   2. gh pr merge  — same gate + Telegram notification to leads
 *
 * Improvements over bash:
 * - Native JSON parsing, no jq dependency
 * - Proper error handling for API calls
 * - Typed state management
 * - No silent failures on Telegram notification
 */

import {
  readHookInput,
  exitCode,
  emit,
  exitHook,
  currentBranch,
  shell,
  mainCheckout,
} from './hook-utils.js';
import {
  stripHeredocBody,
  isGhPrCommand,
  reconstructPrUrl,
  getPrChangedFiles,
} from './parse-command.js';
import {
  ensureStateDir,
  prUrlToStateKey,
  writeStateFile,
  isReflectionDone,
  stateDir,
} from './state-utils.js';
import { sendTelegramIpc } from './telegram-ipc.js';
import * as path from 'node:path';

// ── Reflection prompt templates ──────────────────────────────────────

function reflectionPrompt(
  event: 'create' | 'merge',
  prUrl: string,
  branch: string,
  changedFiles: string,
  mc: string,
): string {
  const eventLabel = event === 'create' ? 'Post-PR Creation' : 'Post-Merge';
  const extraMergeSteps =
    event === 'merge'
      ? `
**Also complete post-merge steps** (these are NOT delegated to the subagent):
- Follow Post-Merge deployment procedure in CLAUDE.md
- Sync main: \`git -C ${mc} fetch origin main && git -C ${mc} merge --ff-only origin/main\`
- Close resolved kaizen issues
- Delete merged branch and worktree`
      : '';

  return `
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\ud83d\udd04 KAIZEN REFLECTION \u2014 ${eventLabel} (background)
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501

Launch a background kaizen-bg subagent to handle reflection while you continue${event === 'merge' ? '\nwith post-merge steps (deploy verification, main sync, case closure).' : ' working.'}

**Use the Agent tool** with these parameters:
- subagent_type: "kaizen-bg"
- run_in_background: true
- prompt: Include this context:
  - Event: PR ${event === 'create' ? 'created' : 'merged'}
  - PR URL: ${prUrl}
  - Branch: ${branch}
  - Changed files: ${changedFiles}
  - List any impediments/friction you encountered during this work${event === 'merge' ? '\n  - Ask it to also check if any open kaizen issues are now resolved by this merge' : ''}
  - IMPORTANT: For each impediment, search existing kaizen issues FIRST.
    Recording an incident on an existing issue is MORE VALUABLE than filing new.
    New issues MUST have labels: kaizen + level-N + area/{subsystem}.
    See docs/issue-taxonomy.md for the full policy.

The kaizen-bg subagent will search for duplicate issues, file incidents, and
create new kaizen issues as needed. It will report results back to you.

**When the subagent completes**, use its results to clear the gate:

\`\`\`bash
echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
[
  {"impediment": "description", "disposition": "filed", "ref": "#NNN"},
  {"impediment": "description", "disposition": "incident", "ref": "#NNN"},
  {"impediment": "description", "disposition": "fixed-in-pr"},
  {"impediment": "description", "disposition": "waived", "reason": "why"}
]
IMPEDIMENTS
\`\`\`

If the subagent found no impediments: \`echo 'KAIZEN_IMPEDIMENTS: []'\`

\u26d4 You are GATED until you submit a valid KAIZEN_IMPEDIMENTS declaration.
Allowed commands: gh issue/pr, gh api, gh run, git read-only, ls/cat.

\u26a0\ufe0f **Waiver quality is enforced (kaizen #280).** Waivers with blocklisted
reasons ("low frequency", "overengineering", "edge case", etc.) are REJECTED.
Meta-findings waived must include "impact_minutes": N. If impact >= 5, file instead.
When in doubt, file \u2014 it takes 2 minutes; implementation is a separate decision.

For trivial changes (typo, formatting, docs-only), you may also use:
  \`echo 'KAIZEN_NO_ACTION [docs-only]: updated README formatting'\`
Valid categories: docs-only, formatting, typo, config-only, test-only, trivial-refactor
${extraMergeSteps}
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
`;
}

// ── Main ─────────────────────────────────────────────────────────────

function main(): void {
  const input = readHookInput();

  if (exitCode(input) !== 0) exitHook(0);

  const command = input.tool_input.command ?? '';
  const stdout = input.tool_response.stdout ?? '';
  const stderr = input.tool_response.stderr ?? '';
  const cmdLine = stripHeredocBody(command);

  const isCreate = isGhPrCommand(cmdLine, 'create');
  const isMerge = isGhPrCommand(cmdLine, 'merge');
  if (!isCreate && !isMerge) exitHook(0);

  // Extract PR URL
  const subcommand = isCreate ? 'create' : 'merge';
  const prUrl = reconstructPrUrl(cmdLine, stdout, stderr, subcommand);
  if (!prUrl) exitHook(0);

  // Skip gate if reflection was already done (kaizen #288)
  if (isReflectionDone(prUrl)) exitHook(0);

  const branch = currentBranch();
  const changedFiles = getPrChangedFiles(cmdLine, isMerge)
    .split('\n')
    .slice(0, 20)
    .join('\n');
  const mc = mainCheckout();

  // Set up kaizen gate state
  ensureStateDir();
  const stateFilePath = path.join(
    stateDir(),
    `pr-kaizen-${prUrlToStateKey(prUrl)}`,
  );
  writeStateFile(stateFilePath, {
    PR_URL: prUrl,
    STATUS: 'needs_pr_kaizen',
    BRANCH: branch,
  });

  // Output reflection prompt
  emit(
    reflectionPrompt(
      isCreate ? 'create' : 'merge',
      prUrl,
      branch,
      changedFiles,
      mc,
    ),
  );

  // Telegram notification on merge (kaizen #31)
  if (isMerge) {
    const prNumMatch = prUrl.match(/(\d+)$/);
    const repoMatch = prUrl.match(
      /https:\/\/github\.com\/([^/]+\/[^/]+)\/pull/,
    );
    let prTitle = 'unknown';
    if (prNumMatch && repoMatch) {
      prTitle =
        shell(
          `gh pr view ${prNumMatch[1]} --repo "${repoMatch[1]}" --json title --jq '.title'`,
        ) || 'unknown';
    }

    const notifyText = `\u2705 PR merged: ${prTitle}\n${prUrl}\nBranch: ${branch}\n\nCheck CLAUDE.md post-merge procedure for deploy steps.`;
    sendTelegramIpc(notifyText);
  }

  exitHook(0);
}

main();
