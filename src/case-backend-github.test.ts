import { describe, test, expect, vi, beforeEach } from 'vitest';

import type { Case } from './cases.js';

// Mock github-api functions before importing the module under test
const mockCreateGitHubIssue = vi.fn();
const mockUpdateGitHubIssue = vi.fn();
const mockAddGitHubIssueComment = vi.fn();

vi.mock('./github-api.js', () => ({
  createGitHubIssue: (...args: unknown[]) => mockCreateGitHubIssue(...args),
  updateGitHubIssue: (...args: unknown[]) => mockUpdateGitHubIssue(...args),
  addGitHubIssueComment: (...args: unknown[]) =>
    mockAddGitHubIssueComment(...args),
}));

// Mock cases.updateCase to avoid DB dependency
vi.mock('./cases.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    updateCase: vi.fn(),
  };
});

import {
  serializeMetadata,
  parseMetadata,
  GitHubCaseSyncAdapter,
  type CaseMetadata,
} from './case-backend-github.js';

function makeTestCase(overrides: Partial<Case> = {}): Case {
  return {
    id: 'case-test-123',
    group_folder: 'telegram_test',
    chat_jid: 'tg:-100123',
    name: '260318-1924-test-case',
    description: 'Test case description',
    type: 'dev',
    status: 'active',
    blocked_on: null,
    worktree_path: '/home/user/projects/nanoclaw/.claude/worktrees/260318-test',
    workspace_path: '/workspace/group',
    branch_name: 'case/260318-test',
    initiator: 'agent',
    initiator_channel: null,
    last_message: null,
    last_activity_at: '2026-03-18T19:24:00Z',
    conclusion: null,
    created_at: '2026-03-18T19:24:00Z',
    done_at: null,
    reviewed_at: null,
    pruned_at: null,
    total_cost_usd: 0,
    token_source: null,
    time_spent_ms: 0,
    github_issue: null,
    github_issue_url: null,
    customer_name: null,
    customer_phone: null,
    customer_email: null,
    customer_org: null,
    priority: null,
    gap_type: null,
    ...overrides,
  };
}

// INVARIANT: Metadata serialization round-trips correctly
// SUT: serializeMetadata, parseMetadata
describe('metadata serialization', () => {
  const fullMetadata: CaseMetadata = {
    case_id: 'case-1710700000-abc',
    case_name: '260317-1920-nir-b-booklet-butterfly',
    type: 'work',
    status: 'active',
    customer_name: 'Nir B.',
    customer_phone: '+972-50-1234567',
    customer_email: 'nir@example.com',
    customer_org: "Nir's Print Shop",
    initiator: 'nir-b',
    created_at: '2026-03-17T19:20:09Z',
    cost_usd: 0.42,
    time_spent_ms: 120000,
  };

  test('round-trips complete metadata', () => {
    const serialized = serializeMetadata(fullMetadata);
    const parsed = parseMetadata(serialized);

    expect(parsed).not.toBeNull();
    expect(parsed!.case_id).toBe(fullMetadata.case_id);
    expect(parsed!.case_name).toBe(fullMetadata.case_name);
    expect(parsed!.type).toBe(fullMetadata.type);
    expect(parsed!.status).toBe(fullMetadata.status);
    expect(parsed!.customer_name).toBe(fullMetadata.customer_name);
    expect(parsed!.customer_phone).toBe(fullMetadata.customer_phone);
    expect(parsed!.customer_email).toBe(fullMetadata.customer_email);
    expect(parsed!.customer_org).toBe(fullMetadata.customer_org);
    expect(parsed!.initiator).toBe(fullMetadata.initiator);
    expect(parsed!.created_at).toBe(fullMetadata.created_at);
    expect(parsed!.cost_usd).toBe(fullMetadata.cost_usd);
    expect(parsed!.time_spent_ms).toBe(fullMetadata.time_spent_ms);
  });

  test('omits empty/null/undefined fields', () => {
    const minimal: CaseMetadata = {
      case_id: 'case-123',
      case_name: 'test',
      type: 'dev',
      status: 'active',
      initiator: 'test',
      created_at: '2026-01-01T00:00:00Z',
      cost_usd: 0,
      time_spent_ms: 0,
    };

    const serialized = serializeMetadata(minimal);
    expect(serialized).not.toContain('customer_name');
    expect(serialized).not.toContain('customer_phone');
    expect(serialized).not.toContain('customer_email');
    expect(serialized).not.toContain('customer_org');
  });

  test('serialized format starts with HTML comment marker', () => {
    const serialized = serializeMetadata(fullMetadata);
    expect(serialized).toMatch(/^<!-- nanoclaw:v1/);
    expect(serialized).toMatch(/-->$/);
  });

  test('returns null when parsing body without metadata', () => {
    expect(parseMetadata('just some markdown')).toBeNull();
    expect(parseMetadata('')).toBeNull();
  });

  test('returns null when metadata block is incomplete', () => {
    expect(parseMetadata('<!-- nanoclaw:v1\ncase_id: test')).toBeNull();
  });

  test('parses metadata embedded in larger body', () => {
    const body = `Some preamble text

<!-- nanoclaw:v1
case_id: case-embedded
case_name: test-embedded
type: work
status: done
initiator: agent
created_at: 2026-01-01T00:00:00Z
cost_usd: 1.5
time_spent_ms: 60000
-->

## Issue description

More markdown here`;

    const parsed = parseMetadata(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.case_id).toBe('case-embedded');
    expect(parsed!.status).toBe('done');
    expect(parsed!.cost_usd).toBe(1.5);
  });

  test('handles values containing colons', () => {
    const body = `<!-- nanoclaw:v1
case_id: test
case_name: test
type: work
status: active
customer_org: Nir's: Print Shop
initiator: test
created_at: 2026-01-01T00:00:00Z
cost_usd: 1
time_spent_ms: 0
-->`;

    const parsed = parseMetadata(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.customer_org).toBe("Nir's: Print Shop");
  });

  test('handles numeric fields gracefully', () => {
    const body = `<!-- nanoclaw:v1
case_id: test
case_name: test
type: work
status: active
initiator: test
created_at: 2026-01-01T00:00:00Z
cost_usd: not-a-number
time_spent_ms: also-not
-->`;

    const parsed = parseMetadata(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.cost_usd).toBe(0);
    expect(parsed!.time_spent_ms).toBe(0);
  });
});

