import { describe, it, expect } from 'vitest';

import type { RouterRequest, RouterResponse } from './router-types.js';

describe('RouterRequest', () => {
  /**
   * INVARIANT: RouterRequest must contain all required fields for routing decisions
   * SUT: RouterRequest type shape
   * VERIFICATION: A well-formed request object satisfies the interface
   */
  it('accepts a well-formed routing request with all required fields', () => {
    const request: RouterRequest = {
      type: 'route',
      requestId: 'req-123',
      messageText: 'Fix the login bug',
      senderName: 'Aviad',
      groupFolder: 'telegram_garsson',
      cases: [
        {
          id: 'case-1',
          name: '260315-1430-fix-auth',
          type: 'dev',
          status: 'active',
          description: 'Fix authentication flow',
          lastMessage: 'Working on OAuth redirect',
          lastActivityAt: '2025-03-15T14:30:00.000Z',
        },
      ],
    };

    expect(request.type).toBe('route');
    expect(request.requestId).toBe('req-123');
    expect(request.cases).toHaveLength(1);
    expect(request.cases[0].id).toBe('case-1');
  });

  /**
   * INVARIANT: RouterRequest supports null values for optional case fields
   * SUT: RouterRequest case array entries
   * VERIFICATION: Cases with null lastMessage and lastActivityAt are valid
   */
  it('accepts cases with null lastMessage and lastActivityAt', () => {
    const request: RouterRequest = {
      type: 'route',
      requestId: 'req-456',
      messageText: 'Hello',
      senderName: 'User',
      groupFolder: 'test_group',
      cases: [
        {
          id: 'case-2',
          name: '260316-0900-new-case',
          type: 'work',
          status: 'active',
          description: 'A new case',
          lastMessage: null,
          lastActivityAt: null,
        },
      ],
    };

    expect(request.cases[0].lastMessage).toBeNull();
    expect(request.cases[0].lastActivityAt).toBeNull();
  });

  /**
   * INVARIANT: RouterRequest supports optional rejectionHistory for Phase 2
   * SUT: RouterRequest.rejectionHistory field
   * VERIFICATION: Request is valid with and without rejectionHistory
   */
  it('accepts optional rejectionHistory field', () => {
    const withoutRejection: RouterRequest = {
      type: 'route',
      requestId: 'req-a',
      messageText: 'msg',
      senderName: 'user',
      groupFolder: 'grp',
      cases: [],
    };

    const withRejection: RouterRequest = {
      ...withoutRejection,
      requestId: 'req-b',
      rejectionHistory: [
        {
          caseId: 'case-1',
          caseName: 'fix-auth',
          reason: 'Not related to auth',
        },
      ],
    };

    expect(withoutRejection.rejectionHistory).toBeUndefined();
    expect(withRejection.rejectionHistory).toHaveLength(1);
    expect(withRejection.rejectionHistory![0].reason).toBe(
      'Not related to auth',
    );
  });
});

describe('RouterResponse', () => {
  /**
   * INVARIANT: RouterResponse supports all three decision types
   * SUT: RouterResponse decision field
   * VERIFICATION: Each decision type can be represented
   */
  it('supports route_to_case decision', () => {
    const response: RouterResponse = {
      requestId: 'req-1',
      decision: 'route_to_case',
      caseId: 'case-1',
      caseName: 'fix-auth',
      confidence: 0.9,
      reason: 'Message about auth matches case',
    };

    expect(response.decision).toBe('route_to_case');
    expect(response.caseId).toBe('case-1');
  });

  it('supports direct_answer decision', () => {
    const response: RouterResponse = {
      requestId: 'req-2',
      decision: 'direct_answer',
      confidence: 0.95,
      reason: 'Simple greeting',
      directAnswer: 'Hello! How can I help?',
    };

    expect(response.decision).toBe('direct_answer');
    expect(response.directAnswer).toBe('Hello! How can I help?');
    expect(response.caseId).toBeUndefined();
  });

  it('supports suggest_new decision', () => {
    const response: RouterResponse = {
      requestId: 'req-3',
      decision: 'suggest_new',
      confidence: 0.2,
      reason: 'No existing case matches this topic',
    };

    expect(response.decision).toBe('suggest_new');
    expect(response.confidence).toBe(0.2);
  });

  /**
   * INVARIANT: RouterResponse includes optional model field for tracking
   * SUT: RouterResponse.model field
   * VERIFICATION: Model field is present when provided
   */
  it('includes optional model field', () => {
    const response: RouterResponse = {
      requestId: 'req-4',
      decision: 'route_to_case',
      caseId: 'case-1',
      caseName: 'test',
      confidence: 0.8,
      reason: 'match',
      model: 'claude-haiku-4-5-20251001',
    };

    expect(response.model).toBe('claude-haiku-4-5-20251001');
  });
});
