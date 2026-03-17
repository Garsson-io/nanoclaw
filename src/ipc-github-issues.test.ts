import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// Mock github-issues module at the top level
vi.mock('./github-issues.js', () => ({
  createGitHubIssue: vi.fn(),
}));

import { createGitHubIssue } from './github-issues.js';

const mockedCreateGitHubIssue = vi.mocked(createGitHubIssue);

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'telegram_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const WORK_GROUP: RegisteredGroup = {
  name: 'Work',
  folder: 'telegram_work',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let sendMessage: ReturnType<typeof vi.fn<IpcDeps['sendMessage']>>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'tg:111': MAIN_GROUP,
    'tg:222': WORK_GROUP,
  };

  setRegisteredGroup('tg:111', MAIN_GROUP);
  setRegisteredGroup('tg:222', WORK_GROUP);

  sendMessage = vi.fn().mockResolvedValue(undefined);

  deps = {
    sendMessage,
    registeredGroups: () => groups,
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
  };

  mockedCreateGitHubIssue.mockReset();
});

// INVARIANT: create_github_issue IPC calls createGitHubIssue on the host
// and writes result back for the MCP tool to read
// SUT: processTaskIpc 'create_github_issue' handler
describe('create_github_issue IPC handler', () => {
  test('calls createGitHubIssue with correct parameters', async () => {
    mockedCreateGitHubIssue.mockResolvedValue({
      success: true,
      issueUrl: 'https://github.com/Garsson-io/kaizen/issues/99',
      issueNumber: 99,
    });

    await processTaskIpc(
      {
        type: 'create_github_issue',
        owner: 'Garsson-io',
        repo: 'kaizen',
        title: 'Work agent needs help',
        body: 'Detailed problem description',
        labels: ['work-agent', 'needs-dev'],
        requestId: 'req-test-123',
      } as any,
      'telegram_work',
      false,
      deps,
    );

    expect(mockedCreateGitHubIssue).toHaveBeenCalledWith({
      owner: 'Garsson-io',
      repo: 'kaizen',
      title: 'Work agent needs help',
      body: 'Detailed problem description',
      labels: ['work-agent', 'needs-dev'],
    });
  });

  test('writes result file for MCP tool to read', async () => {
    mockedCreateGitHubIssue.mockResolvedValue({
      success: true,
      issueUrl: 'https://github.com/Garsson-io/kaizen/issues/99',
      issueNumber: 99,
    });

    // Mock fs operations for result file
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    await processTaskIpc(
      {
        type: 'create_github_issue',
        owner: 'Garsson-io',
        repo: 'kaizen',
        title: 'Test issue',
        body: 'Body',
        labels: ['work-agent'],
        requestId: 'req-abc',
      } as any,
      'telegram_work',
      false,
      deps,
    );

    // Find the writeFileSync call that writes the result
    const resultWriteCall = writeSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('req-abc'),
    );
    expect(resultWriteCall).toBeDefined();
    const writtenResult = JSON.parse(resultWriteCall![1] as string);
    expect(writtenResult.success).toBe(true);
    expect(writtenResult.issueUrl).toContain('issues/99');

    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });

  test('sends Telegram notification on success', async () => {
    mockedCreateGitHubIssue.mockResolvedValue({
      success: true,
      issueUrl: 'https://github.com/Garsson-io/kaizen/issues/99',
      issueNumber: 99,
    });

    await processTaskIpc(
      {
        type: 'create_github_issue',
        owner: 'Garsson-io',
        repo: 'kaizen',
        title: 'Test',
        body: 'Body',
        labels: [],
      } as any,
      'telegram_work',
      false,
      deps,
    );

    expect(sendMessage).toHaveBeenCalledWith(
      'tg:222',
      expect.stringContaining('issues/99'),
    );
  });

  test('does not send notification on failure', async () => {
    mockedCreateGitHubIssue.mockResolvedValue({
      success: false,
      error: 'Token not set',
    });

    await processTaskIpc(
      {
        type: 'create_github_issue',
        owner: 'Garsson-io',
        repo: 'kaizen',
        title: 'Test',
        body: 'Body',
        labels: [],
      } as any,
      'telegram_work',
      false,
      deps,
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('rejects request with missing title', async () => {
    await processTaskIpc(
      {
        type: 'create_github_issue',
        owner: 'Garsson-io',
        repo: 'kaizen',
        body: 'Missing title',
      } as any,
      'telegram_work',
      false,
      deps,
    );

    expect(mockedCreateGitHubIssue).not.toHaveBeenCalled();
  });

  test('uses default labels when none provided', async () => {
    mockedCreateGitHubIssue.mockResolvedValue({
      success: true,
      issueUrl: 'https://github.com/Garsson-io/kaizen/issues/1',
      issueNumber: 1,
    });

    await processTaskIpc(
      {
        type: 'create_github_issue',
        owner: 'Garsson-io',
        repo: 'kaizen',
        title: 'Test',
        body: 'Body',
      } as any,
      'telegram_work',
      false,
      deps,
    );

    expect(mockedCreateGitHubIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: ['work-agent', 'needs-dev'],
      }),
    );
  });
});
