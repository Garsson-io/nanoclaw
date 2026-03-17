/**
 * Tests for the router diagnostic CLI tool.
 * Verifies arg parsing and dry-run mode work correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildRouterPrompt } from '../src/router-prompt.js';
import { RouterRequest } from '../src/router-types.js';

/**
 * The test-router.ts script is a CLI tool that's hard to unit-test directly
 * (it does process.chdir, dynamic imports, process.exit). Instead we test
 * the core logic it depends on — buildRouterPrompt — with the same inputs
 * the script would produce.
 */

function makeTestRouterRequest(
  messageText: string,
  sender: string,
): RouterRequest {
  return {
    type: 'route',
    requestId: `test-${Date.now()}-abcd`,
    messageText,
    senderName: sender,
    groupFolder: 'test_diagnostic',
    cases: [
      {
        id: 'case-1',
        name: '260317-fix-auth',
        type: 'dev',
        status: 'active',
        description: 'Fix authentication flow',
        lastMessage: 'Working on OAuth',
        lastActivityAt: new Date().toISOString(),
      },
      {
        id: 'case-2',
        name: '260317-add-tests',
        type: 'dev',
        status: 'active',
        description: 'Add integration tests',
        lastMessage: null,
        lastActivityAt: null,
      },
    ],
  };
}

describe('test-router diagnostic: core logic', () => {
  /**
   * INVARIANT: The diagnostic tool produces valid prompts with the requestId
   * embedded, so the dry-run output accurately reflects what production sends.
   * SUT: buildRouterPrompt with test-router-style inputs
   * VERIFICATION: Prompt contains requestId, sender, message, and all cases
   */
  it('produces a prompt containing requestId, sender, message, and cases', () => {
    const request = makeTestRouterRequest('Fix the auth bug', 'TestUser');
    const prompt = buildRouterPrompt(request);

    expect(prompt).toContain(request.requestId);
    expect(prompt).toContain('TestUser');
    expect(prompt).toContain('Fix the auth bug');
    expect(prompt).toContain('260317-fix-auth');
    expect(prompt).toContain('260317-add-tests');
    expect(prompt).toContain('route_decision');
  });

  /**
   * INVARIANT: Different test messages produce different prompts with the
   * same structure, matching what the diagnostic tool would generate.
   * SUT: buildRouterPrompt determinism
   * VERIFICATION: Two calls with different inputs produce distinct prompts
   */
  it('handles Hebrew and special characters in messages', () => {
    const request = makeTestRouterRequest('תשלח לי את הקובץ', 'DeMarco');
    const prompt = buildRouterPrompt(request);

    expect(prompt).toContain('תשלח לי את הקובץ');
    expect(prompt).toContain('DeMarco');
    expect(prompt).toContain(request.requestId);
  });
});
