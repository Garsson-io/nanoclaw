import { describe, it, expect } from 'vitest';

import { sanitizeRequestId } from './ipc-sanitize.js';

describe('sanitizeRequestId', () => {
  /**
   * INVARIANT: sanitizeRequestId must strip all characters that could be used
   * for path traversal or shell injection, keeping only [a-zA-Z0-9_-].
   *
   * SUT: sanitizeRequestId function
   * VERIFICATION: Known attack payloads produce safe strings; safe inputs pass through unchanged.
   */

  it('passes through safe alphanumeric IDs unchanged', () => {
    expect(sanitizeRequestId('req-test-123')).toBe('req-test-123');
    expect(sanitizeRequestId('route-1773738908605-pwnz')).toBe(
      'route-1773738908605-pwnz',
    );
    expect(sanitizeRequestId('abc_def_123')).toBe('abc_def_123');
  });

  it('strips path traversal sequences', () => {
    expect(sanitizeRequestId('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeRequestId('../../../tmp/evil')).toBe('tmpevil');
    expect(sanitizeRequestId('..\\..\\windows\\system32')).toBe(
      'windowssystem32',
    );
  });

  it('strips directory separators', () => {
    expect(sanitizeRequestId('foo/bar')).toBe('foobar');
    expect(sanitizeRequestId('foo\\bar')).toBe('foobar');
  });

  it('strips shell metacharacters', () => {
    expect(sanitizeRequestId('req;rm -rf /')).toBe('reqrm-rf');
    expect(sanitizeRequestId('req$(whoami)')).toBe('reqwhoami');
    expect(sanitizeRequestId('req`id`')).toBe('reqid');
  });

  it('strips spaces and special characters', () => {
    expect(sanitizeRequestId('req test 123')).toBe('reqtest123');
    expect(sanitizeRequestId('req@#$%^&*()')).toBe('req');
  });

  it('returns empty string for entirely unsafe input', () => {
    expect(sanitizeRequestId('../../..')).toBe('');
    expect(sanitizeRequestId('///')).toBe('');
    expect(sanitizeRequestId('...')).toBe('');
  });

  it('handles empty string input', () => {
    expect(sanitizeRequestId('')).toBe('');
  });
});
