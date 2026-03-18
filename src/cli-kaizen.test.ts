import { describe, test, expect } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

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
