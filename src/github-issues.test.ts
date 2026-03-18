import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  createGitHubIssue,
  isRepoAllowed,
  filterAllowedLabels,
} from './github-issues.js';

// INVARIANT: Only allowlisted repos can have issues created
// SUT: isRepoAllowed
describe('isRepoAllowed', () => {
  test('allows Garsson-io/kaizen', () => {
    expect(isRepoAllowed('Garsson-io', 'kaizen')).toBe(true);
  });

  test('rejects non-allowlisted repo when no CASE_SYNC_REPO set', () => {
    expect(isRepoAllowed('Garsson-io', 'nanoclaw')).toBe(false);
  });

  test('rejects non-allowlisted org', () => {
    expect(isRepoAllowed('evil-org', 'kaizen')).toBe(false);
  });
});

// INVARIANT: Only allowlisted labels pass through
// SUT: filterAllowedLabels
describe('filterAllowedLabels', () => {
  test('passes allowed labels through', () => {
    expect(filterAllowedLabels(['work-agent', 'needs-dev'])).toEqual([
      'work-agent',
      'needs-dev',
    ]);
  });

  test('filters out disallowed labels', () => {
    expect(
      filterAllowedLabels(['work-agent', 'priority:critical', 'needs-dev']),
    ).toEqual(['work-agent', 'needs-dev']);
  });

  test('returns empty array if no labels allowed', () => {
    expect(filterAllowedLabels(['admin', 'secret'])).toEqual([]);
  });

  test('allows status: and type: prefixed labels for case sync', () => {
    expect(
      filterAllowedLabels([
        'status:active',
        'status:done',
        'type:work',
        'type:dev',
        'admin',
      ]),
    ).toEqual(['status:active', 'status:done', 'type:work', 'type:dev']);
  });
});

// INVARIANT: createGitHubIssue enforces allowlist and handles API errors
// SUT: createGitHubIssue
describe('createGitHubIssue', () => {
  const originalToken = process.env.GITHUB_TOKEN;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
  });

  afterEach(() => {
    if (originalToken !== undefined) {
      process.env.GITHUB_TOKEN = originalToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
    globalThis.fetch = originalFetch;
  });

  test('returns error when GITHUB_TOKEN is not set', async () => {
    delete process.env.GITHUB_TOKEN;

    const result = await createGitHubIssue({
      owner: 'Garsson-io',
      repo: 'kaizen',
      title: 'test',
      body: 'test body',
      labels: ['work-agent'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('GITHUB_TOKEN not configured');
  });

  test('rejects disallowed repo', async () => {
    const result = await createGitHubIssue({
      owner: 'evil-org',
      repo: 'evil-repo',
      title: 'test',
      body: 'test body',
      labels: ['work-agent'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not in the allowed list');
  });

  test('creates issue successfully and returns URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          html_url: 'https://github.com/Garsson-io/kaizen/issues/42',
          number: 42,
        }),
    });

    const result = await createGitHubIssue({
      owner: 'Garsson-io',
      repo: 'kaizen',
      title: 'Agent needs help',
      body: 'Detailed description',
      labels: ['work-agent', 'needs-dev', 'priority:critical'],
    });

    expect(result.success).toBe(true);
    expect(result.issueUrl).toBe(
      'https://github.com/Garsson-io/kaizen/issues/42',
    );
    expect(result.issueNumber).toBe(42);

    // Verify fetch was called with filtered labels (no priority:critical)
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.labels).toEqual(['work-agent', 'needs-dev']);
    expect(body.labels).not.toContain('priority:critical');
  });

  test('handles GitHub API error response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('Validation failed'),
    });

    const result = await createGitHubIssue({
      owner: 'Garsson-io',
      repo: 'kaizen',
      title: 'test',
      body: 'test',
      labels: ['work-agent'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('422');
  });

  test('handles network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await createGitHubIssue({
      owner: 'Garsson-io',
      repo: 'kaizen',
      title: 'test',
      body: 'test',
      labels: ['work-agent'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  test('sends correct Authorization header', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          html_url: 'https://github.com/Garsson-io/kaizen/issues/1',
          number: 1,
        }),
    });

    await createGitHubIssue({
      owner: 'Garsson-io',
      repo: 'kaizen',
      title: 'test',
      body: 'test',
      labels: [],
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(fetchCall[1].headers.Authorization).toBe('Bearer test-token');
  });
});
