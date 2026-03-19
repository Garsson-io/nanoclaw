import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  getDevBot,
  isDevBotAvailable,
  getDevBotClaim,
  claimDevBot,
  releaseDevBot,
  isDevBotMention,
  _resetDevBot,
} from './dev-bot.js';

beforeEach(() => {
  _resetDevBot();
});

// INVARIANT: The dev bot has a stable identity (id, display name, persona).
// SUT: getDevBot
// VERIFICATION: Returns expected config fields.
describe('getDevBot', () => {
  it('returns the default dev bot config', () => {
    const bot = getDevBot();
    expect(bot.id).toBe('dev_bot_1');
    expect(bot.displayName).toBe('DevAda');
    expect(bot.persona).toContain('DevAda');
  });
});

// INVARIANT: Only one case can claim the dev bot at a time.
// SUT: claimDevBot, releaseDevBot, isDevBotAvailable
// VERIFICATION: Second claim fails; release makes bot available again.
describe('claim/release lifecycle', () => {
  it('bot is available initially', () => {
    expect(isDevBotAvailable()).toBe(true);
    expect(getDevBotClaim()).toBeNull();
  });

  it('claim succeeds when bot is available', () => {
    const bot = claimDevBot('case-1', 'test-case');
    expect(bot).not.toBeNull();
    expect(bot!.displayName).toBe('DevAda');
    expect(isDevBotAvailable()).toBe(false);
  });

  it('claim returns null when bot is already claimed', () => {
    claimDevBot('case-1', 'test-case');
    const secondClaim = claimDevBot('case-2', 'another-case');
    expect(secondClaim).toBeNull();
  });

  it('getDevBotClaim returns the current claim', () => {
    claimDevBot('case-1', 'test-case');
    const claim = getDevBotClaim();
    expect(claim).not.toBeNull();
    expect(claim!.caseId).toBe('case-1');
    expect(claim!.caseName).toBe('test-case');
    expect(claim!.bot.displayName).toBe('DevAda');
  });

  it('release by owning case succeeds', () => {
    claimDevBot('case-1', 'test-case');
    const released = releaseDevBot('case-1');
    expect(released).toBe(true);
    expect(isDevBotAvailable()).toBe(true);
  });

  it('release by non-owning case fails', () => {
    claimDevBot('case-1', 'test-case');
    const released = releaseDevBot('case-2');
    expect(released).toBe(false);
    expect(isDevBotAvailable()).toBe(false);
  });

  it('force release succeeds regardless of owner', () => {
    claimDevBot('case-1', 'test-case');
    const released = releaseDevBot('case-2', true);
    expect(released).toBe(true);
    expect(isDevBotAvailable()).toBe(true);
  });

  it('release on already-available bot returns true', () => {
    const released = releaseDevBot('case-1');
    expect(released).toBe(true);
  });

  it('after release, bot can be claimed again', () => {
    claimDevBot('case-1', 'test-case');
    releaseDevBot('case-1');
    const bot = claimDevBot('case-2', 'new-case');
    expect(bot).not.toBeNull();
  });
});

// INVARIANT: Bot mention detection matches @DevAda and DevAda: prefixes.
// SUT: isDevBotMention
// VERIFICATION: Common patterns match; unrelated text doesn't.
describe('isDevBotMention', () => {
  it('detects @DevAda mention', () => {
    expect(isDevBotMention('Hey @DevAda how is it going?')).toBe(true);
  });

  it('detects DevAda: prefix', () => {
    expect(isDevBotMention('DevAda: what is the status?')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isDevBotMention('@devada check the tests')).toBe(true);
    expect(isDevBotMention('DEVADA: ship it')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(isDevBotMention('Hello team')).toBe(false);
    expect(isDevBotMention('The dev bot is working')).toBe(false);
  });
});
