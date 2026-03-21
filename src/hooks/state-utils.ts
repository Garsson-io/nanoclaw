/**
 * state-utils.ts — State file management for workflow gate hooks.
 *
 * Port of .claude/kaizen/hooks/lib/state-utils.sh to TypeScript.
 *
 * Improvements over bash:
 * - Atomic writes (temp file + rename) prevent race conditions
 * - No stat portability issues (fs.statSync works everywhere)
 * - Typed state objects instead of grep/cut parsing
 * - Proper error handling instead of `|| true`
 * - No glob expansion bugs when directory is empty
 *
 * CROSS-WORKTREE ISOLATION: All state filtering goes through these
 * functions. The golden rule: a hook in worktree A must NEVER read,
 * modify, or block based on state from worktree B.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { currentBranch, shell } from './hook-utils.js';

// ── Configuration ────────────────────────────────────────────────────

/**
 * State directory — reads from env each time to support test overrides.
 * All internal functions use this getter, never a cached const.
 */
export function stateDir(): string {
  return process.env.STATE_DIR ?? '/tmp/.pr-review-state';
}
/** @deprecated Use stateDir() — this export exists for backward compat. */
export const STATE_DIR = '/tmp/.pr-review-state';
export const MAX_STATE_AGE = parseInt(
  process.env.MAX_STATE_AGE ?? '7200',
  10,
);

// ── State file types ─────────────────────────────────────────────────

export interface StateFile {
  PR_URL: string;
  STATUS: string;
  BRANCH: string;
  ROUND?: string;
  LAST_REVIEWED_SHA?: string;
  [key: string]: string | undefined;
}

// ── State file I/O ───────────────────────────────────────────────────

/** Parse a state file into a typed object. Returns null if file doesn't exist. */
export function readStateFile(filePath: string): StateFile | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const state: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        state[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
      }
    }
    return state as unknown as StateFile;
  } catch {
    return null;
  }
}

/**
 * Write a state file atomically (temp file + rename).
 * Prevents race conditions where concurrent hooks read partial writes.
 */
export function writeStateFile(
  filePath: string,
  state: Record<string, string>,
): void {
  ensureStateDir();
  const lines = Object.entries(state)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const tmpFile = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, lines + '\n', { mode: 0o600 });
  fs.renameSync(tmpFile, filePath);
}

/** Append a key=value line to a state file. */
export function appendStateFile(filePath: string, key: string, value: string): void {
  fs.appendFileSync(filePath, `${key}=${value}\n`);
}

/** Delete a state file if it exists. */
export function deleteStateFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore — already deleted or never existed
  }
}

/** Ensure the state directory exists. */
export function ensureStateDir(): void {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
}

// ── Key derivation ───────────────────────────────────────────────────

/**
 * Convert a PR URL to a safe state file key.
 * e.g. https://github.com/Garsson-io/nanoclaw/pull/33 -> Garsson-io_nanoclaw_33
 */
