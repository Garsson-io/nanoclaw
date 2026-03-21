export type ErrorCategory =
  | 'rate_limit'
  | 'billing'
  | 'auth'
  | 'timeout'
  | 'container'
  | 'unknown';

/**
 * Classify an error detail string into a known category.
 * Used for user-facing error messages — maps raw error text to actionable categories.
 */
export function classifyError(errorDetail: string): ErrorCategory {
  const d = (errorDetail || '').toLowerCase();

  if (
    d.includes('rate limit') ||
    d.includes('rate_limit') ||
    d.includes('429')
  ) {
    return 'rate_limit';
  }

  if (
    d.includes('budget') ||
    d.includes('billing') ||
    d.includes('insufficient') ||
    d.includes('credit') ||
    d.includes('payment') ||
    d.includes('quota')
  ) {
    return 'billing';
  }

  if (
    d.includes('401') ||
    d.includes('403') ||
    d.includes('unauthorized') ||
    d.includes('forbidden') ||
    d.includes('authentication') ||
    d.includes('invalid key') ||
    d.includes('invalid api key')
  ) {
    return 'auth';
  }

  if (d.includes('timeout') || d.includes('timed out')) {
    return 'timeout';
  }

  if (d.includes('docker') || d.includes('container') || d.includes('spawn')) {
    return 'container';
  }

  return 'unknown';
}
