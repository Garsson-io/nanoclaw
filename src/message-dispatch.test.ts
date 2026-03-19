/**
 * Trigger-to-outcome integration tests for message dispatch.
 *
 * These tests are shaped like USER INTENT, not like code:
 * "When I send X, what happens?" — not "does function Y call function Z?"
 *
 * Each test verifies the complete decision chain from message arrival to
 * dispatch action, covering the wiring that was previously untested in
 * index.ts processGroupMessages (kaizen #173, #174).
 *
 * INVARIANT: The dispatch decision must correctly chain trigger detection,
 * safe word detection, case routing, and dev session activation — the same
 * chain that PR #190 proved can break silently when unit tests pass.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { makeCase } from './test-helpers.test-util.js';
import {
  resolveDispatch,
  type DispatchAction,
  type DispatchDeps,
  type DispatchInput,
} from './message-dispatch.js';
import type { Case } from './cases.js';
import type { NewMessage, RegisteredGroup } from './types.js';
import type { SenderAllowlistConfig } from './sender-allowlist.js';
import type { RouterResponse } from './router-types.js';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Helpers

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    chat_jid: 'tg:123',
    sender: '+1234567890',
    sender_name: 'Test User',
    content: 'Hello world',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test_group',
    trigger: 'Andy',
    added_at: new Date().toISOString(),
    ...overrides,
  };
}

const DEFAULT_ALLOWLIST: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  chats: {},
  logDenied: false,
  autoTriggerSenders: [],
};

function makeDeps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    loadSenderAllowlist: vi.fn(() => DEFAULT_ALLOWLIST),
    isTriggerAllowed: vi.fn(() => true),
    shouldAutoTrigger: vi.fn(() => false),
    detectDevSafeWord: vi.fn((content: string) => ({
      found: false,
      strippedContent: content,
    })),
    getActiveCases: vi.fn(() => []),
    getRoutableCases: vi.fn(() => []),
    getSuggestedCases: vi.fn(() => []),
    getCaseById: vi.fn(() => undefined),
    formatMessages: vi.fn((msgs: NewMessage[]) =>
      msgs.map((m) => `[${m.sender_name}] ${m.content}`).join('\n'),
    ),
    routeMessage: vi.fn(),
    ...overrides,
  };
}

function makeInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    chatJid: 'tg:123',
    group: makeGroup(),
    isMainGroup: true,
    messages: [makeMessage()],
    triggerPattern: /^@Andy\b/i,
    assistantName: 'Andy',
    timezone: 'UTC',
    ...overrides,
  };
}

// Tests

describe('resolveDispatch — trigger-to-outcome', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // INVARIANT: Empty message batches are skipped without side effects
  it('skips when no messages', async () => {
    const result = await resolveDispatch(
      makeInput({ messages: [] }),
      makeDeps(),
    );

    expect(result).toEqual({ type: 'skip', reason: 'no messages' });
  });

  // INVARIANT: Non-main groups require a trigger pattern to proceed
  it('skips non-main group messages without trigger', async () => {
    const deps = makeDeps({
      isTriggerAllowed: vi.fn(() => true),
      shouldAutoTrigger: vi.fn(() => false),
    });

    const result = await resolveDispatch(
      makeInput({
        isMainGroup: false,
        group: makeGroup({ requiresTrigger: true }),
        messages: [makeMessage({ content: 'just chatting' })],
      }),
      deps,
    );

    expect(result).toEqual({
      type: 'skip',
      reason: 'no trigger in non-main group',
    });
  });

  // INVARIANT: Non-main groups WITH trigger proceed to processing
  it('processes non-main group messages with trigger', async () => {
    const deps = makeDeps({
      isTriggerAllowed: vi.fn(() => true),
    });

    const result = await resolveDispatch(
      makeInput({
        isMainGroup: false,
        group: makeGroup({ requiresTrigger: true }),
        messages: [makeMessage({ content: '@Andy fix the bug' })],
      }),
      deps,
    );

    expect(result.type).toBe('run_container');
  });

  // INVARIANT: Main group always processes (no trigger required)
  it('processes main group messages without trigger', async () => {
    const result = await resolveDispatch(
      makeInput({
        isMainGroup: true,
        messages: [makeMessage({ content: 'no trigger prefix here' })],
      }),
      makeDeps(),
    );

    expect(result.type).toBe('run_container');
    // loadSenderAllowlist should not even be called for main group
  });

  // INVARIANT: Auto-trigger senders bypass the trigger requirement
  it('auto-trigger sender proceeds in non-main group', async () => {
    const deps = makeDeps({
      shouldAutoTrigger: vi.fn(() => true),
    });

    const result = await resolveDispatch(
      makeInput({
        isMainGroup: false,
        group: makeGroup({ requiresTrigger: true }),
        messages: [
          makeMessage({ content: 'fix the auth flow', sender: 'admin' }),
        ],
      }),
      deps,
    );

    expect(result.type).toBe('run_container');
  });

  describe('safe word → dev session activation', () => {
    // INVARIANT: Safe word + active dev case → dev session (not container)
    // SUT: The chain detectDevSafeWord → case routing → dispatch type
    // VERIFICATION: dispatch.type === 'dev_session' with correct case and prompt
    it('dispatches to dev_session when safe word found and active dev case exists', async () => {
      const devCase = makeCase({
        type: 'dev',
        status: 'active',
        chat_jid: 'tg:123',
      });

      const deps = makeDeps({
        detectDevSafeWord: vi.fn(() => ({
          found: true,
          strippedContent: 'fix the auth bug',
        })),
        getActiveCases: vi.fn(() => [devCase]),
        getRoutableCases: vi.fn(() => [devCase]),
      });

      const result = await resolveDispatch(
        makeInput({
          messages: [makeMessage({ content: 'kaizen fix the auth bug' })],
        }),
        deps,
      );

      expect(result.type).toBe('dev_session');
      if (result.type === 'dev_session') {
        expect(result.targetCase.id).toBe(devCase.id);
        expect(result.targetCase.type).toBe('dev');
        expect(result.prompt).toContain('fix the auth bug');
      }
    });

    // INVARIANT: Safe word + work case (not dev) → container with devMode=true
    it('falls through to container with devMode when safe word found but case is work type', async () => {
      const workCase = makeCase({
        type: 'work',
        status: 'active',
        chat_jid: 'tg:123',
      });

      const deps = makeDeps({
        detectDevSafeWord: vi.fn(() => ({
          found: true,
          strippedContent: 'update the report',
        })),
        getActiveCases: vi.fn(() => [workCase]),
        getRoutableCases: vi.fn(() => [workCase]),
      });

      const result = await resolveDispatch(
        makeInput({
          messages: [makeMessage({ content: 'kaizen update the report' })],
        }),
        deps,
      );

      expect(result.type).toBe('run_container');
      if (result.type === 'run_container') {
        expect(result.devMode).toBe(true);
        expect(result.targetCase?.type).toBe('work');
      }
    });

    // INVARIANT: Safe word + no active cases → container with devMode=true
    it('falls through to container with devMode when safe word found but no active cases', async () => {
      const deps = makeDeps({
        detectDevSafeWord: vi.fn(() => ({
          found: true,
          strippedContent: 'start fresh',
        })),
      });

      const result = await resolveDispatch(
        makeInput({
          messages: [makeMessage({ content: 'kaizen start fresh' })],
        }),
        deps,
      );

      expect(result.type).toBe('run_container');
      if (result.type === 'run_container') {
        expect(result.devMode).toBe(true);
        expect(result.targetCase).toBeUndefined();
      }
    });

    // INVARIANT: Safe word is stripped from message content before prompt is built
    it('strips safe word from message content before building prompt', async () => {
      const devCase = makeCase({
        type: 'dev',
        status: 'active',
        chat_jid: 'tg:123',
      });

      const mockFormatMessages = vi.fn((msgs: NewMessage[]) =>
        msgs.map((m) => m.content).join('\n'),
      );

      const deps = makeDeps({
        detectDevSafeWord: vi.fn(() => ({
          found: true,
          strippedContent: 'fix the auth bug',
        })),
        getActiveCases: vi.fn(() => [devCase]),
        getRoutableCases: vi.fn(() => [devCase]),
        formatMessages: mockFormatMessages,
      });

      const messages = [makeMessage({ content: 'kaizen fix the auth bug' })];

      await resolveDispatch(makeInput({ messages }), deps);

      // The message content should have been mutated (safe word stripped)
      expect(messages[0].content).toBe('fix the auth bug');
      // formatMessages should receive the stripped content
      expect(mockFormatMessages).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ content: 'fix the auth bug' }),
        ]),
        'UTC',
      );
    });

    // INVARIANT: Group-specific safe words are passed to detection
    it('passes group-specific safe words to detection', async () => {
      const mockDetect = vi.fn(() => ({
        found: false,
        strippedContent: 'hello',
      }));

      const deps = makeDeps({ detectDevSafeWord: mockDetect });

      await resolveDispatch(
        makeInput({
          group: makeGroup({
            containerConfig: { devSafeWords: ['magic-word'] },
          }),
          messages: [makeMessage({ content: 'hello' })],
        }),
        deps,
      );

      expect(mockDetect).toHaveBeenCalledWith('hello', ['magic-word']);
    });
  });

  describe('no safe word → regular container', () => {
    // INVARIANT: Without safe word or cases, dispatch to container with no case
    it('dispatches to container without case when no active cases', async () => {
      const result = await resolveDispatch(
        makeInput({
          messages: [makeMessage({ content: '@Andy check the logs' })],
        }),
        makeDeps(),
      );

      expect(result.type).toBe('run_container');
      if (result.type === 'run_container') {
        expect(result.devMode).toBe(false);
        expect(result.targetCase).toBeUndefined();
      }
    });

    // INVARIANT: Single active case auto-routes without router
    it('auto-routes to single active case', async () => {
      const theCase = makeCase({
        status: 'active',
        chat_jid: 'tg:123',
      });

      const deps = makeDeps({
        getActiveCases: vi.fn(() => [theCase]),
        getRoutableCases: vi.fn(() => [theCase]),
      });

      const result = await resolveDispatch(
        makeInput({
          messages: [makeMessage({ content: 'update on this' })],
        }),
        deps,
      );

      expect(result.type).toBe('run_container');
      if (result.type === 'run_container') {
        expect(result.targetCase?.id).toBe(theCase.id);
        expect(result.devMode).toBe(false);
      }
    });
  });

  describe('status command', () => {
    // INVARIANT: "status" command with active cases returns status, not container
    it('returns status_command for "status" with active cases', async () => {
      const cases = [
        makeCase({ name: 'case-a', status: 'active' }),
        makeCase({ name: 'case-b', status: 'active' }),
      ];
      const suggested = [makeCase({ status: 'suggested' as any })];

      const deps = makeDeps({
        getActiveCases: vi.fn(() => cases),
        getSuggestedCases: vi.fn(() => suggested),
      });

      const result = await resolveDispatch(
        makeInput({
          messages: [makeMessage({ content: 'status' })],
        }),
        deps,
      );

      expect(result.type).toBe('status_command');
      if (result.type === 'status_command') {
        expect(result.activeCases).toHaveLength(2);
        expect(result.suggestedCases).toHaveLength(1);
      }
    });

    // INVARIANT: "cases" and "tasks" are also valid status commands
    it.each(['cases', 'tasks', 'Status', 'CASES'])(
      'recognizes "%s" as status command',
      async (cmd) => {
        const deps = makeDeps({
          getActiveCases: vi.fn(() => [makeCase()]),
        });

        const result = await resolveDispatch(
          makeInput({
            messages: [makeMessage({ content: cmd })],
          }),
          deps,
        );

        expect(result.type).toBe('status_command');
      },
    );

    // INVARIANT: "status" without active cases falls through to container
    it('falls through to container when no active cases for status command', async () => {
      const result = await resolveDispatch(
        makeInput({
          messages: [makeMessage({ content: 'status' })],
        }),
        makeDeps(),
      );

      expect(result.type).toBe('run_container');
    });
  });

  describe('multi-case routing', () => {
    // INVARIANT: With 2+ cases, router decides which case gets the message
    it('routes to case selected by router', async () => {
      const caseA = makeCase({ id: 'case-a', name: 'fix-auth' });
      const caseB = makeCase({ id: 'case-b', name: 'add-feature' });

      const deps = makeDeps({
        getActiveCases: vi.fn(() => [caseA, caseB]),
        getRoutableCases: vi.fn(() => [caseA, caseB]),
        getCaseById: vi.fn((id: string) =>
          id === 'case-b' ? caseB : undefined,
        ),
        routeMessage: vi.fn(async () => ({
          requestId: 'test',
          decision: 'route_to_case' as const,
          caseId: 'case-b',
          caseName: 'add-feature',
          confidence: 0.9,
          reason: 'Message about feature',
        })),
      });

      const result = await resolveDispatch(
        makeInput({
          messages: [makeMessage({ content: 'the feature needs tests' })],
        }),
        deps,
      );

      expect(result.type).toBe('run_container');
      if (result.type === 'run_container') {
        expect(result.targetCase?.id).toBe('case-b');
      }
    });

    // INVARIANT: Router direct_answer returns text without spawning container
    it('returns direct_answer when router provides one', async () => {
      const caseA = makeCase({ id: 'case-a' });
      const caseB = makeCase({ id: 'case-b' });

      const deps = makeDeps({
        getActiveCases: vi.fn(() => [caseA, caseB]),
        getRoutableCases: vi.fn(() => [caseA, caseB]),
        routeMessage: vi.fn(
          async (): Promise<RouterResponse> => ({
            requestId: 'test',
            decision: 'direct_answer',
            confidence: 0.95,
            reason: 'Simple question',
            directAnswer: 'Case A is fixing auth, Case B is adding feature.',
          }),
        ),
      });

      const result = await resolveDispatch(
        makeInput({
          messages: [makeMessage({ content: 'what are the active cases?' })],
        }),
        deps,
      );

      expect(result.type).toBe('direct_answer');
      if (result.type === 'direct_answer') {
        expect(result.text).toContain('Case A');
      }
    });

    // INVARIANT: Router failure falls through to container without case context
    it('falls through to container when router fails', async () => {
      const caseA = makeCase({ id: 'case-a' });
      const caseB = makeCase({ id: 'case-b' });

      const deps = makeDeps({
        getActiveCases: vi.fn(() => [caseA, caseB]),
        getRoutableCases: vi.fn(() => [caseA, caseB]),
        routeMessage: vi.fn(async () => {
          throw new Error('Router container crashed');
        }),
      });

      const result = await resolveDispatch(
        makeInput({
          messages: [makeMessage({ content: 'something' })],
        }),
        deps,
      );

      expect(result.type).toBe('run_container');
      if (result.type === 'run_container') {
        expect(result.targetCase).toBeUndefined();
      }
    });

    // INVARIANT: Router suggest_new dispatches to container without case
    it('dispatches to container without case when router suggests new', async () => {
      const caseA = makeCase({ id: 'case-a' });
      const caseB = makeCase({ id: 'case-b' });

      const deps = makeDeps({
        getActiveCases: vi.fn(() => [caseA, caseB]),
        getRoutableCases: vi.fn(() => [caseA, caseB]),
        routeMessage: vi.fn(
          async (): Promise<RouterResponse> => ({
            requestId: 'test',
            decision: 'suggest_new',
            confidence: 0.8,
            reason: 'Unrelated to existing cases',
          }),
        ),
      });

      const result = await resolveDispatch(
        makeInput({
          messages: [makeMessage({ content: 'something brand new' })],
        }),
        deps,
      );

      expect(result.type).toBe('run_container');
      if (result.type === 'run_container') {
        expect(result.targetCase).toBeUndefined();
      }
    });
  });

  describe('interaction: safe word + multi-case routing', () => {
    // INVARIANT: Safe word detection happens BEFORE case routing,
    // so the stripped content is what the router sees
    it('safe word is stripped before router sees the message', async () => {
      const devCase = makeCase({ id: 'case-dev', type: 'dev' });
      const workCase = makeCase({ id: 'case-work', type: 'work' });

      const mockRouteMessage = vi.fn(
        async (): Promise<RouterResponse> => ({
          requestId: 'test',
          decision: 'route_to_case',
          caseId: 'case-dev',
          caseName: devCase.name,
          confidence: 0.9,
          reason: 'Dev case',
        }),
      );

      const deps = makeDeps({
        detectDevSafeWord: vi.fn(() => ({
          found: true,
          strippedContent: 'fix the bug',
        })),
        getActiveCases: vi.fn(() => [devCase, workCase]),
        getRoutableCases: vi.fn(() => [devCase, workCase]),
        getCaseById: vi.fn((id: string) =>
          id === 'case-dev' ? devCase : undefined,
        ),
        routeMessage: mockRouteMessage,
      });

      const result = await resolveDispatch(
        makeInput({
          messages: [makeMessage({ content: 'kaizen fix the bug' })],
        }),
        deps,
      );

      // Should be dev_session because safe word + dev case
      expect(result.type).toBe('dev_session');

      // Router should have seen the stripped content
      expect(mockRouteMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messageText: 'fix the bug',
        }),
      );
    });

    // INVARIANT: Safe word + multi-case routed to work case → container with devMode
    it('safe word routed to work case dispatches container with devMode', async () => {
      const devCase = makeCase({ id: 'case-dev', type: 'dev' });
      const workCase = makeCase({ id: 'case-work', type: 'work' });

      const deps = makeDeps({
        detectDevSafeWord: vi.fn(() => ({
          found: true,
          strippedContent: 'update the invoice',
        })),
        getActiveCases: vi.fn(() => [devCase, workCase]),
        getRoutableCases: vi.fn(() => [devCase, workCase]),
        getCaseById: vi.fn((id: string) =>
          id === 'case-work' ? workCase : undefined,
        ),
        routeMessage: vi.fn(
          async (): Promise<RouterResponse> => ({
            requestId: 'test',
            decision: 'route_to_case',
            caseId: 'case-work',
            caseName: workCase.name,
            confidence: 0.9,
            reason: 'Work case',
          }),
        ),
      });

      const result = await resolveDispatch(
        makeInput({
          messages: [makeMessage({ content: 'kaizen update the invoice' })],
        }),
        deps,
      );

      expect(result.type).toBe('run_container');
      if (result.type === 'run_container') {
        expect(result.devMode).toBe(true);
        expect(result.targetCase?.id).toBe('case-work');
      }
    });
  });

  describe('timestamp tracking', () => {
    // INVARIANT: All non-skip dispatch results include the last message timestamp
    it('includes last message timestamp in all dispatch results', async () => {
      const timestamp = '2026-03-19T12:00:00.000Z';
      const result = await resolveDispatch(
        makeInput({
          messages: [makeMessage({ timestamp })],
        }),
        makeDeps(),
      );

      expect(result.type).not.toBe('skip');
      if (result.type !== 'skip') {
        expect(result.lastTimestamp).toBe(timestamp);
      }
    });

    // INVARIANT: With multiple messages, last timestamp is from the last message
    it('uses timestamp from the last message', async () => {
      const result = await resolveDispatch(
        makeInput({
          messages: [
            makeMessage({ timestamp: '2026-03-19T11:00:00.000Z' }),
            makeMessage({ timestamp: '2026-03-19T12:00:00.000Z' }),
            makeMessage({ timestamp: '2026-03-19T13:00:00.000Z' }),
          ],
        }),
        makeDeps(),
      );

      if (result.type !== 'skip') {
        expect(result.lastTimestamp).toBe('2026-03-19T13:00:00.000Z');
      }
    });
  });

  describe('edge cases', () => {
    // INVARIANT: requiresTrigger=false bypasses trigger check for non-main groups
    it('skips trigger check when requiresTrigger is false', async () => {
      const deps = makeDeps();

      const result = await resolveDispatch(
        makeInput({
          isMainGroup: false,
          group: makeGroup({ requiresTrigger: false }),
          messages: [makeMessage({ content: 'no trigger here' })],
        }),
        deps,
      );

      expect(result.type).toBe('run_container');
      expect(deps.loadSenderAllowlist).not.toHaveBeenCalled();
    });

    // INVARIANT: is_from_me messages bypass sender allowlist for trigger check
    it('allows is_from_me messages as trigger source', async () => {
      const deps = makeDeps({
        isTriggerAllowed: vi.fn(() => false), // Would reject if checked
      });

      const result = await resolveDispatch(
        makeInput({
          isMainGroup: false,
          group: makeGroup({ requiresTrigger: true }),
          messages: [
            makeMessage({
              content: '@Andy do something',
              is_from_me: true,
            }),
          ],
        }),
        deps,
      );

      expect(result.type).toBe('run_container');
    });

    // INVARIANT: Only the first safe word match in the batch is used
    it('stops after first safe word match', async () => {
      let callCount = 0;
      const deps = makeDeps({
        detectDevSafeWord: vi.fn((content: string) => {
          callCount++;
          if (content === 'kaizen msg1') {
            return { found: true, strippedContent: 'msg1' };
          }
          return { found: false, strippedContent: content };
        }),
      });

      await resolveDispatch(
        makeInput({
          messages: [
            makeMessage({ content: 'kaizen msg1' }),
            makeMessage({ content: 'kaizen msg2' }),
          ],
        }),
        deps,
      );

      // Should stop after finding the first safe word
      expect(callCount).toBe(1);
    });
  });
});
