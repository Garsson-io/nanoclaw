#!/usr/bin/env npx tsx
/**
 * pr-review-loop.ts — Multi-round PR self-review with state tracking.
 *
 * Port of .claude/kaizen/hooks/pr-review-loop.sh (452 lines) to TypeScript.
 * PostToolUse hook on Bash — always exits 0 (advisory, not blocking).
 *
 * Triggers:
 *   1. gh pr create  — starts review loop (round 1)
 *   2. git push      — after pushing fixes, enforces next review round
 *   3. gh pr diff    — outputs checklist for current round
 *   4. gh pr merge   — sets up post-merge workflow gate
 *
 * Improvements over bash:
 * - Atomic state writes (no partial-read race conditions)
 * - No stat portability issues
 * - Proper string handling (no sed pipeline fragility)
 * - Typed state objects with validation
 * - No unbounded debug log growth
 */

import {
  readHookInput,
  exitCode,
  emit,
  exitHook,
  git,
  headSha,
  currentBranch,
  mainCheckout,
} from './hook-utils.js';
import {
  stripHeredocBody,
  isGhPrCommand,
  isGitCommand,
  reconstructPrUrl,
} from './parse-command.js';
import {
  readStateFile,
  writeStateFile,
  appendStateFile,
  deleteStateFile,
  ensureStateDir,
  prUrlToStateKey,
  prUrlToStateFilePath,
  findStateByStatuses,
  findNeedsReviewState,
  stateDir,
} from './state-utils.js';
import * as path from 'node:path';

const MAX_ROUNDS = 4;

// ── Helpers ──────────────────────────────────────────────────────────

function printChecklist(prUrl: string, round: string, maxRounds: number): string {
  return `
Use the /review-pr skill for the full checklist. Run \`/review-pr ${prUrl}\` now.

The skill covers: requirements verification, clarity, testability, code quality,
purpose/impact, security, documentation & system docs updates, and kaizen.

PROCESS:
1. Run \`/review-pr ${prUrl}\` — it will load the full checklist
2. Walk through EVERY section
3. If issues found: fix, commit, push, log what you fixed
4. Re-review from step 1 (next round)
5. If clean: state "REVIEW PASSED (round ${round}/${maxRounds})" and proceed

When review is clean, the hook will stop reminding you on subsequent pushes.

After ${maxRounds} rounds with remaining issues:
1. Comment on the PR summarizing unresolved issues and what was attempted:
   \`gh pr comment ${prUrl} --body "@aviadr1 Self-review hit ${maxRounds} rounds. Remaining issues: [list]. Need human eyes."\`
2. Ping Aviad on Telegram with the PR URL and a problem summary:
   \`cat > data/ipc/main/messages/review-escalation-$(date +%s).json << MSGEOF
   {"type":"message","chatJid":"tg:-5128317012","text":"\\ud83d\\udd0d PR self-review stuck after ${maxRounds} rounds: ${prUrl}\\n\\n[Write a short paragraph: what the PR does, what issues remain, and why you couldn't resolve them]"}
   MSGEOF\`
3. Then proceed — do not loop further
`;
}

/** Validate a PR URL looks like a GitHub URL. */
function isValidPrUrl(url: string): boolean {
  return /^https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/pull\/\d+$/.test(
    url,
  );
}

// ── Main ─────────────────────────────────────────────────────────────

