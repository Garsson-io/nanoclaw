import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyLock,
  countDirtyFiles,
  formatAge,
  getLockAgeMs,
  humanSize,
  isCleanable,
  isPidAlive,
  parseLockFile,
  type LockFile,
  type WorktreeInfo,
} from './worktree-du.js';

const TEST_DIR = '/tmp/.test-worktree-du-ts';

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

function createLockFile(dir: string, lock: LockFile): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.worktree-lock.json'), JSON.stringify(lock));
}

describe('parseLockFile', () => {
  it('returns null for non-existent directory', () => {
    expect(parseLockFile('/tmp/does-not-exist-xyz')).toBeNull();
  });

  it('parses a valid lock file', () => {
    createLockFile(TEST_DIR, {
      pid: 12345,
      heartbeat: '2026-03-21T10:00:00Z',
      session_id: 'test-session',
    });
    const lock = parseLockFile(TEST_DIR);
    expect(lock).not.toBeNull();
    expect(lock!.pid).toBe(12345);
    expect(lock!.heartbeat).toBe('2026-03-21T10:00:00Z');
  });

  it('returns null for invalid JSON', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, '.worktree-lock.json'), 'not json');
    expect(parseLockFile(TEST_DIR)).toBeNull();
  });
});

describe('isPidAlive', () => {
  it('returns true for current process PID', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for non-existent PID', () => {
    // PID 999999 is almost certainly not running
    expect(isPidAlive(999999)).toBe(false);
  });
});

describe('getLockAgeMs', () => {
  it('returns age from heartbeat', () => {
    const tenMinutesAgo = new Date(Date.now() - 600_000).toISOString();
    const age = getLockAgeMs({ heartbeat: tenMinutesAgo });
    // Should be approximately 600000ms (allow 5s tolerance)
    expect(age).toBeGreaterThan(595_000);
    expect(age).toBeLessThan(605_000);
  });

  it('falls back to started_at when heartbeat is missing', () => {
    const fiveMinutesAgo = new Date(Date.now() - 300_000).toISOString();
    const age = getLockAgeMs({ started_at: fiveMinutesAgo });
    expect(age).toBeGreaterThan(295_000);
    expect(age).toBeLessThan(305_000);
  });

  it('returns Infinity when no timestamp', () => {
    expect(getLockAgeMs({})).toBe(Infinity);
  });

  it('returns Infinity for invalid date', () => {
    expect(getLockAgeMs({ heartbeat: 'not-a-date' })).toBe(Infinity);
  });
});

describe('formatAge', () => {
  it('formats minutes', () => {
    expect(formatAge(5 * 60_000)).toBe('5min');
    expect(formatAge(30 * 60_000)).toBe('30min');
  });

  it('formats hours', () => {
    expect(formatAge(2 * 60 * 60_000)).toBe('2hr');
    expect(formatAge(23 * 60 * 60_000)).toBe('23hr');
  });

  it('formats days', () => {
    expect(formatAge(24 * 60 * 60_000)).toBe('1d');
    expect(formatAge(72 * 60 * 60_000)).toBe('3d');
  });

  it('handles Infinity', () => {
    expect(formatAge(Infinity)).toBe('?');
  });

  it('handles zero', () => {
    expect(formatAge(0)).toBe('0min');
  });
});

describe('classifyLock', () => {
  it('returns none for directory without lock file', () => {
    mkdirSync(join(TEST_DIR, 'no-lock'), { recursive: true });
    expect(classifyLock(join(TEST_DIR, 'no-lock'))).toBe('none');
  });

  it('returns orphaned for dead PID', () => {
    const dir = join(TEST_DIR, 'orphaned');
    createLockFile(dir, {
      pid: 999999,
      heartbeat: new Date().toISOString(),
    });
    expect(classifyLock(dir)).toBe('orphaned');
  });

  it('returns active for current process PID with fresh heartbeat', () => {
    const dir = join(TEST_DIR, 'active');
    createLockFile(dir, {
      pid: process.pid,
      heartbeat: new Date().toISOString(),
    });
    expect(classifyLock(dir)).toBe('active');
  });

  it('returns stale for current process PID with old heartbeat', () => {
    const dir = join(TEST_DIR, 'stale');
    createLockFile(dir, {
      pid: process.pid,
      heartbeat: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), // 2 hours ago
    });
    expect(classifyLock(dir)).toBe('stale');
  });
});

describe('isCleanable', () => {
  const base: WorktreeInfo = {
    name: 'test-wt',
    path: '/tmp/test',
    branch: 'test-branch',
    lockClass: 'none',
    lockAge: '-',
    mergeStatus: 'merged',
    dirtyFileCount: 0,
    unpushedCommitCount: 0,
  };

  it('merged + clean + no lock = cleanable', () => {
    expect(isCleanable(base)).toBe(true);
  });

  it('squash-merged + clean = cleanable', () => {
    expect(isCleanable({ ...base, mergeStatus: 'squash-merged' })).toBe(true);
  });

  it('at-main + clean = cleanable', () => {
    expect(isCleanable({ ...base, mergeStatus: 'at-main' })).toBe(true);
  });

  it('active lock = not cleanable', () => {
    expect(isCleanable({ ...base, lockClass: 'active' })).toBe(false);
  });

  it('stale lock = not cleanable', () => {
    expect(isCleanable({ ...base, lockClass: 'stale' })).toBe(false);
  });

  it('orphaned lock = cleanable (dead PID)', () => {
    expect(isCleanable({ ...base, lockClass: 'orphaned' })).toBe(true);
  });

  it('unmerged = not cleanable', () => {
    expect(isCleanable({ ...base, mergeStatus: 'unmerged' })).toBe(false);
  });

  it('dirty files = not cleanable', () => {
    expect(isCleanable({ ...base, dirtyFileCount: 3 })).toBe(false);
  });

  it('unpushed commits on merged branch = not cleanable', () => {
    expect(isCleanable({ ...base, unpushedCommitCount: 2 })).toBe(false);
  });

  it('at-main ignores unpushed commits (always 0 by definition)', () => {
    expect(
      isCleanable({ ...base, mergeStatus: 'at-main', unpushedCommitCount: 0 }),
    ).toBe(true);
  });
});

describe('humanSize', () => {
  it('formats bytes', () => {
    expect(humanSize(500)).toBe('500B');
  });

  it('formats KiB', () => {
    expect(humanSize(2048)).toBe('2KiB');
  });

  it('formats MiB', () => {
    expect(humanSize(5 * 1024 * 1024)).toBe('5.0MiB');
  });

  it('formats GiB', () => {
    expect(humanSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5GiB');
  });
});
