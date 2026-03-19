import { describe, test, expect, vi } from 'vitest';
import path from 'path';

import { resolveMainStoreDir } from './cli-kaizen.js';

// INVARIANT: initCasesDb resolves the DB path to the main checkout's store/,
// not the worktree's store/, when running from a worktree.
// SUT: resolveMainStoreDir() in cli-kaizen.ts
// VERIFICATION: Call from this worktree and verify path points to main checkout.

describe('resolveMainStoreDir (worktree-aware DB path)', () => {
  test('resolves to main checkout store dir, not worktree store dir', () => {
    const storeDir = resolveMainStoreDir();
    const cwd = process.cwd();

    // We are in a worktree
    expect(cwd).toContain('.claude/worktrees');

    // Store dir should NOT be under the worktree
    expect(storeDir).not.toContain('.claude/worktrees');

    // Should point to main checkout's store/
    expect(storeDir).toBe('/home/aviadr1/projects/nanoclaw/store');
  });

  test('DB file exists at resolved path', () => {
    const storeDir = resolveMainStoreDir();
    const dbPath = path.join(storeDir, 'messages.db');

    const fs = require('fs');
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
