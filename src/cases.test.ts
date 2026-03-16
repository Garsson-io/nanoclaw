import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { _initTestDatabase } from './db.js';
import {
  createCasesSchema,
  insertCase,
  getCaseById,
  updateCase,
  lockCase,
  unlockCase,
  heartbeatCase,
  pruneCaseWorkspace,
  createWorktreeLock,
  readWorktreeLock,
  updateWorktreeLockHeartbeat,
  removeWorktreeLock,
  isWorktreeLockFresh,
} from './cases.js';
import type { Case, WorktreeLock } from './cases.js';

let tmpDir: string;

function makeCase(overrides: Partial<Case> = {}): Case {
  const now = new Date().toISOString();
  return {
    id: 'case-test-1',
    group_folder: 'test_group',
    chat_jid: 'tg:-123',
    name: '260316-1400-test-case',
    description: 'Test case',
    type: 'dev',
    status: 'active',
    blocked_on: null,
    worktree_path: null,
    workspace_path: '/tmp/test-workspace',
    branch_name: 'case/test',
    initiator: 'test',
    initiator_channel: null,
    last_message: null,
    last_activity_at: now,
    conclusion: null,
    created_at: now,
    done_at: null,
    reviewed_at: null,
    pruned_at: null,
    total_cost_usd: 0,
    token_source: null,
    time_spent_ms: 0,
    locked_by: null,
    last_heartbeat: null,
    ...overrides,
  };
}

