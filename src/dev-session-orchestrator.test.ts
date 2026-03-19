import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock dev-bot
const mockClaimDevBot = vi.fn();
const mockReleaseDevBot = vi.fn();
const mockGetDevBot = vi.fn();
const mockIsDevBotAvailable = vi.fn();

vi.mock('./dev-bot.js', () => ({
  claimDevBot: (...args: unknown[]) => mockClaimDevBot(...args),
  releaseDevBot: (...args: unknown[]) => mockReleaseDevBot(...args),
  getDevBot: () => mockGetDevBot(),
  isDevBotAvailable: () => mockIsDevBotAvailable(),
}));

// Mock dev-session
const mockStartDevSession = vi.fn();
const mockStopDevSession = vi.fn();
const mockGetActiveDevSession = vi.fn();

vi.mock('./dev-session.js', () => ({
  startDevSession: (...args: unknown[]) => mockStartDevSession(...args),
  stopDevSession: (...args: unknown[]) => mockStopDevSession(...args),
  getActiveDevSession: (id: string) => mockGetActiveDevSession(id),
}));

// Mock dev-session-router
const mockNotifySessionStarted = vi.fn();
const mockNotifySessionCompleted = vi.fn();

vi.mock('./dev-session-router.js', () => ({
  notifySessionStarted: (...args: unknown[]) => mockNotifySessionStarted(...args),
  notifySessionCompleted: (...args: unknown[]) =>
    mockNotifySessionCompleted(...args),
}));

import {
  activateDevSession,
  deactivateDevSession,
  canStartDevSession,
} from './dev-session-orchestrator.js';
import type { Case } from './cases.js';
import type { RegisteredGroup } from './types.js';

function makeTestCase(overrides: Partial<Case> = {}): Case {
  const now = new Date().toISOString();
  return {
    id: 'case-test-1',
    group_folder: 'main',
    chat_jid: 'tg:123',
    name: '260319-1000-k134-test',
    description: 'Test dev case',
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
    github_issue: 134,
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

const mockGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'main',
  trigger: 'test',
  added_at: new Date().toISOString(),
};

const mockDeps = {
  sendMessage: vi.fn().mockResolvedValue(undefined),
  getGroupByFolder: vi.fn().mockReturnValue(mockGroup),
  isMainGroup: vi.fn().mockReturnValue(true),
};

const mockBotConfig = {
  id: 'dev_bot_1',
  displayName: 'DevAda',
  persona: 'test',
};

const mockSessionObj = {
  caseId: 'case-test-1',
  caseName: 'test-case',
  containerName: 'nanoclaw-dev-main-123',
  botName: 'DevAda',
  ended: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDevBot.mockReturnValue(mockBotConfig);
  mockNotifySessionStarted.mockResolvedValue(undefined);
  mockNotifySessionCompleted.mockResolvedValue(undefined);
});

// INVARIANT: activateDevSession claims bot, starts container, notifies admin.
// SUT: activateDevSession
// VERIFICATION: All three steps happen in order on success.
describe('activateDevSession', () => {
  it('claims bot, starts session, and notifies on success', async () => {
    const c = makeTestCase();
    mockGetActiveDevSession.mockReturnValue(undefined);
    mockClaimDevBot.mockReturnValue(mockBotConfig);
    mockStartDevSession.mockResolvedValue(mockSessionObj);

    const result = await activateDevSession(c, 'Do the work', mockDeps);

    expect(result.session).toBe(mockSessionObj);
    expect(result.error).toBeUndefined();
    expect(mockClaimDevBot).toHaveBeenCalledWith(c.id, c.name);
    expect(mockStartDevSession).toHaveBeenCalled();
    expect(mockNotifySessionStarted).toHaveBeenCalledWith(
      c.id,
      c.name,
      134,
      mockDeps,
    );
  });

  it('returns existing session if already active', async () => {
    const c = makeTestCase();
    mockGetActiveDevSession.mockReturnValue(mockSessionObj);

    const result = await activateDevSession(c, 'Do the work', mockDeps);

    expect(result.session).toBe(mockSessionObj);
    expect(mockClaimDevBot).not.toHaveBeenCalled();
  });

  it('rejects work cases', async () => {
    const c = makeTestCase({ type: 'work' });

    const result = await activateDevSession(c, 'Do the work', mockDeps);

    expect(result.session).toBeNull();
    expect(result.error).toContain('Only dev cases');
  });

  it('returns error when bot is busy', async () => {
    const c = makeTestCase();
    mockGetActiveDevSession.mockReturnValue(undefined);
    mockClaimDevBot.mockReturnValue(null);

    const result = await activateDevSession(c, 'Do the work', mockDeps);

    expect(result.session).toBeNull();
    expect(result.error).toContain('busy');
  });

  it('returns error when group not found', async () => {
    const c = makeTestCase();
    mockGetActiveDevSession.mockReturnValue(undefined);
    mockClaimDevBot.mockReturnValue(mockBotConfig);
    mockDeps.getGroupByFolder.mockReturnValueOnce(undefined);

    const result = await activateDevSession(c, 'Do the work', mockDeps);

    expect(result.session).toBeNull();
    expect(result.error).toContain('Group not found');
    // Should release the bot on failure
    expect(mockReleaseDevBot).toHaveBeenCalledWith(c.id);
  });

  it('releases bot if startDevSession throws', async () => {
    const c = makeTestCase();
    mockGetActiveDevSession.mockReturnValue(undefined);
    mockClaimDevBot.mockReturnValue(mockBotConfig);
    mockStartDevSession.mockRejectedValue(new Error('Docker unavailable'));

    const result = await activateDevSession(c, 'Do the work', mockDeps);

    expect(result.session).toBeNull();
    expect(result.error).toContain('Docker unavailable');
    expect(mockReleaseDevBot).toHaveBeenCalledWith(c.id);
  });
});

// INVARIANT: deactivateDevSession stops container, releases bot, notifies admin.
// SUT: deactivateDevSession
// VERIFICATION: All cleanup steps are called.
describe('deactivateDevSession', () => {
  it('stops session, releases bot, and notifies', async () => {
    await deactivateDevSession('case-test-1', 'completed', mockDeps);

    expect(mockStopDevSession).toHaveBeenCalledWith('case-test-1', 'completed');
    expect(mockReleaseDevBot).toHaveBeenCalledWith('case-test-1');
    expect(mockNotifySessionCompleted).toHaveBeenCalledWith(
      'case-test-1',
      'completed',
      mockDeps,
    );
  });
});

// INVARIANT: canStartDevSession reflects bot availability.
// SUT: canStartDevSession
// VERIFICATION: Returns available=true when bot free, false when busy.
describe('canStartDevSession', () => {
  it('returns available when bot is free', () => {
    mockIsDevBotAvailable.mockReturnValue(true);

    const result = canStartDevSession();

    expect(result.available).toBe(true);
  });

  it('returns unavailable when bot is busy', () => {
    mockIsDevBotAvailable.mockReturnValue(false);

    const result = canStartDevSession();

    expect(result.available).toBe(false);
    expect(result.reason).toContain('busy');
  });
});
