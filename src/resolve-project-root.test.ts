import { describe, test, expect } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { resolveProjectRoot } from './resolve-project-root.js';

// INVARIANT: resolveProjectRoot() returns the main checkout root regardless of cwd.
// SUT: resolveProjectRoot()
// VERIFICATION: Verify it returns a valid git root with expected structure.

const isWorktree = process.cwd().includes('.claude/worktrees');

describe('resolveProjectRoot', () => {
  test('returns a directory that is a git root', () => {
    const root = resolveProjectRoot();

    // The resolved root should contain a .git entry (file or dir)
    expect(fs.existsSync(path.join(root, '.git'))).toBe(true);
  });

  test('returns a directory containing package.json', () => {
    const root = resolveProjectRoot();

    // Main checkout has package.json at root
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true);
  });

  test('returns main checkout root, not worktree, when in a worktree', () => {
    if (!isWorktree) {
      // In the main checkout, resolveProjectRoot should equal cwd
      expect(resolveProjectRoot()).toBe(process.cwd());
      return;
    }

    const root = resolveProjectRoot();
    const cwd = process.cwd();

    // resolveProjectRoot should NOT return the worktree path
    expect(root).not.toContain('.claude/worktrees');
    // But cwd IS a worktree
    expect(cwd).toContain('.claude/worktrees');
    // The worktree should be under the resolved root
    expect(cwd).toContain(root);
  });

  test('returns consistent results across calls', () => {
    const root1 = resolveProjectRoot();
    const root2 = resolveProjectRoot();
    expect(root1).toBe(root2);
  });
});
