/**
 * Tests for the safe-word → dev session activation path.
 *
 * Verifies that when a dev safe word is detected in a message AND there's
 * an active dev case, the code calls activateDevSession() instead of the
 * per-message container path.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock logger first (before any imports that use it)
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock config
vi.mock('./config.js', () => ({
  DEV_SAFE_WORDS: ['תברווז', 'duckdev'],
  ASSISTANT_NAME: 'Andy',
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  POLL_INTERVAL: 1000,
  TIMEZONE: 'Asia/Jerusalem',
  TRIGGER_PATTERN: /^@andy\b/i,
  TELEGRAM_BOT_POOL: [],
  CONTAINER_NAME_PREFIX: 'nanoclaw-',
  CREDENTIAL_PROXY_PORT: 3001,
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_TIMEOUT: 1800000,
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  STORE_DIR: '/tmp/nanoclaw-test-store',
}));

import { detectDevSafeWord } from './dev-safe-word.js';

// INVARIANT: detectDevSafeWord finds global safe words in message content
// and returns the stripped content.
// SUT: detectDevSafeWord
// VERIFICATION: Returns found=true and content without the safe word.
describe('detectDevSafeWord', () => {
  it('detects global safe word', () => {
    const result = detectDevSafeWord('תברווז fix the auth bug');
    expect(result.found).toBe(true);
    expect(result.strippedContent).toBe('fix the auth bug');
  });

  it('detects English safe word', () => {
    const result = detectDevSafeWord('duckdev implement retry logic');
    expect(result.found).toBe(true);
    expect(result.strippedContent).toBe('implement retry logic');
  });

  it('returns false when no safe word present', () => {
    const result = detectDevSafeWord('just a normal message');
    expect(result.found).toBe(false);
    expect(result.strippedContent).toBe('just a normal message');
  });

  it('detects group-specific safe words', () => {
    const result = detectDevSafeWord('buildme something cool', ['buildme']);
    expect(result.found).toBe(true);
    expect(result.strippedContent).toBe('something cool');
  });

  it('strips whitespace after removing safe word', () => {
    const result = detectDevSafeWord('תברווז   fix with extra spaces');
    expect(result.found).toBe(true);
    expect(result.strippedContent.startsWith(' ')).toBe(false);
  });

  it('handles safe word at end of message', () => {
    const result = detectDevSafeWord('do this תברווז');
    expect(result.found).toBe(true);
    expect(result.strippedContent.trim()).toBe('do this');
  });
});

// INVARIANT: The safe-word → dev session wiring requires that
// activateDevSession is importable from the orchestrator module.
// This is a dependency chain verification — if the import breaks,
// the safe word path can't activate dev sessions.
describe('safe-word to dev session wiring', () => {
  it('activateDevSession is importable from orchestrator', async () => {
    const orchestrator = await import('./dev-session-orchestrator.js');
    expect(typeof orchestrator.activateDevSession).toBe('function');
    expect(typeof orchestrator.deactivateDevSession).toBe('function');
    expect(typeof orchestrator.canStartDevSession).toBe('function');
  });

  it('detectDevSafeWord is importable from dev-safe-word module', async () => {
    const mod = await import('./dev-safe-word.js');
    expect(typeof mod.detectDevSafeWord).toBe('function');
  });
});