function main(): void {
  const input = readHookInput();

  // Only trigger on successful commands
  if (exitCode(input) !== 0) exitHook(0);

  const command = input.tool_input.command ?? '';
  const stdout = input.tool_response.stdout ?? '';
  const stderr = input.tool_response.stderr ?? '';
  const cmdLine = stripHeredocBody(command);

  ensureStateDir();

  // Detect trigger
  const isPrCreate = isGhPrCommand(cmdLine, 'create');
  const isGitPush = isGitCommand(cmdLine, 'push');
  const isPrDiff = isGhPrCommand(cmdLine, 'diff');
  const isPrMerge = isGhPrCommand(cmdLine, 'merge');

  if (!isPrCreate && !isGitPush && !isPrDiff && !isPrMerge) exitHook(0);

  // ── TRIGGER 4: gh pr merge — set up post-merge workflow gate ────
  if (isPrMerge) {
    const mergeUrl = reconstructPrUrl(cmdLine, stdout, stderr, 'merge');
    let stateFilePath = '';

    if (mergeUrl) {
      stateFilePath = prUrlToStateFilePath(mergeUrl);
    } else {
      // Fallback: find active state
      const active = findNeedsReviewState();
      stateFilePath = active?.filePath ?? '';
    }

    // Clean up review state (review is done — PR is merging/merged)
    if (stateFilePath) deleteStateFile(stateFilePath);

    // Guard: skip state file creation if PR URL is empty
    if (!mergeUrl) {
      emit(`
\u26a0\ufe0f Could not determine PR URL from command output or arguments.
Post-merge workflow gate was NOT set \u2014 run /kaizen manually after confirming the merge.
`);
      exitHook(0);
    }

    const isAuto = /--auto/.test(cmdLine);
    const mergeBranch = currentBranch();
    const postMergeKey = prUrlToStateKey(mergeUrl);
    const postMergeStatePath = path.join(
      stateDir(),
      `post-merge-${postMergeKey}`,
    );
    const mc = mainCheckout();

    if (isAuto) {
      writeStateFile(postMergeStatePath, {
        PR_URL: mergeUrl,
        STATUS: 'awaiting_merge',
        BRANCH: mergeBranch,
      });

      emit(`
\u23f3 Auto-merge queued for: ${mergeUrl}

The PR will merge when CI passes. After confirming the merge (via \`gh pr view\`),
the post-merge workflow will activate. You will need to:
1. Run \`/kaizen\` for reflection
2. Mark the case as done
3. Sync main
4. Update linked issue

`);
    } else {
      writeStateFile(postMergeStatePath, {
        PR_URL: mergeUrl,
        STATUS: 'needs_post_merge',
        BRANCH: mergeBranch,
      });

      emit(`
\ud83c\udf89 PR merged: ${mergeUrl}

Now complete the post-merge workflow:
1. **Kaizen reflection (REQUIRED)** \u2014 Run \`/kaizen\` NOW. Reflect on impediments and submit structured KAIZEN_IMPEDIMENTS. This is not optional \u2014 skipping kaizen reflection after merge is a recurring failure pattern.
2. **Post-merge action needed** \u2014 classify per CLAUDE.md "Post-Merge: Deploy & Maintenance Policy":
   - CLAUDE.md/docs only \u2192 no action, active on next conversation
   - src/ changes \u2192 needs \`npm run build\` + service restart (~10s downtime)
   - container/Dockerfile \u2192 needs \`./container/build.sh\` + restart
   - package.json deps \u2192 needs \`npm install\` + build + restart
3. **Sync main** \u2014 \`git -C ${mc} fetch origin main && git -C ${mc} merge origin/main --no-edit\`
4. **Update linked issue** \u2014 Close the kaizen/tracking issue with lessons learned.
5. **Spec update** \u2014 If a spec/PRD exists, move completed work to "Already Solved".

\u26d4 You will NOT be able to finish until /kaizen is run.

`);
    }
    exitHook(0);
  }

  // ── TRIGGER 1: gh pr create — start the review loop ────────────
  if (isPrCreate) {
    const prUrl = reconstructPrUrl(cmdLine, stdout, stderr, 'create');
    if (!prUrl) exitHook(0);

    const stateFilePath = prUrlToStateFilePath(prUrl);
    const branch = currentBranch();

    writeStateFile(stateFilePath, {
      PR_URL: prUrl,
      ROUND: '1',
      STATUS: 'needs_review',
      BRANCH: branch,
    });

    // Record initial SHA for diff-size scaling (kaizen #117)
    const initialSha = headSha();
    if (initialSha) {
      appendStateFile(stateFilePath, 'LAST_REVIEWED_SHA', initialSha);
    }

    emit(`
\ud83d\udccb PR created: ${prUrl}

MANDATORY SELF-REVIEW LOOP \u2014 you MUST complete this before proceeding.

Review the PR, fix issues, re-review. Repeat up to ${MAX_ROUNDS} rounds until clean.

ROUND 1/${MAX_ROUNDS}: Start your review now.

For EACH round, work through this checklist. If you find issues, fix them,
commit, push, then start the next round.
`);
    emit(printChecklist(prUrl, '1', MAX_ROUNDS));
    emit(`
Track your round: "ROUND N/${MAX_ROUNDS}: [reviewing|issues found|clean]"
`);
    exitHook(0);
  }

  // ── TRIGGER 2: git push — enforce next review round ────────────
  if (isGitPush) {
    const found = findStateByStatuses('needs_review', 'passed');
    if (!found) exitHook(0);

    const { state, filePath: stateFilePath } = found;
    const prUrl = state.PR_URL ?? '';
    const round = parseInt(state.ROUND ?? '1', 10);
    const status = state.STATUS ?? '';

    if (!prUrl || !isValidPrUrl(prUrl)) exitHook(0);
    if (status === 'escalated') exitHook(0);

    // Skip round increment for merge-from-main pushes (kaizen #85, Fix B)
    const latestParents = git('log -1 --format=%P HEAD');
    const parents = latestParents.split(/\s+/).filter(Boolean);
    if (parents.length >= 2) {
      const mainHead = git('rev-parse origin/main');
      if (mainHead && parents.includes(mainHead)) {
        exitHook(0);
      }
    }

    const nextRound = round + 1;

    // Scale review depth to diff size (kaizen #117)
    const lastSha = state.LAST_REVIEWED_SHA ?? '';
    let diffLines = 0;
    if (lastSha) {
      const statOutput = git(`diff --stat ${lastSha}..HEAD`);
      const lastLine = statOutput.split('\n').pop() ?? '';
      const insertions = lastLine.match(/(\d+) insertion/)?.[1] ?? '0';
      const deletions = lastLine.match(/(\d+) deletion/)?.[1] ?? '0';
      diffLines = parseInt(insertions, 10) + parseInt(deletions, 10);
    }

    const SMALL_DIFF_THRESHOLD = 15;
    if (diffLines > 0 && diffLines <= SMALL_DIFF_THRESHOLD) {
      // Small diff — abbreviated review
      const diffPreview = git(
        `diff ${lastSha}..HEAD -- . ':!*.lock'`,
      ).slice(0, 3000);

      writeStateFile(stateFilePath, {
        PR_URL: prUrl,
        ROUND: String(nextRound),
        STATUS: 'passed',
        BRANCH: currentBranch(),
      });
      const newSha = headSha();
      if (newSha) appendStateFile(stateFilePath, 'LAST_REVIEWED_SHA', newSha);

      emit(`
\ud83d\udd0d Small push detected (${diffLines} lines changed) \u2014 abbreviated review (round ${nextRound}/${MAX_ROUNDS}).

\`\`\`diff
${diffPreview}
\`\`\`

Changes are minor. Review auto-passed. If you pushed a substantive fix,
run \`gh pr diff ${prUrl}\` for a full review.

`);
      exitHook(0);
    }

    // Escalation check
    if (nextRound > MAX_ROUNDS) {
      emit(`
\u26a0\ufe0f REVIEW ROUND ${MAX_ROUNDS}/${MAX_ROUNDS} COMPLETE \u2014 you've pushed fixes ${MAX_ROUNDS} times.

You MUST now escalate:
1. Comment on the PR: \`gh pr comment ${prUrl} --body "@aviadr1 Self-review hit ${MAX_ROUNDS} rounds. Remaining issues: [list]. Need human eyes."\`
2. Notify via Telegram IPC
3. Then proceed \u2014 do not loop further

Mark review as escalated.
`);
      writeStateFile(stateFilePath, {
        PR_URL: prUrl,
        ROUND: String(MAX_ROUNDS),
        STATUS: 'escalated',
        BRANCH: currentBranch(),
      });
      exitHook(0);
    }

    // Normal round increment
    writeStateFile(stateFilePath, {
      PR_URL: prUrl,
      ROUND: String(nextRound),
      STATUS: 'needs_review',
      BRANCH: currentBranch(),
    });

    emit(`
\ud83d\udd04 Push detected during PR review. Starting ROUND ${nextRound}/${MAX_ROUNDS}.

You MUST re-review the PR before proceeding. Do NOT skip this review round.

Run \`gh pr diff ${prUrl}\` now and walk through the checklist again.

Track your round: "ROUND ${nextRound}/${MAX_ROUNDS}: [reviewing|issues found|clean]"
`);
    exitHook(0);
  }

  // ── TRIGGER 3: gh pr diff — output checklist ───────────────────
  if (isPrDiff) {
    const found = findStateByStatuses('needs_review');
    if (!found) exitHook(0);

    const { state, filePath: stateFilePath } = found;
    const prUrl = state.PR_URL ?? '';
    const round = state.ROUND ?? '1';
    const status = state.STATUS ?? '';

    if (status === 'passed' || status === 'escalated') exitHook(0);

    emit(`
\ud83d\udccb REVIEW ROUND ${round}/${MAX_ROUNDS} \u2014 walk through the full checklist below.

If you find issues: fix, commit, push (which starts the next round).
If clean: state "REVIEW PASSED (round ${round}/${MAX_ROUNDS})" and the hook
will stop reminding you. To mark review complete, the agent should not push
further changes \u2014 the next push would start a new round.
`);
    emit(printChecklist(prUrl, round, MAX_ROUNDS));

    // After reviewing, mark as passed
    writeStateFile(stateFilePath, {
      PR_URL: prUrl,
      ROUND: round,
      STATUS: 'passed',
      BRANCH: currentBranch(),
    });
    const reviewedSha = headSha();
    if (reviewedSha) {
      appendStateFile(stateFilePath, 'LAST_REVIEWED_SHA', reviewedSha);
    }

    emit(`
\u2705 REVIEW PASSED (round ${round}/${MAX_ROUNDS})

Now report to the user:
1. **What this PR achieves** \u2014 summarize the changes and their purpose in 2-3 sentences
2. **PR status** \u2014 ready to merge, link: ${prUrl}
3. **Post-merge action needed** \u2014 classify per CLAUDE.md "Post-Merge: Deploy & Maintenance Policy":
   - CLAUDE.md/docs only \u2192 no action needed
   - src/ changes \u2192 needs \`npm run build\` + service restart (~10s downtime)
   - container/Dockerfile \u2192 needs \`./container/build.sh\` + restart
   - package.json deps \u2192 needs \`npm install\` + build + restart

`);
    exitHook(0);
  }

  exitHook(0);
}

main();
