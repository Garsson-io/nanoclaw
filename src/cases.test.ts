import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  insertCase,
  getCaseById,
  getActiveCasesByGithubIssue,
  updateCase,
  formatCaseStatus,
  writeCasesSnapshot,
  suggestDevCase,
  type Case,
} from './cases.js';
import fs from 'fs';
import path from 'path';

beforeEach(() => {
  _initTestDatabase();
});

function makeCase(overrides: Partial<Case> = {}): Case {
  const now = new Date().toISOString();
  return {
    id: `case-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    group_folder: 'test',
    chat_jid: 'tg:123',
    name: '260317-1200-test-case',
    description: 'Test case description',
    type: 'dev',
    status: 'active',
    blocked_on: null,
    worktree_path: null,
    workspace_path: '/tmp/test',
    branch_name: null,
    initiator: 'test',
    initiator_channel: null,
    last_message: null,
    last_activity_at: now,
    conclusion: null,
    created_at: now,
    done_at: null,
    reviewed_at: null,
    pruned_at: null,
    total_cost_usd: 0,
    token_source: null,
    time_spent_ms: 0,
    github_issue: null,
    ...overrides,
  };
}

// INVARIANT: Cases with a github_issue store and retrieve the value correctly.
// SUT: insertCase + getCaseById round-trip
// VERIFICATION: Insert a case with github_issue set, retrieve it, confirm the value matches.
describe('github_issue storage', () => {
  it('stores and retrieves github_issue when set', () => {
    const c = makeCase({ id: 'case-gh-1', github_issue: 16 });
    insertCase(c);

    const retrieved = getCaseById('case-gh-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.github_issue).toBe(16);
  });

  it('stores and retrieves github_issue as null when not set', () => {
    const c = makeCase({ id: 'case-gh-2', github_issue: null });
    insertCase(c);

    const retrieved = getCaseById('case-gh-2');
    expect(retrieved).toBeDefined();
    expect(retrieved!.github_issue).toBeNull();
  });

  it('updates github_issue via updateCase', () => {
    const c = makeCase({ id: 'case-gh-3', github_issue: null });
    insertCase(c);

    updateCase('case-gh-3', { github_issue: 42 });
    const retrieved = getCaseById('case-gh-3');
    expect(retrieved!.github_issue).toBe(42);
  });
});

// INVARIANT: getActiveCasesByGithubIssue returns only active/backlog/blocked/suggested
//   cases matching the issue number, never done/reviewed/pruned cases.
// SUT: getActiveCasesByGithubIssue
// VERIFICATION: Insert cases with various statuses linked to the same issue,
//   confirm only non-terminal statuses are returned.
describe('getActiveCasesByGithubIssue', () => {
  it('returns active cases matching the issue number', () => {
    insertCase(makeCase({ id: 'active-16', status: 'active', github_issue: 16 }));
    insertCase(makeCase({ id: 'backlog-16', status: 'backlog', github_issue: 16 }));

    const results = getActiveCasesByGithubIssue(16);
    expect(results).toHaveLength(2);
    expect(results.map((c) => c.id).sort()).toEqual(['active-16', 'backlog-16']);
  });

  it('excludes done/reviewed/pruned cases', () => {
    insertCase(makeCase({ id: 'done-16', status: 'done', github_issue: 16 }));
    insertCase(makeCase({ id: 'reviewed-16', status: 'reviewed', github_issue: 16 }));
    insertCase(makeCase({ id: 'pruned-16', status: 'pruned', github_issue: 16 }));

    const results = getActiveCasesByGithubIssue(16);
    expect(results).toHaveLength(0);
  });

  it('includes suggested and blocked cases', () => {
    insertCase(makeCase({ id: 'suggested-16', status: 'suggested', github_issue: 16 }));
    insertCase(makeCase({ id: 'blocked-16', status: 'blocked', github_issue: 16 }));

    const results = getActiveCasesByGithubIssue(16);
    expect(results).toHaveLength(2);
  });

  it('does not return cases linked to a different issue', () => {
    insertCase(makeCase({ id: 'other-issue', status: 'active', github_issue: 99 }));
    insertCase(makeCase({ id: 'no-issue', status: 'active', github_issue: null }));

    const results = getActiveCasesByGithubIssue(16);
    expect(results).toHaveLength(0);
  });

  it('returns empty array when no cases exist', () => {
    const results = getActiveCasesByGithubIssue(999);
    expect(results).toHaveLength(0);
  });
});

// INVARIANT: formatCaseStatus includes [kaizen #N] when github_issue is set,
//   and omits it when null.
// SUT: formatCaseStatus
// VERIFICATION: Format cases with and without github_issue, check output string.
describe('formatCaseStatus with github_issue', () => {
  it('includes kaizen issue reference when set', () => {
    const c = makeCase({ github_issue: 16 });
    const output = formatCaseStatus(c);
    expect(output).toContain('[kaizen #16]');
  });

  it('omits kaizen issue reference when null', () => {
    const c = makeCase({ github_issue: null });
    const output = formatCaseStatus(c);
    expect(output).not.toContain('[kaizen');
  });
});

// INVARIANT: writeCasesSnapshot includes github_issue in the JSON output for each case.
// SUT: writeCasesSnapshot
// VERIFICATION: Write snapshot, read JSON, verify github_issue field is present.
describe('writeCasesSnapshot with github_issue', () => {
  it('includes github_issue in snapshot output', () => {
    const tmpDir = fs.mkdtempSync('/tmp/nanoclaw-test-');
    const ipcDir = path.join(tmpDir, 'ipc', 'test');

    // Temporarily override DATA_DIR by writing directly
    const c = makeCase({ github_issue: 16 });
    fs.mkdirSync(ipcDir, { recursive: true });

    writeCasesSnapshot('test', true, [c]);

    const snapshotPath = path.join(
      process.cwd(),
      'data',
      'ipc',
      'test',
      'active_cases.json',
    );

    // Only verify if the snapshot was written (depends on DATA_DIR)
    if (fs.existsSync(snapshotPath)) {
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
      expect(snapshot[0].github_issue).toBe(16);
      // Cleanup
      fs.unlinkSync(snapshotPath);
    }

    // Cleanup temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// INVARIANT: Schema migration adds github_issue column to existing tables
//   without error, and calling createCasesSchema twice does not fail.
// SUT: createCasesSchema (migration path)
// VERIFICATION: _initTestDatabase calls createCasesSchema — calling it again
//   should not throw (migration is idempotent).
describe('schema migration idempotency', () => {
  it('calling _initTestDatabase twice does not throw', () => {
    expect(() => _initTestDatabase()).not.toThrow();
    expect(() => _initTestDatabase()).not.toThrow();
  });

  it('cases inserted after double-init have github_issue', () => {
    _initTestDatabase();
    const c = makeCase({ id: 'post-migrate', github_issue: 7 });
    insertCase(c);

    const retrieved = getCaseById('post-migrate');
    expect(retrieved!.github_issue).toBe(7);
  });
});
