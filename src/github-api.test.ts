import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  createGitHubIssue,
  listGitHubIssues,
  getGitHubIssue,
  isRepoAllowed,
  filterAllowedLabels,
} from './github-api.js';

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

// INVARIANT: listGitHubIssues returns issues from allowed repos with correct filtering
// SUT: listGitHubIssues
describe('listGitHubIssues', () => {
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

    const result = await listGitHubIssues({
      owner: 'Garsson-io',
      repo: 'kaizen',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('GITHUB_TOKEN not configured');
  });

  test('rejects disallowed repo', async () => {
    const result = await listGitHubIssues({
      owner: 'evil-org',
      repo: 'evil-repo',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not in the allowed list');
  });

  test('lists issues successfully with defaults', async () => {
    const mockIssues = [
      {
        number: 1,
        title: 'Issue one',
        body: 'Body one',
        state: 'open',
        labels: [{ name: 'kaizen' }],
        html_url: 'https://github.com/Garsson-io/kaizen/issues/1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        closed_at: null,
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockIssues),
    });

    const result = await listGitHubIssues({
      owner: 'Garsson-io',
      repo: 'kaizen',
    });

    expect(result.success).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues![0].number).toBe(1);

    // Verify default query params
    const fetchUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(fetchUrl).toContain('state=open');
    expect(fetchUrl).toContain('per_page=100');
  });

  test('passes labels and limit as query params', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await listGitHubIssues({
      owner: 'Garsson-io',
      repo: 'kaizen',
      state: 'closed',
      labels: ['kaizen', 'epic'],
      limit: 10,
    });

    const fetchUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(fetchUrl).toContain('state=closed');
    expect(fetchUrl).toContain('per_page=10');
    expect(fetchUrl).toContain('labels=kaizen%2Cepic');
  });

  test('clamps limit to 100', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await listGitHubIssues({
      owner: 'Garsson-io',
      repo: 'kaizen',
      limit: 500,
    });

    const fetchUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(fetchUrl).toContain('per_page=100');
  });

  test('handles GitHub API error response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Rate limited'),
    });

    const result = await listGitHubIssues({
      owner: 'Garsson-io',
      repo: 'kaizen',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('403');
  });

  test('handles network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await listGitHubIssues({
      owner: 'Garsson-io',
      repo: 'kaizen',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });
});

// INVARIANT: getGitHubIssue returns a single issue from allowed repos
// SUT: getGitHubIssue
describe('getGitHubIssue', () => {
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

    const result = await getGitHubIssue({
      owner: 'Garsson-io',
      repo: 'kaizen',
      issueNumber: 97,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('GITHUB_TOKEN not configured');
  });

  test('rejects disallowed repo', async () => {
    const result = await getGitHubIssue({
      owner: 'evil-org',
      repo: 'evil-repo',
      issueNumber: 1,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not in the allowed list');
  });

  test('returns issue successfully', async () => {
    const mockIssue = {
      number: 97,
      title: '[Epic] Unify kaizen issues under cases',
      body: 'Epic body',
      state: 'open',
      labels: [{ name: 'kaizen' }, { name: 'epic' }],
      html_url: 'https://github.com/Garsson-io/kaizen/issues/97',
      created_at: '2026-03-18T00:00:00Z',
      updated_at: '2026-03-19T00:00:00Z',
      closed_at: null,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockIssue),
    });

    const result = await getGitHubIssue({
      owner: 'Garsson-io',
      repo: 'kaizen',
      issueNumber: 97,
    });

    expect(result.success).toBe(true);
    expect(result.issue!.number).toBe(97);
    expect(result.issue!.title).toBe('[Epic] Unify kaizen issues under cases');
    expect(result.issue!.labels).toHaveLength(2);

    // Verify correct URL
    const fetchUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(fetchUrl).toContain('/issues/97');
  });

  test('handles 404 for non-existent issue', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    });

    const result = await getGitHubIssue({
      owner: 'Garsson-io',
      repo: 'kaizen',
      issueNumber: 99999,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('404');
  });

  test('handles network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await getGitHubIssue({
      owner: 'Garsson-io',
      repo: 'kaizen',
      issueNumber: 97,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ETIMEDOUT');
  });
});
