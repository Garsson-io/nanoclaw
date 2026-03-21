import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  readStateFile,
  writeStateFile,
  appendStateFile,
  deleteStateFile,
  prUrlToStateKey,
  prUrlToStateFilePath,
  isStateForCurrentWorktree,
  markReflectionDone,
  isReflectionDone,
} from './state-utils.js';

// Use a temp dir for all state tests
let testStateDir: string;

beforeEach(() => {
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
  process.env.STATE_DIR = testStateDir;
});

afterEach(() => {
  fs.rmSync(testStateDir, { recursive: true, force: true });
  delete process.env.STATE_DIR;
});

describe('prUrlToStateKey', () => {
  it('converts nanoclaw PR URL to key', () => {
    expect(
      prUrlToStateKey('https://github.com/Garsson-io/nanoclaw/pull/33'),
    ).toBe('Garsson-io_nanoclaw_33');
  });

  it('converts garsson-prints PR URL to key', () => {
    expect(
      prUrlToStateKey('https://github.com/Garsson-io/garsson-prints/pull/2'),
    ).toBe('Garsson-io_garsson-prints_2');
  });

  it('different repos produce different keys', () => {
    const key1 = prUrlToStateKey(
      'https://github.com/Garsson-io/nanoclaw/pull/33',
    );
    const key2 = prUrlToStateKey(
      'https://github.com/Garsson-io/garsson-prints/pull/2',
    );
    expect(key1).not.toBe(key2);
  });
});

describe('readStateFile / writeStateFile', () => {
  it('writes and reads state atomically', () => {
    const filePath = path.join(testStateDir, 'test-state');
    writeStateFile(filePath, {
      PR_URL: 'https://github.com/Garsson-io/nanoclaw/pull/1',
      ROUND: '2',
      STATUS: 'needs_review',
      BRANCH: 'test-branch',
    });

    const state = readStateFile(filePath);
    expect(state).not.toBeNull();
    expect(state!.PR_URL).toBe(
      'https://github.com/Garsson-io/nanoclaw/pull/1',
    );
    expect(state!.ROUND).toBe('2');
    expect(state!.STATUS).toBe('needs_review');
    expect(state!.BRANCH).toBe('test-branch');
  });

  it('returns null for non-existent file', () => {
    expect(readStateFile(path.join(testStateDir, 'nonexistent'))).toBeNull();
  });

  it('overwrites existing state file', () => {
    const filePath = path.join(testStateDir, 'test-overwrite');
    writeStateFile(filePath, { STATUS: 'old', PR_URL: 'x', BRANCH: 'b' });
    writeStateFile(filePath, { STATUS: 'new', PR_URL: 'y', BRANCH: 'b' });

    const state = readStateFile(filePath);
    expect(state!.STATUS).toBe('new');
    expect(state!.PR_URL).toBe('y');
  });

  it('sets restrictive permissions (600)', () => {
    const filePath = path.join(testStateDir, 'test-perms');
    writeStateFile(filePath, { STATUS: 'test', PR_URL: 'x', BRANCH: 'b' });

    const stats = fs.statSync(filePath);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe('600');
  });
});

describe('appendStateFile', () => {
  it('appends key=value to existing state', () => {
    const filePath = path.join(testStateDir, 'test-append');
    writeStateFile(filePath, {
      PR_URL: 'test',
      STATUS: 'needs_review',
      BRANCH: 'b',
    });
    appendStateFile(filePath, 'LAST_REVIEWED_SHA', 'abc123');

    const state = readStateFile(filePath);
    expect(state!.LAST_REVIEWED_SHA).toBe('abc123');
  });
});

describe('deleteStateFile', () => {
  it('deletes existing file', () => {
    const filePath = path.join(testStateDir, 'test-delete');
    writeStateFile(filePath, { STATUS: 'test', PR_URL: 'x', BRANCH: 'b' });
    deleteStateFile(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('does not throw on non-existent file', () => {
    expect(() =>
      deleteStateFile(path.join(testStateDir, 'nonexistent')),
    ).not.toThrow();
  });
});

describe('isStateForCurrentWorktree', () => {
  it('returns true for matching branch and fresh file', () => {
    const filePath = path.join(testStateDir, 'test-current');
    writeStateFile(filePath, {
      STATUS: 'needs_review',
      PR_URL: 'test',
      BRANCH: 'my-branch',
    });
    const now = Math.floor(Date.now() / 1000);
    expect(isStateForCurrentWorktree(filePath, now, 'my-branch')).toBe(true);
  });

  it('returns false for different branch', () => {
    const filePath = path.join(testStateDir, 'test-other-branch');
    writeStateFile(filePath, {
      STATUS: 'needs_review',
      PR_URL: 'test',
      BRANCH: 'other-branch',
    });
    const now = Math.floor(Date.now() / 1000);
    expect(isStateForCurrentWorktree(filePath, now, 'my-branch')).toBe(false);
  });

  it('returns false for stale file (>MAX_STATE_AGE)', () => {
    const filePath = path.join(testStateDir, 'test-stale');
    writeStateFile(filePath, {
      STATUS: 'needs_review',
      PR_URL: 'test',
      BRANCH: 'my-branch',
    });
    // Pretend it's 3 hours from now
    const futureTime = Math.floor(Date.now() / 1000) + 10800;
    expect(isStateForCurrentWorktree(filePath, futureTime, 'my-branch')).toBe(
      false,
    );
  });

  it('returns false for legacy file without BRANCH', () => {
    const filePath = path.join(testStateDir, 'test-legacy');
    fs.writeFileSync(filePath, 'STATUS=needs_review\nPR_URL=test\n');
    const now = Math.floor(Date.now() / 1000);
    expect(isStateForCurrentWorktree(filePath, now, 'my-branch')).toBe(false);
  });

  it('returns false for non-existent file', () => {
    expect(
      isStateForCurrentWorktree(
        path.join(testStateDir, 'nope'),
        Date.now() / 1000,
        'x',
      ),
    ).toBe(false);
  });
});

describe('reflection tracking (kaizen #288)', () => {
  it('markReflectionDone creates marker file', () => {
    const prUrl = 'https://github.com/Garsson-io/nanoclaw/pull/42';
    markReflectionDone(prUrl);

    const key = prUrlToStateKey(prUrl);
    const markerPath = path.join(testStateDir, `kaizen-done-${key}`);
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it('isReflectionDone returns true for marked PR', () => {
    const prUrl = 'https://github.com/Garsson-io/nanoclaw/pull/42';
    markReflectionDone(prUrl);
    expect(isReflectionDone(prUrl)).toBe(true);
  });

  it('isReflectionDone returns false for unmarked PR', () => {
    expect(
      isReflectionDone('https://github.com/Garsson-io/nanoclaw/pull/99'),
    ).toBe(false);
  });

  it('isReflectionDone returns false for empty URL', () => {
    expect(isReflectionDone('')).toBe(false);
  });
});
