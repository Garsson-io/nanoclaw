/**
 * Tests for overnight-dent-run stream-json parsing and stop signal detection.
 *
 * INVARIANT: extractArtifacts must find all PR URLs, issue URLs, closed issues,
 * and case names in text without false positives. checkStopSignal must detect
 * the OVERNIGHT_STOP marker and extract the reason.
 */
import { describe, it, expect } from 'vitest';
import {
  extractArtifacts,
  checkStopSignal,
  formatToolUse,
  processStreamMessage,
  type RunResult,
} from './overnight-dent-run.js';

function emptyResult(): RunResult {
  return {
    prs: [],
    issuesFiled: [],
    issuesClosed: [],
    cases: [],
    cost: 0,
    toolCalls: 0,
    stopRequested: false,
  };
}

describe('extractArtifacts', () => {
  it('extracts PR URLs', () => {
    const r = emptyResult();
    extractArtifacts(
      'Created https://github.com/Garsson-io/nanoclaw/pull/234 for the fix',
      r,
    );
    expect(r.prs).toEqual(['https://github.com/Garsson-io/nanoclaw/pull/234']);
  });

  it('extracts issue URLs', () => {
    const r = emptyResult();
    extractArtifacts(
      'Filed https://github.com/Garsson-io/kaizen/issues/267',
      r,
    );
    expect(r.issuesFiled).toEqual([
      'https://github.com/Garsson-io/kaizen/issues/267',
    ]);
  });

  it('extracts closed issue references', () => {
    const r = emptyResult();
    extractArtifacts('Closes #251, fixes #253, Resolves #258', r);
    expect(r.issuesClosed).toEqual(['#251', '#253', '#258']);
  });

  it('extracts case names', () => {
    const r = emptyResult();
    extractArtifacts('case: 260315-1430-fix-auth', r);
    expect(r.cases).toEqual(['260315-1430-fix-auth']);
  });

  it('deduplicates artifacts', () => {
    const r = emptyResult();
    extractArtifacts('PR: https://github.com/Garsson-io/nanoclaw/pull/234', r);
    extractArtifacts(
      'Same PR: https://github.com/Garsson-io/nanoclaw/pull/234',
      r,
    );
    expect(r.prs).toHaveLength(1);
  });

  it('handles text with no artifacts', () => {
    const r = emptyResult();
    extractArtifacts('Just some regular text with no URLs', r);
    expect(r.prs).toEqual([]);
    expect(r.issuesFiled).toEqual([]);
    expect(r.issuesClosed).toEqual([]);
    expect(r.cases).toEqual([]);
  });
});

describe('checkStopSignal', () => {
  it('detects OVERNIGHT_STOP marker', () => {
    const r = emptyResult();
    checkStopSignal(
      'OVERNIGHT_STOP: backlog exhausted — no more matching issues',
      r,
    );
    expect(r.stopRequested).toBe(true);
    expect(r.stopReason).toBe('backlog exhausted — no more matching issues');
  });

  it('ignores text without the marker', () => {
    const r = emptyResult();
    checkStopSignal('Run completed successfully', r);
    expect(r.stopRequested).toBe(false);
  });

  it('handles marker with extra whitespace', () => {
    const r = emptyResult();
    checkStopSignal('OVERNIGHT_STOP:   all issues claimed  ', r);
    expect(r.stopRequested).toBe(true);
    expect(r.stopReason).toBe('all issues claimed');
  });
});

describe('formatToolUse', () => {
  it('formats Read tool', () => {
    expect(formatToolUse('Read', { file_path: '/src/index.ts' })).toBe(
      'Read /src/index.ts',
    );
  });

  it('formats Bash tool', () => {
    expect(formatToolUse('Bash', { command: 'npm test' })).toBe('$ npm test');
  });

  it('formats Skill tool', () => {
    expect(formatToolUse('Skill', { skill_name: 'make-a-dent' })).toBe(
      'Skill /make-a-dent',
    );
  });

  it('formats unknown tools by name', () => {
    expect(formatToolUse('WebSearch', {})).toBe('WebSearch');
  });

  it('truncates long paths', () => {
    const longPath = '/a'.repeat(100);
    const result = formatToolUse('Read', { file_path: longPath });
    expect(result.length).toBeLessThanOrEqual(65); // "Read " + 60 chars
  });
});

describe('processStreamMessage', () => {
  it('counts tool calls from assistant messages', () => {
    const r = emptyResult();
    processStreamMessage(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/test' } },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
          ],
        },
      },
      r,
      Date.now(),
    );
    expect(r.toolCalls).toBe(2);
  });

  it('extracts cost from result message', () => {
    const r = emptyResult();
    processStreamMessage(
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 2.14,
        result: 'Done!',
      },
      r,
      Date.now(),
    );
    expect(r.cost).toBe(2.14);
  });

  it('detects stop signal in result message', () => {
    const r = emptyResult();
    processStreamMessage(
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 1.0,
        result: 'OVERNIGHT_STOP: no more work',
      },
      r,
      Date.now(),
    );
    expect(r.stopRequested).toBe(true);
    expect(r.stopReason).toBe('no more work');
  });

  it('extracts artifacts from assistant text blocks', () => {
    const r = emptyResult();
    processStreamMessage(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Created https://github.com/Garsson-io/nanoclaw/pull/99',
            },
          ],
        },
      },
      r,
      Date.now(),
    );
    expect(r.prs).toEqual(['https://github.com/Garsson-io/nanoclaw/pull/99']);
  });
});
