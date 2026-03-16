/**
 * Classify agent error details into user-facing error categories.
 * Extracted from index.ts for testability.
 */

export type ErrorCategory =
  | 'rate_limit'
  | 'budget'
  | 'auth'
  | 'timeout'
  | 'container'
  | 'unknown';

const ERROR_MESSAGES: Record<ErrorCategory, string> = {
  rate_limit:
    '⚠️ API rate limit reached. Your message was received — will retry automatically.',
  budget:
    '⚠️ API budget/billing issue — unable to process requests. Aviad has been notified.',
  auth: '⚠️ Authentication error — API access denied. Aviad has been notified.',
  timeout:
    '⚠️ Request timed out. The task may be too complex — try breaking it into smaller parts.',
  container: '⚠️ Processing system unavailable. Aviad has been notified.',
  unknown:
    '⚠️ Something went wrong processing your message. Will retry automatically.',
};

export function classifyError(errorDetail: string): ErrorCategory {
  const errDetail = (errorDetail || '').toLowerCase();

  if (
    errDetail.includes('rate limit') ||
    errDetail.includes('rate_limit') ||
    errDetail.includes('429')
  ) {
    return 'rate_limit';
  }

  if (
    errDetail.includes('budget') ||
    errDetail.includes('billing') ||
    errDetail.includes('insufficient') ||
    errDetail.includes('credit') ||
    errDetail.includes('payment') ||
    errDetail.includes('quota')
  ) {
    return 'budget';
  }

  if (
    errDetail.includes('401') ||
    errDetail.includes('403') ||
    errDetail.includes('unauthorized') ||
    errDetail.includes('forbidden') ||
    errDetail.includes('authentication') ||
    errDetail.includes('invalid key') ||
    errDetail.includes('invalid api key')
  ) {
    return 'auth';
  }

  if (errDetail.includes('timeout') || errDetail.includes('timed out')) {
    return 'timeout';
  }

  if (
    errDetail.includes('docker') ||
    errDetail.includes('container') ||
    errDetail.includes('spawn')
  ) {
    return 'container';
  }

  return 'unknown';
}

export function getErrorMessage(category: ErrorCategory): string {
  return ERROR_MESSAGES[category];
}
