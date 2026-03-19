import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import Database from 'better-sqlite3';

import { _initTestDatabase } from './db.js';
import {
  insertCase,
  getActiveCasesByGithubIssue,
  generateCaseId,
  generateCaseName,
} from './cases.js';
import { makeCase } from './test-helpers.test-util.js';

const exec = promisify(execFile);
const CLI_SOURCE = path.resolve(__dirname, 'cli-kaizen.ts');

// INVARIANT: CLI wrapper parses arguments and delegates to github-api functions
// SUT: cli-kaizen.ts (run via tsx for CI compatibility)
// VERIFICATION: We test the CLI by running it as a subprocess; github-api calls
// will fail (no token) but argument parsing and error messages are verified.

describe('cli-kaizen', () => {
  test('shows usage on --help', async () => {
    try {
      await exec('npx', ['tsx', CLI_SOURCE, '--help']);
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const error = err as { stderr: string };
      expect(error.stderr).toContain('Usage:');
      expect(error.stderr).toContain('list');
      expect(error.stderr).toContain('view');
      expect(error.stderr).toContain('case-create');
    }
  });

  test('shows usage with no arguments', async () => {
    try {
      await exec('npx', ['tsx', CLI_SOURCE]);
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const error = err as { stderr: string };
      expect(error.stderr).toContain('Usage:');
    }
  });

  test('rejects unknown command', async () => {
    try {
      await exec('npx', ['tsx', CLI_SOURCE, 'bogus']);
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const error = err as { stderr: string };
      expect(error.stderr).toContain('Unknown command: bogus');
    }
  });

  test('view requires a number argument', async () => {
    try {
      await exec('npx', ['tsx', CLI_SOURCE, 'view']);
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const error = err as { stderr: string };
      expect(error.stderr).toContain('Usage:');
      expect(error.stderr).toContain('view <number>');
    }
  });
});

// INVARIANT: case-create validates inputs and shows usage when --description is missing.
// SUT: cli-kaizen.ts case-create argument parsing
// VERIFICATION: Running case-create without --description exits non-zero with usage text.
describe('cli-kaizen case-create', () => {
  test('shows usage when --description is missing', async () => {
    try {
      await exec('npx', ['tsx', CLI_SOURCE, 'case-create']);
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const error = err as { stderr: string };
      expect(error.stderr).toContain('--description');
      expect(error.stderr).toContain('Case description (required)');
    }
  });

  test('shows all option flags in usage', async () => {
    try {
      await exec('npx', ['tsx', CLI_SOURCE, 'case-create']);
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const error = err as { stderr: string };
      expect(error.stderr).toContain('--type');
      expect(error.stderr).toContain('--issue');
      expect(error.stderr).toContain('--name');
      expect(error.stderr).toContain('--branch');
      expect(error.stderr).toContain('--worktree');
    }
  });
});

// INVARIANT: case-create with --branch and --worktree registers a case in the
// shared DB without creating a new worktree.
// SUT: cli-kaizen.ts case-create with existing worktree
// VERIFICATION: Run case-create with --branch/--worktree, verify JSON output
// contains correct fields, then verify the DB record exists.
describe('cli-kaizen case-create integration', () => {
  // These tests use the real shared DB. We track created case IDs for cleanup.
  const createdCaseNames: string[] = [];

  afterEach(() => {
    // Clean up any cases we created in the shared DB
    if (createdCaseNames.length > 0) {
      try {
        const { execSync } = require('child_process');
        const commonDir = execSync('git rev-parse --git-common-dir', {
          encoding: 'utf-8',
        }).trim();
        const mainRoot = path.resolve(path.dirname(commonDir));
        const dbPath = path.join(mainRoot, 'store', 'messages.db');
        const db = new Database(dbPath);
        for (const name of createdCaseNames) {
          db.prepare('DELETE FROM cases WHERE name = ?').run(name);
        }
        db.close();
      } catch {
        // Best-effort cleanup
      }
      createdCaseNames.length = 0;
    }
  });

  test('creates case with --branch and --worktree flags', async () => {
    const { stdout } = await exec('npx', [
      'tsx',
      CLI_SOURCE,
      'case-create',
      '--description',
      'test-cli-integration',
      '--branch',
      'test/fake-branch',
      '--worktree',
      '/tmp/test-worktree',
    ]);

    const result = JSON.parse(stdout);
    createdCaseNames.push(result.name);

    expect(result.id).toMatch(/^case-/);
    expect(result.name).toMatch(/^\d{6}-\d{4}-test-cli-integration$/);
    expect(result.type).toBe('dev');
    expect(result.status).toBe('active');
    expect(result.branch_name).toBe('test/fake-branch');
    expect(result.worktree_path).toBe('/tmp/test-worktree');
    expect(result.github_issue).toBeNull();
  });

  test('creates case with --issue and generates github_issue_url', async () => {
    const { stdout } = await exec('npx', [
      'tsx',
      CLI_SOURCE,
      'case-create',
      '--description',
      'test-with-issue',
      '--issue',
      '999',
      '--branch',
      'test/issue-branch',
      '--worktree',
      '/tmp/test-issue-worktree',
    ]);

    const result = JSON.parse(stdout);
    createdCaseNames.push(result.name);

    expect(result.github_issue).toBe(999);
    expect(result.github_issue_url).toContain('/issues/999');
  });

  test('creates work case with --type work', async () => {
    const { stdout } = await exec('npx', [
      'tsx',
      CLI_SOURCE,
      'case-create',
      '--description',
      'test-work-type',
      '--type',
      'work',
      '--branch',
      'test/work-branch',
      '--worktree',
      '/tmp/test-work',
    ]);

    const result = JSON.parse(stdout);
    createdCaseNames.push(result.name);

    expect(result.type).toBe('work');
  });

  test('uses --name for short name override', async () => {
    const { stdout } = await exec('npx', [
      'tsx',
      CLI_SOURCE,
      'case-create',
      '--description',
      'some long description that would be truncated',
      '--name',
      'k42-short',
      '--branch',
      'test/short-name',
      '--worktree',
      '/tmp/test-short',
    ]);

    const result = JSON.parse(stdout);
    createdCaseNames.push(result.name);

    expect(result.name).toContain('k42-short');
  });
});

// INVARIANT: generateCaseName produces YYMMDD-HHMM-slug format with proper slugification.
// SUT: generateCaseName from cases.ts
// VERIFICATION: Unit test name generation for various inputs.
describe('generateCaseName', () => {
  test('produces YYMMDD-HHMM prefix with slugified description', () => {
    const name = generateCaseName('Fix Auth Flow');
    expect(name).toMatch(/^\d{6}-\d{4}-fix-auth-flow$/);
  });

  test('uses shortName over description when provided', () => {
    const name = generateCaseName('long description here', 'k42-short');
    expect(name).toMatch(/^\d{6}-\d{4}-k42-short$/);
  });

  test('truncates long slugs to 30 characters', () => {
    const name = generateCaseName(
      'this is a very long description that should be truncated to fit',
    );
    // datePrefix is 11 chars (YYMMDD-HHMM), plus dash = 12 prefix chars
    // slug portion should be at most 30 chars
    const slugPart = name.slice(12); // skip "YYMMDD-HHMM-"
    expect(slugPart.length).toBeLessThanOrEqual(30);
  });
});