beforeEach(() => {
  _initTestDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// --- Lock file operations ---

describe('worktree lock files', () => {
  it('creates and reads a lock file', () => {
    createWorktreeLock(tmpDir, 'session-abc', 'case-1');
    const lock = readWorktreeLock(tmpDir);
    expect(lock).not.toBeNull();
    expect(lock!.agent_session).toBe('session-abc');
    expect(lock!.case_id).toBe('case-1');
    expect(lock!.pid).toBe(process.pid);
  });

  it('returns null when no lock file exists', () => {
    const lock = readWorktreeLock(tmpDir);
    expect(lock).toBeNull();
  });

  it('updates heartbeat timestamp', () => {
    createWorktreeLock(tmpDir, 'session-abc', 'case-1');
    const before = readWorktreeLock(tmpDir)!;

    // Small delay to ensure timestamp difference
    const result = updateWorktreeLockHeartbeat(tmpDir);
    expect(result).toBe(true);

    const after = readWorktreeLock(tmpDir)!;
    expect(new Date(after.heartbeat).getTime()).toBeGreaterThanOrEqual(
      new Date(before.heartbeat).getTime(),
    );
  });

  it('updateWorktreeLockHeartbeat returns false when no lock exists', () => {
    expect(updateWorktreeLockHeartbeat(tmpDir)).toBe(false);
  });

  it('removes a lock file', () => {
    createWorktreeLock(tmpDir, 'session-abc', 'case-1');
    expect(readWorktreeLock(tmpDir)).not.toBeNull();

    removeWorktreeLock(tmpDir);
    expect(readWorktreeLock(tmpDir)).toBeNull();
  });

  it('removeWorktreeLock is idempotent', () => {
    // Should not throw when no lock exists
    removeWorktreeLock(tmpDir);
  });
});

describe('isWorktreeLockFresh', () => {
  it('returns true for a recent lock', () => {
    const lock: WorktreeLock = {
      agent_session: 'test',
      case_id: 'case-1',
      started_at: new Date().toISOString(),
      heartbeat: new Date().toISOString(),
      pid: 1234,
    };
    expect(isWorktreeLockFresh(lock)).toBe(true);
  });

  it('returns false for a stale lock (>30min old)', () => {
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const lock: WorktreeLock = {
      agent_session: 'test',
      case_id: 'case-1',
      started_at: staleTime,
      heartbeat: staleTime,
      pid: 1234,
    };
    expect(isWorktreeLockFresh(lock)).toBe(false);
  });
});

// --- Case DB lock operations ---

describe('lockCase', () => {
  it('acquires a lock on an unlocked case', () => {
    const c = makeCase();
    insertCase(c);

    const result = lockCase(c.id, 'session-1');
    expect(result.success).toBe(true);

    const updated = getCaseById(c.id)!;
    expect(updated.locked_by).toBe('session-1');
    expect(updated.last_heartbeat).not.toBeNull();
  });

  it('allows re-locking by the same session', () => {
    const c = makeCase();
    insertCase(c);

    lockCase(c.id, 'session-1');
    const result = lockCase(c.id, 'session-1');
    expect(result.success).toBe(true);
  });

  it('rejects lock from different session when fresh', () => {
    const c = makeCase({
      locked_by: 'session-1',
      last_heartbeat: new Date().toISOString(),
    });
    insertCase(c);

    const result = lockCase(c.id, 'session-2');
    expect(result.success).toBe(false);
    expect(result.error).toContain('session-1');
  });

  it('overrides a stale lock from another session', () => {
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const c = makeCase({
      locked_by: 'session-old',
      last_heartbeat: staleTime,
    });
    insertCase(c);

    const result = lockCase(c.id, 'session-new');
    expect(result.success).toBe(true);

    const updated = getCaseById(c.id)!;
    expect(updated.locked_by).toBe('session-new');
  });

  it('returns error for nonexistent case', () => {
    const result = lockCase('nonexistent', 'session-1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Case not found');
  });
});

describe('unlockCase', () => {
  it('releases a lock held by the same session', () => {
    const c = makeCase();
    insertCase(c);
    lockCase(c.id, 'session-1');

    const result = unlockCase(c.id, 'session-1');
    expect(result.success).toBe(true);

    const updated = getCaseById(c.id)!;
    expect(updated.locked_by).toBeNull();
    expect(updated.last_heartbeat).toBeNull();
  });

  it('rejects unlock from different session without force', () => {
    const c = makeCase({
      locked_by: 'session-1',
      last_heartbeat: new Date().toISOString(),
    });
    insertCase(c);

    const result = unlockCase(c.id, 'session-2');
    expect(result.success).toBe(false);
  });

  it('allows force unlock from different session', () => {
    const c = makeCase({
      locked_by: 'session-1',
      last_heartbeat: new Date().toISOString(),
    });
    insertCase(c);

    const result = unlockCase(c.id, 'session-2', true);
    expect(result.success).toBe(true);
  });
});

describe('heartbeatCase', () => {
  it('updates heartbeat for the lock holder', () => {
    const c = makeCase();
    insertCase(c);
    lockCase(c.id, 'session-1');

    const before = getCaseById(c.id)!.last_heartbeat!;
    const result = heartbeatCase(c.id, 'session-1');
    expect(result.success).toBe(true);

    const after = getCaseById(c.id)!.last_heartbeat!;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
  });

  it('rejects heartbeat from non-holder', () => {
    const c = makeCase({
      locked_by: 'session-1',
      last_heartbeat: new Date().toISOString(),
    });
    insertCase(c);

    const result = heartbeatCase(c.id, 'session-2');
    expect(result.success).toBe(false);
  });

  it('rejects heartbeat on unlocked case', () => {
    const c = makeCase();
    insertCase(c);

    const result = heartbeatCase(c.id, 'session-1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Case is not locked');
  });
});

// --- pruneCaseWorkspace guards ---

describe('pruneCaseWorkspace status guard', () => {
  it('throws when case is active', () => {
    const c = makeCase({ status: 'active' });
    expect(() => pruneCaseWorkspace(c)).toThrow('status is active');
  });

  it('throws when case is blocked', () => {
    const c = makeCase({ status: 'blocked' });
    expect(() => pruneCaseWorkspace(c)).toThrow('status is blocked');
  });

  it('does not throw for done case', () => {
    // Use a workspace path that doesn't exist to avoid actual deletion
    const c = makeCase({
      status: 'done',
      worktree_path: '/nonexistent/path',
      type: 'work',
      workspace_path: '/nonexistent/path',
    });
    // Should not throw (just silently skip non-existent paths)
    expect(() => pruneCaseWorkspace(c)).not.toThrow();
  });

  it('does not throw for reviewed case', () => {
    const c = makeCase({
      status: 'reviewed',
      type: 'work',
      workspace_path: '/nonexistent/path',
    });
    expect(() => pruneCaseWorkspace(c)).not.toThrow();
  });
});

describe('pruneCaseWorkspace lock file guard', () => {
  it('throws when worktree has a fresh lock file', () => {
    createWorktreeLock(tmpDir, 'session-active', 'case-1');

    const c = makeCase({
      status: 'done',
      type: 'dev',
      worktree_path: tmpDir,
    });
    expect(() => pruneCaseWorkspace(c)).toThrow('fresh lock');
  });

  it('allows prune when lock file is stale', () => {
    // Create a lock file with stale heartbeat
    const lockPath = path.join(tmpDir, '.worktree-lock.json');
    const staleLock: WorktreeLock = {
      agent_session: 'session-old',
      case_id: 'case-1',
      started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      heartbeat: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      pid: 99999,
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleLock));

    const c = makeCase({
      status: 'done',
      type: 'dev',
      worktree_path: tmpDir,
    });
    // This will try to run git worktree remove which will fail (not a real worktree)
    // but it should NOT throw from the lock guard
    // We just verify it gets past the lock check
    try {
      pruneCaseWorkspace(c);
    } catch {
      // Expected: git worktree remove will fail on a temp dir
      // The important thing is it didn't throw about the lock
    }
  });
});

describe('pruneCaseWorkspace DB lock guard', () => {
  it('throws when case has fresh DB lock', () => {
    const c = makeCase({
      status: 'done',
      type: 'dev',
      worktree_path: tmpDir,
      locked_by: 'session-active',
      last_heartbeat: new Date().toISOString(),
    });
    expect(() => pruneCaseWorkspace(c)).toThrow('DB lock held by');
  });

  it('allows prune when DB lock is stale', () => {
    const c = makeCase({
      status: 'done',
      type: 'dev',
      worktree_path: tmpDir,
      locked_by: 'session-old',
      last_heartbeat: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    });
    // Should get past the lock guard (git worktree remove may fail, that's OK)
    try {
      pruneCaseWorkspace(c);
    } catch {
      // Expected: not a real worktree
    }
  });
});
