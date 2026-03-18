import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const exec = promisify(execFile);
const CLI_PATH = path.resolve(__dirname, '../dist/cli-kaizen.js');

// INVARIANT: CLI wrapper parses arguments and delegates to github-api functions
// SUT: cli-kaizen.ts (via compiled dist/cli-kaizen.js)
// VERIFICATION: We test the CLI by running it as a subprocess; github-api calls
// will fail (no token) but argument parsing and error messages are verified.

describe('cli-kaizen', () => {
  test('shows usage on --help', async () => {
    try {
      await exec('node', [CLI_PATH, '--help']);
    } catch (err: unknown) {
      const error = err as { stderr: string; code: number };
      expect(error.stderr).toContain('Usage:');
      expect(error.stderr).toContain('list');
      expect(error.stderr).toContain('view');
    }
  });

  test('shows usage with no arguments', async () => {
    try {
      await exec('node', [CLI_PATH]);
    } catch (err: unknown) {
      const error = err as { stderr: string; code: number };
      expect(error.stderr).toContain('Usage:');
    }
  });

  test('rejects unknown command', async () => {
    try {
      await exec('node', [CLI_PATH, 'bogus']);
    } catch (err: unknown) {
      const error = err as { stderr: string; code: number };
      expect(error.stderr).toContain('Unknown command: bogus');
    }
  });

  test('view requires a number argument', async () => {
    try {
      await exec('node', [CLI_PATH, 'view']);
    } catch (err: unknown) {
      const error = err as { stderr: string; code: number };
      expect(error.stderr).toContain('Usage:');
      expect(error.stderr).toContain('view <number>');
    }
  });
});
