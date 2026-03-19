import { describe, test, expect, vi } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';

import { resolveProjectRoot } from './resolve-project-root.js';

// INVARIANT: resolveProjectRoot() returns the main checkout root regardless of cwd.
// SUT: resolveProjectRoot()
// VERIFICATION: Call from this worktree, verify it returns the main checkout path.

describe('resolveProjectRoot', () => {
  test('returns main checkout root when called from a worktree', () => {
    // We ARE in a worktree right now — this is a real integration test
    const root = resolveProjectRoot();
    const cwd = process.cwd();

    // cwd is a worktree path like .../nanoclaw/.claude/worktrees/260319-...
    expect(cwd).toContain('.claude/worktrees');

    // resolveProjectRoot should return the main checkout, NOT the worktree
    expect(root).not.toContain('.claude/worktrees');
    expect(root).toBe('/home/aviadr1/projects/nanoclaw');
  });

  test('returns path that contains store/messages.db', () => {
    const root = resolveProjectRoot();
    const dbPath = path.join(root, 'store', 'messages.db');

    // The main checkout's DB should exist
    const fs = require('fs');
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  test('returns path that contains .claude/worktrees/', () => {
    const root = resolveProjectRoot();
    const worktreesDir = path.join(root, '.claude', 'worktrees');

    const fs = require('fs');
    expect(fs.existsSync(worktreesDir)).toBe(true);
  });
});
