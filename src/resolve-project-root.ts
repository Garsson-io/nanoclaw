/**
 * Resolve the git main checkout root, even when running from a worktree.
 * Uses `git rev-parse --git-common-dir` which returns the shared .git dir
 * for both main checkouts and worktrees.
 */
import { execSync } from 'child_process';
import path from 'path';

/**
 * Returns the absolute path to the main git checkout root.
 * When called from a worktree, returns the parent checkout — not the worktree.
 * When called from the main checkout, returns the same as process.cwd().
 */
export function resolveProjectRoot(): string {
  const commonDir = execSync(
    'git rev-parse --path-format=absolute --git-common-dir',
    { encoding: 'utf-8' },
  ).trim();
  return path.dirname(commonDir);
}
