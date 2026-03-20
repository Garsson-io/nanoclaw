import { describe, it, expect } from 'vitest';
import { classifyError } from './error-classify.js';

describe('classifyError', () => {
  // INVARIANT: classifyError returns a category string for known error patterns
  // SUT: classifyError(errorDetail)

  it('classifies rate limit errors', () => {
    expect(classifyError('rate limit exceeded')).toBe('rate_limit');
    expect(classifyError('rate_limit_error')).toBe('rate_limit');
    expect(classifyError('HTTP 429 Too Many Requests')).toBe('rate_limit');
  });

  it('classifies budget/billing errors', () => {
    expect(classifyError('budget exceeded')).toBe('billing');
    expect(classifyError('insufficient credits')).toBe('billing');
    expect(classifyError('billing issue')).toBe('billing');
  });

  it('classifies auth errors', () => {
    expect(classifyError('401 Unauthorized')).toBe('auth');
    expect(classifyError('403 Forbidden')).toBe('auth');
    expect(classifyError('authentication failed')).toBe('auth');
    expect(classifyError('unauthorized access')).toBe('auth');
  });

  // VERIFICATION: This was the original bug — 'invalid.*key' was a literal
  // string match, not a regex. "invalid API key" should match as auth error.
  it('classifies "invalid API key" as auth (not unknown)', () => {
    expect(classifyError('invalid API key')).toBe('auth');
    expect(classifyError('invalid key provided')).toBe('auth');
    expect(classifyError('Error: Invalid API Key')).toBe('auth');
  });

  it('classifies timeout errors', () => {
    expect(classifyError('request timeout')).toBe('timeout');
    expect(classifyError('connection timed out')).toBe('timeout');
  });

  it('classifies container errors', () => {
    expect(classifyError('docker daemon not running')).toBe('container');
    expect(classifyError('container exited with code 1')).toBe('container');
    expect(classifyError('spawn ENOENT')).toBe('container');
  });

  it('returns unknown for unrecognized errors', () => {
    expect(classifyError('something unexpected happened')).toBe('unknown');
    expect(classifyError('')).toBe('unknown');
  });
});
