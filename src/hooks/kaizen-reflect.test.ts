/**
 * Integration tests for kaizen-reflect.ts — the TypeScript port.
 *
 * Tests mirror and exceed bash tests in tests/test-kaizen-reflect.sh.
 *
 * Parity checklist vs bash tests:
 * [x] gh pr create: state file is written
 * [x] gh pr create: output includes kaizen-bg subagent instruction
 * [x] gh pr create: output includes structured impediment format
 * [x] gh pr merge: output includes kaizen-bg subagent instruction
 * [x] Non-PR commands: no output
 * [x] Failed commands: no output
 *
 * NEW tests beyond bash:
 * [x] Reflection-done marker prevents duplicate gates (kaizen #288)
 * [x] Empty PR URL exits silently
 * [x] Merge output includes post-merge steps
 * [x] Gate state file has correct STATUS and BRANCH
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let testStateDir: string;
const HOOK_PATH = path.resolve(__dirname, 'kaizen-reflect.ts');

beforeEach(() => {
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-reflect-test-'));
});

afterEach(() => {
  fs.rmSync(testStateDir, { recursive: true, force: true });
});

function runHook(input: object): string {
  const json = JSON.stringify(input);
  try {
    return execSync(
      `echo '${json.replace(/'/g, "'\\''")}' | npx tsx "${HOOK_PATH}"`,
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          STATE_DIR: testStateDir,
          // Prevent real Telegram notifications in tests
          IPC_DIR: path.join(testStateDir, 'ipc'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      },
    ).trim();
  } catch (err: any) {
    return err.stdout?.trim?.() ?? '';
  }
}

function prCreateInput(prUrl: string): object {
  return {
    tool_input: { command: `gh pr create --title 'test' --body 'test'` },
    tool_response: { stdout: prUrl, stderr: '', exit_code: '0' },
  };
}

function prMergeInput(prUrl: string): object {
  return {
    tool_input: {
      command: `gh pr merge ${prUrl} --squash --delete-branch --auto`,
    },
    tool_response: {
      stdout: '\u2713 Pull request merged',
      stderr: '',
      exit_code: '0',
    },
  };
}

function hasKaizenState(): boolean {
  return fs.readdirSync(testStateDir).some((f) => f.startsWith('pr-kaizen-'));
}

function getKaizenState(): Record<string, string> {
  const files = fs
    .readdirSync(testStateDir)
    .filter((f) => f.startsWith('pr-kaizen-'));
  if (files.length === 0) return {};
  const content = fs.readFileSync(path.join(testStateDir, files[0]), 'utf-8');
  const state: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) state[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return state;
}

describe('kaizen-reflect: gh pr create', () => {
  it('creates state file with needs_pr_kaizen status', () => {
    runHook(prCreateInput('https://github.com/Garsson-io/nanoclaw/pull/42'));
    expect(hasKaizenState()).toBe(true);

    const state = getKaizenState();
    expect(state.STATUS).toBe('needs_pr_kaizen');
    expect(state.PR_URL).toBe('https://github.com/Garsson-io/nanoclaw/pull/42');
    expect(state.BRANCH).toBeTruthy();
  });

  it('output includes kaizen-bg subagent instruction', () => {
    const output = runHook(
      prCreateInput('https://github.com/Garsson-io/nanoclaw/pull/42'),
    );
    expect(output).toContain('kaizen-bg');
    expect(output).toContain('background');
    expect(output).toContain('Agent');
    expect(output).toContain('run_in_background');
    expect(output).toContain('pull/42');
  });

  it('output includes KAIZEN_IMPEDIMENTS format', () => {
    const output = runHook(
      prCreateInput('https://github.com/Garsson-io/nanoclaw/pull/42'),
    );
    expect(output).toContain('KAIZEN_IMPEDIMENTS');
  });

  it('output mentions waiver quality enforcement', () => {
    const output = runHook(
      prCreateInput('https://github.com/Garsson-io/nanoclaw/pull/42'),
    );
    expect(output).toContain('kaizen #280');
    expect(output).toContain('blocklisted');
  });

  it('output mentions KAIZEN_NO_ACTION option', () => {
    const output = runHook(
      prCreateInput('https://github.com/Garsson-io/nanoclaw/pull/42'),
    );
    expect(output).toContain('KAIZEN_NO_ACTION');
    expect(output).toContain('docs-only');
  });
});

describe('kaizen-reflect: gh pr merge', () => {
  it('creates state file on merge', () => {
    runHook(prMergeInput('https://github.com/Garsson-io/nanoclaw/pull/42'));
    expect(hasKaizenState()).toBe(true);
  });

  it('output includes kaizen-bg subagent instruction', () => {
    const output = runHook(
      prMergeInput('https://github.com/Garsson-io/nanoclaw/pull/42'),
    );
    expect(output).toContain('kaizen-bg');
    expect(output).toContain('background');
  });

  it('output includes post-merge steps', () => {
    const output = runHook(
      prMergeInput('https://github.com/Garsson-io/nanoclaw/pull/42'),
    );
    expect(output).toContain('post-merge');
    expect(output).toContain('Sync main');
  });
});

describe('kaizen-reflect: non-triggers', () => {
  it('exits silently for non-PR commands', () => {
    const output = runHook({
      tool_input: { command: 'npm run build' },
      tool_response: { stdout: 'done', stderr: '', exit_code: '0' },
    });
    expect(output).toBe('');
    expect(hasKaizenState()).toBe(false);
  });

  it('exits silently for failed commands', () => {
    const output = runHook({
      tool_input: { command: 'gh pr create --title test' },
      tool_response: { stdout: '', stderr: 'error', exit_code: '1' },
    });
    expect(output).toBe('');
  });

  it('exits silently when PR URL cannot be extracted', () => {
    const output = runHook({
      tool_input: { command: 'gh pr create' },
      tool_response: {
        stdout: 'no url here',
        stderr: '',
        exit_code: '0',
      },
    });
    expect(output).toBe('');
  });
});

describe('kaizen-reflect: duplicate gate prevention (kaizen #288)', () => {
  it('skips gate when reflection already done', () => {
    const prUrl = 'https://github.com/Garsson-io/nanoclaw/pull/42';

    // Simulate reflection-done marker
    const key = prUrl
      .replace('https://github.com/', '')
      .replace('/pull/', '_')
      .replace(/\//g, '_');
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    fs.writeFileSync(
      path.join(testStateDir, `kaizen-done-${key}`),
      `PR_URL=${prUrl}\nSTATUS=kaizen_done\nBRANCH=${branch}\n`,
    );

    const output = runHook(prCreateInput(prUrl));
    expect(output).toBe('');
    // No new gate state should be created
    const kaizenFiles = fs
      .readdirSync(testStateDir)
      .filter((f) => f.startsWith('pr-kaizen-'));
    expect(kaizenFiles.length).toBe(0);
  });
});
