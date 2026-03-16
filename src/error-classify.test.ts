import { describe, it, expect } from 'vitest';
import { classifyError, getErrorMessage } from './error-classify.js';

describe('classifyError', () => {
  describe('rate limit errors', () => {
    it('classifies "rate limit" messages', () => {
      expect(classifyError('API rate limit exceeded')).toBe('rate_limit');
    });
    it('classifies "rate_limit" messages', () => {
      expect(classifyError('rate_limit_error')).toBe('rate_limit');
    });
    it('classifies 429 status', () => {
      expect(classifyError('HTTP 429 Too Many Requests')).toBe('rate_limit');
    });
  });

  describe('budget errors', () => {
    it('classifies billing errors', () => {
      expect(classifyError('billing account suspended')).toBe('budget');
    });
    it('classifies quota errors', () => {
      expect(classifyError('monthly quota exceeded')).toBe('budget');
    });
  });

  describe('auth errors', () => {
    it('classifies 401 status', () => {
      expect(classifyError('HTTP 401 Unauthorized')).toBe('auth');
    });
    it('classifies 403 status', () => {
      expect(classifyError('HTTP 403 Forbidden')).toBe('auth');
    });
    it('classifies unauthorized', () => {
      expect(classifyError('unauthorized access')).toBe('auth');
    });

    // BUG #1: This test should PASS but will FAIL with the current
    // includes('invalid.*key') implementation — it's a literal string match,
    // not a regex, so "invalid API key" is never classified as auth.
    it('classifies "invalid API key" as auth error', () => {
      expect(classifyError('invalid API key')).toBe('auth');
    });
    it('classifies "invalid key" as auth error', () => {
      expect(classifyError('invalid key provided')).toBe('auth');
    });
  });

  describe('timeout errors', () => {
    it('classifies timeout', () => {
      expect(classifyError('request timeout')).toBe('timeout');
    });
    it('classifies "timed out"', () => {
      expect(classifyError('connection timed out')).toBe('timeout');
    });
  });

  describe('container errors', () => {
    it('classifies docker errors', () => {
      expect(classifyError('docker daemon not running')).toBe('container');
    });
    it('classifies container errors', () => {
      expect(classifyError('container exited with code 1')).toBe('container');
    });
    it('classifies spawn errors', () => {
      expect(classifyError('spawn ENOENT')).toBe('container');
    });
  });

  describe('unknown errors', () => {
    it('classifies unknown errors', () => {
      expect(classifyError('some random error')).toBe('unknown');
    });
    it('handles empty string', () => {
      expect(classifyError('')).toBe('unknown');
    });
    it('handles null-ish input', () => {
      expect(classifyError(undefined as unknown as string)).toBe('unknown');
    });
  });

  describe('case insensitivity', () => {
    it('matches regardless of case', () => {
      expect(classifyError('RATE LIMIT EXCEEDED')).toBe('rate_limit');
      expect(classifyError('Unauthorized')).toBe('auth');
    });
  });
});

describe('getErrorMessage', () => {
  it('returns user-facing message for each category', () => {
    expect(getErrorMessage('rate_limit')).toContain('rate limit');
    expect(getErrorMessage('auth')).toContain('Authentication');
    expect(getErrorMessage('unknown')).toContain('Something went wrong');
  });
});
