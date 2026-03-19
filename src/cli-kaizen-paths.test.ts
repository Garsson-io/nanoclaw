import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { resolveMainStoreDir } from './cli-kaizen.js';
import { resolveProjectRoot } from './resolve-project-root.js';

// INVARIANT: initCasesDb resolves the DB path to the main checkout's store/,
// not the worktree's store/, when running from a worktree.
// SUT: resolveMainStoreDir() in cli-kaizen.ts
// VERIFICATION: Call and verify path points to main checkout's store/.

const isWorktree = process.cwd().includes('.claude/worktrees');

describe('resolveMainStoreDir (worktree-aware DB path)', () => {
  test('resolves to main checkout store dir', () => {
    const storeDir = resolveMainStoreDir();
    const expectedRoot = resolveProjectRoot();

    // Store dir should be under the main checkout root
    expect(storeDir).toBe(path.join(expectedRoot, 'store'));
  });

  test('store dir is NOT under worktree when running from worktree', () => {
    if (!isWorktree) return; // Only meaningful from a worktree

    const storeDir = resolveMainStoreDir();

    // Store dir should NOT be under the worktree
    expect(storeDir).not.toContain('.claude/worktrees');
  });

  test('store dir exists and contains messages.db', () => {
    const storeDir = resolveMainStoreDir();

    // The store directory should exist (main checkout always has it)
    expect(fs.existsSync(storeDir)).toBe(true);
    expect(fs.existsSync(path.join(storeDir, 'messages.db'))).toBe(true);
  });
});
