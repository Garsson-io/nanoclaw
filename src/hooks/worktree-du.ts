/**
 * worktree-du.ts — TypeScript port of scripts/worktree-du.sh core logic
 *
 * Extracts the data aggregation and analysis functions from the bash script
 * into typed, testable TypeScript. The bash script had incidents with arithmetic
 * in grep/sed pipelines (e.g., grep -cv producing "0\n0" instead of "0").
 *
 * Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
 * Migration: kaizen #331 (Phase 3.4 of docs/hook-language-boundaries.md)
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ─── Lock file management ───

export interface LockFile {
  pid?: number;
  heartbeat?: string;
  started_at?: string;
  session_id?: string;
  case_name?: string;
}

export type LockClass = 'active' | 'stale' | 'orphaned' | 'none';

const STALE_THRESHOLD_MS = 1800_000; // 30 minutes

/** Parse a .worktree-lock.json file. Returns null if not found or invalid. */
export function parseLockFile(worktreePath: string): LockFile | null {
  const lockPath = join(worktreePath, '.worktree-lock.json');
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8')) as LockFile;
  } catch {
    return null;
  }
}

/** Check if a PID is alive. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Get the age of a lock's heartbeat in milliseconds. Returns Infinity if no heartbeat. */
export function getLockAgeMs(lock: LockFile): number {
  const hb = lock.heartbeat ?? lock.started_at;
  if (!hb) return Infinity;
  const hbTime = new Date(hb).getTime();
  if (isNaN(hbTime)) return Infinity;
  return Date.now() - hbTime;
}

/** Format a duration in ms to a human-readable string (e.g., "5min", "2hr", "1d"). */
export function formatAge(ms: number): string {
  if (!isFinite(ms)) return '?';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}min`;
  if (mins < 1440) return `${Math.round(mins / 60)}hr`;
  return `${Math.round(mins / 1440)}d`;
}

/**
 * Classify a lock: active (live PID + fresh heartbeat), stale (live PID but old
 * heartbeat — suspended session), orphaned (dead PID), or none.
 */
export function classifyLock(worktreePath: string): LockClass {
  const lock = parseLockFile(worktreePath);
  if (!lock) return 'none';

  const pid = lock.pid;
  if (pid && isPidAlive(pid)) {
    const ageMs = getLockAgeMs(lock);
    return ageMs < STALE_THRESHOLD_MS ? 'active' : 'stale';
  }

  return 'orphaned';
}

// ─── Branch analysis ───

export type MergeStatus = 'merged' | 'squash-merged' | 'at-main' | 'unmerged';

/** Get the list of branches merged into main. */
export function getMergedBranches(projectRoot: string): Set<string> {
  try {
    const output = execSync('git branch --merged main', {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new Set(
      output
        .split('\n')
        .map((b) => b.replace(/^[* +]*/, '').trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/**
 * Determine how a branch relates to main:
 * - merged: diverged then merged back (regular merge)
 * - squash-merged: changes are in main via squash (different SHA, same content)
 * - at-main: never diverged (0 commits ahead)
 * - unmerged: has changes not yet in main
 */
export function branchMergeStatus(
  branch: string,
  projectRoot: string,
  mergedBranches?: Set<string>,
): MergeStatus {
  const merged = mergedBranches ?? getMergedBranches(projectRoot);

  if (merged.has(branch)) {
    try {
      const ahead = execSync(`git rev-list --count main..${branch}`, {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return parseInt(ahead, 10) === 0 ? 'at-main' : 'merged';
    } catch {
      return 'merged';
    }
  }

  // Squash-merge detection: branch not in --merged but its tree may match main's
  try {
    const diffStat = execSync(`git diff --stat main..${branch}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (diffStat === '') return 'squash-merged';
  } catch {
    // git diff failed — can't determine, assume unmerged
  }

  return 'unmerged';
}

// ─── Worktree analysis ───

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  lockClass: LockClass;
  lockAge: string;
  mergeStatus: MergeStatus;
  dirtyFileCount: number;
  unpushedCommitCount: number;
}

/** Get the current branch of a worktree. */
function getWorktreeBranch(wtPath: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: wtPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '?';
  }
}

/**
 * Count dirty files in a worktree, EXCLUDING .worktree-lock.json.
 *
 * This replaces the bash pattern that caused an incident:
 *   grep -cv '.worktree-lock.json' || echo "0"
 * which could produce "0\n0" instead of "0".
 */
export function countDirtyFiles(wtPath: string): number {
  try {
    const porcelain = execSync('git status --porcelain', {
      cwd: wtPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return porcelain
      .split('\n')
      .filter(
        (line) => line.trim() !== '' && !line.includes('.worktree-lock.json'),
      ).length;
  } catch {
    return 0;
  }
}

/** Count unpushed commits (commits ahead of upstream). */
export function countUnpushedCommits(wtPath: string): number {
  try {
    const output = execSync('git log --oneline @{u}..HEAD', {
      cwd: wtPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}

/** Analyze all worktrees in the worktrees directory. */
export function analyzeWorktrees(
  worktreesDir: string,
  projectRoot: string,
): WorktreeInfo[] {
  if (!existsSync(worktreesDir)) return [];

  const mergedBranches = getMergedBranches(projectRoot);
  const results: WorktreeInfo[] = [];

  for (const entry of readdirSync(worktreesDir)) {
    const wtPath = join(worktreesDir, entry);
    try {
      if (!statSync(wtPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const branch = getWorktreeBranch(wtPath);
    const lockClass = classifyLock(wtPath);
    const lock = parseLockFile(wtPath);
    const lockAge = lock ? formatAge(getLockAgeMs(lock)) : '-';

    results.push({
      name: entry,
      path: wtPath,
      branch,
      lockClass,
      lockAge,
      mergeStatus: branchMergeStatus(branch, projectRoot, mergedBranches),
      dirtyFileCount: countDirtyFiles(wtPath),
      unpushedCommitCount: countUnpushedCommits(wtPath),
    });
  }

  return results;
}

/**
 * Determine if a worktree is eligible for cleanup.
 * A worktree is cleanable if:
 * - Lock is 'none' or 'orphaned' (never remove active/stale)
 * - Branch is merged, squash-merged, or at-main
 * - No dirty files
 * - No unpushed commits (except at-main which has 0 by definition)
 */
export function isCleanable(wt: WorktreeInfo): boolean {
  if (wt.lockClass === 'active' || wt.lockClass === 'stale') return false;
  if (wt.mergeStatus === 'unmerged') return false;
  if (wt.dirtyFileCount > 0) return false;
  if (wt.mergeStatus !== 'at-main' && wt.unpushedCommitCount > 0) return false;
  return true;
}

/** Format bytes to human-readable size. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KiB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GiB`;
}