export function prUrlToStateKey(url: string): string {
  return url
    .replace('https://github.com/', '')
    .replace('/pull/', '_')
    .replace(/\//g, '_');
}

/** Get the full state file path for a PR URL. */
export function prUrlToStateFilePath(url: string): string {
  return path.join(stateDir(), prUrlToStateKey(url));
}

// ── Staleness & isolation ────────────────────────────────────────────

/** Get file modification time in seconds since epoch. Returns 0 on error. */
function fileMtime(filePath: string): number {
  try {
    return Math.floor(fs.statSync(filePath).mtimeMs / 1000);
  } catch {
    return 0;
  }
}

/**
 * Check if a state file belongs to the current worktree and is not stale.
 *
 * A state file is SKIPPED if:
 *   1. It is older than MAX_STATE_AGE
 *   2. It has a BRANCH field that doesn't match the current branch
 *   3. It has NO BRANCH field (legacy)
 */
export function isStateForCurrentWorktree(
  filePath: string,
  now?: number,
  branch?: string,
): boolean {
  const state = readStateFile(filePath);
  if (!state) return false;

  const currentTime = now ?? Math.floor(Date.now() / 1000);
  const mtime = fileMtime(filePath);
  if (currentTime - mtime > MAX_STATE_AGE) return false;

  const fileBranch = state.BRANCH;
  if (!fileBranch) return false;

  const currentBr = branch ?? currentBranch();
  if (fileBranch !== currentBr) return false;

  return true;
}

/** List all state file paths in the state directory. */
function listAllStateFiles(): string[] {
  const dir = stateDir();
  try {
    return fs
      .readdirSync(dir)
      .map((f) => path.join(dir, f))
      .filter((f) => {
        try {
          return fs.statSync(f).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

// ── Current-branch state queries ─────────────────────────────────────

/** List state files for the current worktree (branch-scoped + staleness). */
export function listStateFilesForCurrentWorktree(): string[] {
  const now = Math.floor(Date.now() / 1000);
  const branch = currentBranch();
  return listAllStateFiles().filter((f) =>
    isStateForCurrentWorktree(f, now, branch),
  );
}

/** Find the first state file with a given STATUS for the current branch. */
export function findStateWithStatus(
  wantedStatus: string,
): { prUrl: string; status: string; filePath: string } | null {
  for (const f of listStateFilesForCurrentWorktree()) {
    const state = readStateFile(f);
    if (state?.STATUS === wantedStatus) {
      return { prUrl: state.PR_URL ?? '', status: state.STATUS, filePath: f };
    }
  }
  return null;
}

/**
 * Find the most recent state file matching any of the given statuses.
 * Used by pr-review-loop to find needs_review OR passed states.
 */
export function findStateByStatuses(
  ...statuses: string[]
): { state: StateFile; filePath: string } | null {
  const statusSet = new Set(statuses);
  let latest: { state: StateFile; filePath: string } | null = null;
  let latestMtime = 0;

  for (const f of listStateFilesForCurrentWorktree()) {
    const state = readStateFile(f);
    if (state && statusSet.has(state.STATUS)) {
      const mtime = fileMtime(f);
      if (mtime > latestMtime) {
        latest = { state, filePath: f };
        latestMtime = mtime;
      }
    }
  }
  return latest;
}

/** Find the first needs_review state, auto-clearing merged/closed PRs. */
export function findNeedsReviewState(): {
  prUrl: string;
  round: string;
  filePath: string;
} | null {
  for (const f of listStateFilesForCurrentWorktree()) {
    const state = readStateFile(f);
    if (state?.STATUS === 'needs_review') {
      if (state.PR_URL) {
        const prState = shell(
          `gh pr view "${state.PR_URL}" --json state --jq .state`,
        );
        if (prState === 'MERGED' || prState === 'CLOSED') {
          deleteStateFile(f);
          continue;
        }
      }
      return {
        prUrl: state.PR_URL ?? '',
        round: state.ROUND ?? '1',
        filePath: f,
      };
    }
  }
  return null;
}

/** Clear the first state file matching STATUS for current branch. */
export function clearStateWithStatus(wantedStatus: string): boolean {
  for (const f of listStateFilesForCurrentWorktree()) {
    const state = readStateFile(f);
    if (state?.STATUS === wantedStatus) {
      deleteStateFile(f);
      return true;
    }
  }
  return false;
}

/** Clear ALL state files matching STATUS for current branch. */
export function clearAllStatesWithStatus(wantedStatus: string): boolean {
  let cleared = false;
  for (const f of listStateFilesForCurrentWorktree()) {
    const state = readStateFile(f);
    if (state?.STATUS === wantedStatus) {
      deleteStateFile(f);
      cleared = true;
    }
  }
  return cleared;
}

// ── Cross-branch state queries ───────────────────────────────────────

/** List state files checking staleness but NOT branch (for active declarations). */
export function listStateFilesAnyBranch(): string[] {
  const now = Math.floor(Date.now() / 1000);
  return listAllStateFiles().filter((f) => {
    const state = readStateFile(f);
    if (!state?.BRANCH) return false;
    const mtime = fileMtime(f);
    return now - mtime <= MAX_STATE_AGE;
  });
}

/** Find state with STATUS across all branches. */
export function findStateWithStatusAnyBranch(
  wantedStatus: string,
): { prUrl: string; status: string; filePath: string } | null {
  for (const f of listStateFilesAnyBranch()) {
    const state = readStateFile(f);
    if (state?.STATUS === wantedStatus) {
      return { prUrl: state.PR_URL ?? '', status: state.STATUS, filePath: f };
    }
  }
  return null;
}

/**
 * Clear state with STATUS across all branches.
 * Optional prUrl to target a specific state file (kaizen #309).
 */
export function clearStateWithStatusAnyBranch(
  wantedStatus: string,
  prUrl?: string,
): boolean {
  for (const f of listStateFilesAnyBranch()) {
    const state = readStateFile(f);
    if (state?.STATUS === wantedStatus) {
      if (prUrl && state.PR_URL !== prUrl) continue;
      deleteStateFile(f);
      return true;
    }
  }
  return false;
}

// ── Kaizen issue auto-close (kaizen #283) ────────────────────────────

/** Auto-close kaizen issues referenced in a merged PR body. */
export function autoCloseKaizenIssues(prUrl: string): number {
  if (!prUrl) return 0;

  const prNumMatch = prUrl.match(/(\d+)$/);
  const repoMatch = prUrl.match(
    /https:\/\/github\.com\/([^/]+\/[^/]+)\/pull/,
  );
  if (!prNumMatch || !repoMatch) return 0;

  const prNum = prNumMatch[1];
  const repo = repoMatch[1];

  const prState = shell(
    `gh pr view ${prNum} --repo "${repo}" --json state --jq .state`,
  );
  if (prState !== 'MERGED') return 0;

  const prBody = shell(
    `gh pr view ${prNum} --repo "${repo}" --json body --jq .body`,
  );
  if (!prBody) return 0;

  const issueNums = new Set<string>();
  for (const m of prBody.matchAll(/Garsson-io\/kaizen[#/issues/]*(\d+)/g))
    issueNums.add(m[1]);
  for (const m of prBody.matchAll(
    /https:\/\/github\.com\/Garsson-io\/kaizen\/issues\/(\d+)/g,
  ))
    issueNums.add(m[1]);

  let closedCount = 0;
  for (const num of issueNums) {
    const issueState = shell(
      `gh issue view ${num} --repo Garsson-io/kaizen --json state --jq .state`,
    );
    if (issueState === 'OPEN') {
      const result = shell(
        `gh issue close ${num} --repo Garsson-io/kaizen --comment "Auto-closed: implementing PR merged (${prUrl})"`,
      );
      if (result !== '') closedCount++;
    }
  }

  return closedCount;
}

// ── Reflection tracking (kaizen #288) ────────────────────────────────

/** Mark a PR's reflection as completed. */
export function markReflectionDone(prUrl: string): void {
  if (!prUrl) return;
  const key = prUrlToStateKey(prUrl);
  const branch = currentBranch();
  writeStateFile(path.join(stateDir(), `kaizen-done-${key}`), {
    PR_URL: prUrl,
    STATUS: 'kaizen_done',
    BRANCH: branch,
  });
}

/** Check if a PR's reflection has already been completed. */
export function isReflectionDone(prUrl: string): boolean {
  if (!prUrl) return false;
  const key = prUrlToStateKey(prUrl);
  const marker = path.join(stateDir(), `kaizen-done-${key}`);

  try {
    if (!fs.existsSync(marker)) return false;
  } catch {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const mtime = fileMtime(marker);
  if (now - mtime > MAX_STATE_AGE) {
    deleteStateFile(marker);
    return false;
  }
  return true;
}
