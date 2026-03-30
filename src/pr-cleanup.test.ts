import { describe, it, expect, vi } from 'vitest';

import {
  extractKaizenRefs,
  runPrCleanup,
  type PrCleanupDeps,
  type PullRequest,
} from './pr-cleanup.js';

describe('extractKaizenRefs', () => {
  it('extracts Garsson-io/kaizen#NNN references', () => {
    const body = 'Closes Garsson-io/kaizen#123 and Garsson-io/kaizen#456';
    expect(extractKaizenRefs(body)).toEqual([123, 456]);
  });

  it('extracts kaizen #NNN references with space', () => {
    const body = 'Fix for kaizen #42';
    expect(extractKaizenRefs(body)).toEqual([42]);
  });

  it('extracts kaizen#NNN references without space', () => {
    const body = 'Related to kaizen#99';
    expect(extractKaizenRefs(body)).toEqual([99]);
  });

  it('extracts parenthesized references like (kaizen #NNN)', () => {
    const body = 'Some fix (kaizen #55)';
    expect(extractKaizenRefs(body)).toEqual([55]);
  });

  it('deduplicates references', () => {
    const body =
      'Closes Garsson-io/kaizen#10\nRelated: kaizen #10\nSee kaizen#10';
    expect(extractKaizenRefs(body)).toEqual([10]);
  });

  it('returns sorted results', () => {
    const body = 'kaizen #300, kaizen #100, kaizen #200';
    expect(extractKaizenRefs(body)).toEqual([100, 200, 300]);
  });

  it('returns empty array for null body', () => {
    expect(extractKaizenRefs(null)).toEqual([]);
  });

  it('returns empty array when no references found', () => {
    expect(extractKaizenRefs('Just a regular PR body')).toEqual([]);
  });

  it('is case-insensitive', () => {
    const body = 'KAIZEN #5 and Kaizen #10';
    expect(extractKaizenRefs(body)).toEqual([5, 10]);
  });
});

describe('runPrCleanup', () => {
  function makePR(
    number: number,
    body: string,
    title = `PR #${number}`,
  ): PullRequest {
    return {
      number,
      title,
      body,
      html_url: `https://github.com/Garsson-io/nanoclaw/pull/${number}`,
      head: { ref: `fix/branch-${number}` },
    };
  }

  function makeDeps(overrides?: Partial<PrCleanupDeps>): PrCleanupDeps {
    return {
      listOpenPRs: vi.fn().mockResolvedValue([]),
      getIssueState: vi.fn().mockResolvedValue({ number: 1, state: 'open' }),
      closePR: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('returns empty when no open PRs', async () => {
    const deps = makeDeps();
    const results = await runPrCleanup('Garsson-io', 'nanoclaw', deps);
    expect(results).toEqual([]);
  });

  it('skips PRs without kaizen references', async () => {
    const deps = makeDeps({
      listOpenPRs: vi.fn().mockResolvedValue([makePR(1, 'Just a regular PR')]),
    });
    const results = await runPrCleanup('Garsson-io', 'nanoclaw', deps);
    expect(results).toEqual([]);
    expect(deps.getIssueState).not.toHaveBeenCalled();
  });

  it('closes PR when all referenced issues are closed', async () => {
    const deps = makeDeps({
      listOpenPRs: vi
        .fn()
        .mockResolvedValue([makePR(10, 'Closes Garsson-io/kaizen#42')]),
      getIssueState: vi.fn().mockResolvedValue({ number: 42, state: 'closed' }),
    });

    const results = await runPrCleanup('Garsson-io', 'nanoclaw', deps);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      prNumber: 10,
      referencedIssues: [42],
      closedIssues: [42],
      action: 'closed',
      reason: 'all referenced kaizen issues are closed',
    });
    expect(deps.closePR).toHaveBeenCalledWith(
      'Garsson-io',
      'nanoclaw',
      10,
      expect.stringContaining('kaizen#42'),
    );
  });

  it('does not close PR when some issues are still open', async () => {
    const deps = makeDeps({
      listOpenPRs: vi
        .fn()
        .mockResolvedValue([
          makePR(20, 'Closes Garsson-io/kaizen#10\nAlso kaizen #11'),
        ]),
      getIssueState: vi.fn().mockImplementation((_o, _r, num) =>
        Promise.resolve({
          number: num,
          state: num === 10 ? 'closed' : 'open',
        }),
      ),
    });

    const results = await runPrCleanup('Garsson-io', 'nanoclaw', deps);
    expect(results).toEqual([]);
    expect(deps.closePR).not.toHaveBeenCalled();
  });

  it('respects dry-run mode', async () => {
    const deps = makeDeps({
      listOpenPRs: vi.fn().mockResolvedValue([makePR(30, 'kaizen #99')]),
      getIssueState: vi.fn().mockResolvedValue({ number: 99, state: 'closed' }),
    });

    const results = await runPrCleanup('Garsson-io', 'nanoclaw', deps, true);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('skipped');
    expect(deps.closePR).not.toHaveBeenCalled();
  });

  it('caches issue state across PRs', async () => {
    const deps = makeDeps({
      listOpenPRs: vi
        .fn()
        .mockResolvedValue([
          makePR(40, 'kaizen #50'),
          makePR(41, 'kaizen #50'),
        ]),
      getIssueState: vi.fn().mockResolvedValue({ number: 50, state: 'closed' }),
    });

    const results = await runPrCleanup('Garsson-io', 'nanoclaw', deps);
    expect(results).toHaveLength(2);
    // Issue #50 should only be fetched once
    expect(deps.getIssueState).toHaveBeenCalledTimes(1);
  });

  it('handles multiple PRs with mixed outcomes', async () => {
    const deps = makeDeps({
      listOpenPRs: vi.fn().mockResolvedValue([
        makePR(1, 'kaizen #100'), // issue closed -> close PR
        makePR(2, 'kaizen #200'), // issue open -> skip
        makePR(3, 'No refs'), // no refs -> skip
        makePR(4, 'kaizen #100 and kaizen #200'), // mixed -> skip
      ]),
      getIssueState: vi.fn().mockImplementation((_o, _r, num) =>
        Promise.resolve({
          number: num,
          state: num === 100 ? 'closed' : 'open',
        }),
      ),
    });

    const results = await runPrCleanup('Garsson-io', 'nanoclaw', deps);

    // Only PR #1 should be closed (all its refs are closed)
    expect(results).toHaveLength(1);
    expect(results[0].prNumber).toBe(1);
    expect(deps.closePR).toHaveBeenCalledTimes(1);
  });
});
