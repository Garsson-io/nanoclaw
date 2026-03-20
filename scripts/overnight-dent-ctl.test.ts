/**
 * Tests for overnight-dent-ctl halt/status operations.
 *
 * INVARIANT: discoverBatches must find all batches with state.json,
 * correctly classify active vs stopped, and detect halt files.
 * formatBatchStatus and formatLastState must include all last_* fields
 * present in state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  discoverBatches,
  formatBatchStatus,
  formatLastState,
  haltBatch,
} from './overnight-dent-ctl.js';
import type { BatchState } from './overnight-dent-run.js';

function makeBatchState(overrides: Partial<BatchState> = {}): BatchState {
  return {
    batch_id: 'batch-260321-0136-a1b2',
    batch_start: 1742515200,
    guidance: 'test guidance',
    max_runs: 5,
    cooldown: 30,
    budget: '5.00',
    max_failures: 3,
    run: 2,
    prs: ['https://github.com/Garsson-io/nanoclaw/pull/237'],
    issues_filed: ['https://github.com/Garsson-io/kaizen/issues/42'],
    issues_closed: ['#42'],
    cases: ['260321-0136-k42-fix-hooks'],
    consecutive_failures: 0,
    current_cooldown: 30,
    stop_reason: '',
    last_issue: 'https://github.com/Garsson-io/kaizen/issues/42',
    last_pr: 'https://github.com/Garsson-io/nanoclaw/pull/237',
    last_case: '260321-0136-k42-fix-hooks',
    last_branch: 'case/260321-0136-k42-fix-hooks',
    last_worktree: '.claude/worktrees/260321-0136-k42-fix-hooks',
    ...overrides,
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'overnight-dent-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('discoverBatches', () => {
  it('finds batches with state.json', () => {
    const batchDir = join(tempDir, 'batch-260321-0136-a1b2');
    mkdirSync(batchDir, { recursive: true });
    writeFileSync(
      join(batchDir, 'state.json'),
      JSON.stringify(makeBatchState()),
    );

    const batches = discoverBatches(tempDir);
    expect(batches).toHaveLength(1);
    expect(batches[0].batchId).toBe('batch-260321-0136-a1b2');
  });

  it('classifies active batches (no stop_reason, no batch_end)', () => {
    const batchDir = join(tempDir, 'batch-active');
    mkdirSync(batchDir);
    writeFileSync(
      join(batchDir, 'state.json'),
      JSON.stringify(makeBatchState({ stop_reason: '' })),
    );

    const batches = discoverBatches(tempDir);
    expect(batches[0].active).toBe(true);
  });

  it('classifies stopped batches (has stop_reason)', () => {
    const batchDir = join(tempDir, 'batch-stopped');
    mkdirSync(batchDir);
    writeFileSync(
      join(batchDir, 'state.json'),
      JSON.stringify(makeBatchState({ stop_reason: 'max runs reached' })),
    );

    const batches = discoverBatches(tempDir);
    expect(batches[0].active).toBe(false);
  });

  it('classifies stopped batches (has batch_end)', () => {
    const batchDir = join(tempDir, 'batch-ended');
    mkdirSync(batchDir);
    writeFileSync(
      join(batchDir, 'state.json'),
      JSON.stringify(
        makeBatchState({ batch_end: 1742515500, stop_reason: '' }),
      ),
    );

    const batches = discoverBatches(tempDir);
    expect(batches[0].active).toBe(false);
  });

  it('detects halt files', () => {
    const batchDir = join(tempDir, 'batch-halted');
    mkdirSync(batchDir);
    writeFileSync(
      join(batchDir, 'state.json'),
      JSON.stringify(makeBatchState()),
    );
    writeFileSync(join(batchDir, 'HALT'), 'halted');

    const batches = discoverBatches(tempDir);
    expect(batches[0].halted).toBe(true);
  });

  it('returns empty for nonexistent directory', () => {
    const batches = discoverBatches(join(tempDir, 'nonexistent'));
    expect(batches).toEqual([]);
  });

  it('skips directories without state.json', () => {
    mkdirSync(join(tempDir, 'not-a-batch'));
    const batches = discoverBatches(tempDir);
    expect(batches).toEqual([]);
  });

  it('discovers multiple batches', () => {
    for (const id of ['batch-a', 'batch-b', 'batch-c']) {
      const dir = join(tempDir, id);
      mkdirSync(dir);
      writeFileSync(
        join(dir, 'state.json'),
        JSON.stringify(makeBatchState({ batch_id: id })),
      );
    }

    const batches = discoverBatches(tempDir);
    expect(batches).toHaveLength(3);
  });
});

describe('haltBatch', () => {
  it('creates HALT file in batch directory', () => {
    const batchDir = join(tempDir, 'batch-to-halt');
    mkdirSync(batchDir);

    haltBatch(batchDir);

    expect(existsSync(join(batchDir, 'HALT'))).toBe(true);
  });
});

describe('formatBatchStatus', () => {
  it('includes last_* fields when present', () => {
    const batch = discoverBatches(tempDir);
    // Create a batch manually for formatting test
    const batchDir = join(tempDir, 'batch-fmt');
    mkdirSync(batchDir);
    const state = makeBatchState();
    writeFileSync(join(batchDir, 'state.json'), JSON.stringify(state));

    const batches = discoverBatches(tempDir);
    const output = formatBatchStatus(batches[0]);

    expect(output).toContain('Last issue:');
    expect(output).toContain('kaizen/issues/42');
    expect(output).toContain('Last PR:');
    expect(output).toContain('pull/237');
    expect(output).toContain('Last case:');
    expect(output).toContain('260321-0136-k42-fix-hooks');
    expect(output).toContain('Last branch:');
    expect(output).toContain('case/260321-0136-k42-fix-hooks');
    expect(output).toContain('Last worktree:');
  });

  it('omits last_* fields when empty', () => {
    const batchDir = join(tempDir, 'batch-empty');
    mkdirSync(batchDir);
    writeFileSync(
      join(batchDir, 'state.json'),
      JSON.stringify(
        makeBatchState({
          last_issue: '',
          last_pr: '',
          last_case: '',
          last_branch: '',
          last_worktree: '',
        }),
      ),
    );

    const batches = discoverBatches(tempDir);
    const output = formatBatchStatus(batches[0]);

    expect(output).not.toContain('Last issue:');
    expect(output).not.toContain('Last PR:');
    expect(output).not.toContain('Last case:');
  });

  it('shows HALT REQUESTED status when halted', () => {
    const batchDir = join(tempDir, 'batch-halted');
    mkdirSync(batchDir);
    writeFileSync(
      join(batchDir, 'state.json'),
      JSON.stringify(makeBatchState()),
    );
    writeFileSync(join(batchDir, 'HALT'), 'halted');

    const batches = discoverBatches(tempDir);
    const output = formatBatchStatus(batches[0]);
    expect(output).toContain('HALT REQUESTED');
  });

  it('shows RUNNING for active batches', () => {
    const batchDir = join(tempDir, 'batch-running');
    mkdirSync(batchDir);
    writeFileSync(
      join(batchDir, 'state.json'),
      JSON.stringify(makeBatchState()),
    );

    const batches = discoverBatches(tempDir);
    const output = formatBatchStatus(batches[0]);
    expect(output).toContain('RUNNING');
  });
});

describe('formatLastState', () => {
  it('includes all last_* fields in structured output', () => {
    const state = makeBatchState();
    const output = formatLastState(state);

    expect(output).toContain('batch-260321-0136-a1b2');
    expect(output).toContain('Last issue:');
    expect(output).toContain('kaizen/issues/42');
    expect(output).toContain('Last PR:');
    expect(output).toContain('pull/237');
    expect(output).toContain('Last case:');
    expect(output).toContain('260321-0136-k42-fix-hooks');
    expect(output).toContain('Last branch:');
    expect(output).toContain('case/260321-0136-k42-fix-hooks');
    expect(output).toContain('Last worktree:');
    expect(output).toContain('.claude/worktrees/260321-0136-k42-fix-hooks');
  });

  it('shows no-artifacts message when nothing tracked', () => {
    const state = makeBatchState({
      last_issue: '',
      last_pr: '',
      last_case: '',
      last_branch: '',
      last_worktree: '',
    });
    const output = formatLastState(state);

    expect(output).toContain('no artifacts tracked yet');
  });

  it('includes run number', () => {
    const state = makeBatchState({ run: 7 });
    const output = formatLastState(state);
    expect(output).toContain('7');
  });
});