// INVARIANT: GitHubCaseSyncAdapter adds a claim comment when creating a case
// SUT: GitHubCaseSyncAdapter.createCase
// VERIFICATION: addGitHubIssueComment is called with claim details after successful issue creation
describe('GitHubCaseSyncAdapter', () => {
  const adapter = new GitHubCaseSyncAdapter('Garsson-io', 'kaizen');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createCase — claim comment', () => {
    test('adds claim comment after successful issue creation', async () => {
      mockCreateGitHubIssue.mockResolvedValue({
        success: true,
        issueNumber: 42,
        issueUrl: 'https://github.com/Garsson-io/kaizen/issues/42',
      });
      mockAddGitHubIssueComment.mockResolvedValue({ success: true });

      const c = makeTestCase({
        name: '260318-1924-test-claim',
        worktree_path: '/path/to/worktree',
      });
      await adapter.createCase(c);

      expect(mockAddGitHubIssueComment).toHaveBeenCalledOnce();
      const commentCall = mockAddGitHubIssueComment.mock.calls[0][0];
      expect(commentCall.owner).toBe('Garsson-io');
      expect(commentCall.repo).toBe('kaizen');
      expect(commentCall.issueNumber).toBe(42);
      expect(commentCall.body).toContain('Claimed by case');
      expect(commentCall.body).toContain('260318-1924-test-claim');
      expect(commentCall.body).toContain('/path/to/worktree');
    });

    test('does not add claim comment when issue creation fails', async () => {
      mockCreateGitHubIssue.mockResolvedValue({
        success: false,
        error: 'API error',
      });

      const c = makeTestCase();
      await adapter.createCase(c);

      expect(mockAddGitHubIssueComment).not.toHaveBeenCalled();
    });

    test('does not fail if claim comment fails', async () => {
      mockCreateGitHubIssue.mockResolvedValue({
        success: true,
        issueNumber: 43,
        issueUrl: 'https://github.com/Garsson-io/kaizen/issues/43',
      });
      mockAddGitHubIssueComment.mockRejectedValue(new Error('Comment failed'));

      const c = makeTestCase();
      const result = await adapter.createCase(c);

      // createCase should still succeed even if comment fails
      expect(result.success).toBe(true);
    });
  });

  // INVARIANT: updateCase closes the GitHub issue when case reaches terminal status
  // SUT: GitHubCaseSyncAdapter.updateCase
  // VERIFICATION: updateGitHubIssue is called with state:'closed' when status is 'done' or 'reviewed'
  describe('updateCase — issue closure on terminal status', () => {
    test('closes issue when status changes to done', async () => {
      mockUpdateGitHubIssue.mockResolvedValue({ success: true });

      const c = makeTestCase({ github_issue: 50, status: 'done' });
      await adapter.updateCase(c, { status: 'done' });

      expect(mockUpdateGitHubIssue).toHaveBeenCalledOnce();
      const updateCall = mockUpdateGitHubIssue.mock.calls[0][0];
      expect(updateCall.state).toBe('closed');
      expect(updateCall.labels).toContain('status:done');
    });

    test('closes issue when status changes to reviewed', async () => {
      mockUpdateGitHubIssue.mockResolvedValue({ success: true });

      const c = makeTestCase({ github_issue: 51, status: 'reviewed' });
      await adapter.updateCase(c, { status: 'reviewed' });

      expect(mockUpdateGitHubIssue).toHaveBeenCalledOnce();
      const updateCall = mockUpdateGitHubIssue.mock.calls[0][0];
      expect(updateCall.state).toBe('closed');
    });

    test('does not close issue when status changes to active', async () => {
      mockUpdateGitHubIssue.mockResolvedValue({ success: true });

      const c = makeTestCase({ github_issue: 52, status: 'active' });
      await adapter.updateCase(c, { status: 'active' });

      expect(mockUpdateGitHubIssue).toHaveBeenCalledOnce();
      const updateCall = mockUpdateGitHubIssue.mock.calls[0][0];
      expect(updateCall.state).toBeUndefined();
    });

    test('does not close issue when non-status field changes', async () => {
      mockUpdateGitHubIssue.mockResolvedValue({ success: true });

      const c = makeTestCase({ github_issue: 53, status: 'active' });
      await adapter.updateCase(c, { description: 'updated description' });

      expect(mockUpdateGitHubIssue).toHaveBeenCalledOnce();
      const updateCall = mockUpdateGitHubIssue.mock.calls[0][0];
      expect(updateCall.state).toBeUndefined();
    });

    test('creates new issue when no github_issue is linked', async () => {
      mockCreateGitHubIssue.mockResolvedValue({
        success: true,
        issueNumber: 99,
        issueUrl: 'https://github.com/Garsson-io/kaizen/issues/99',
      });
      mockAddGitHubIssueComment.mockResolvedValue({ success: true });

      const c = makeTestCase({ github_issue: null });
      await adapter.updateCase(c, { status: 'active' });

      // Should fall through to createCase since no github_issue
      expect(mockCreateGitHubIssue).toHaveBeenCalledOnce();
      expect(mockUpdateGitHubIssue).not.toHaveBeenCalled();
    });
  });

  // INVARIANT: statusLabels always includes status and type labels
  // SUT: statusLabels (tested indirectly through updateCase)
  // VERIFICATION: labels array contains status:{status} and type:{type}
  describe('label sync', () => {
    test('syncs status:active and type:dev labels', async () => {
      mockUpdateGitHubIssue.mockResolvedValue({ success: true });

      const c = makeTestCase({
        github_issue: 60,
        status: 'active',
        type: 'dev',
      });
      await adapter.updateCase(c, { status: 'active' });

      const updateCall = mockUpdateGitHubIssue.mock.calls[0][0];
      expect(updateCall.labels).toContain('status:active');
      expect(updateCall.labels).toContain('type:dev');
    });

    test('syncs status:blocked and type:work labels', async () => {
      mockUpdateGitHubIssue.mockResolvedValue({ success: true });

      const c = makeTestCase({
        github_issue: 61,
        status: 'blocked',
        type: 'work',
      });
      await adapter.updateCase(c, { status: 'blocked' });

      const updateCall = mockUpdateGitHubIssue.mock.calls[0][0];
      expect(updateCall.labels).toContain('status:blocked');
      expect(updateCall.labels).toContain('type:work');
    });
  });
});
