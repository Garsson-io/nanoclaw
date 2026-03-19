/**
 * Dev safe word detection — extracted for testability.
 * Detects dev safe words in message content and strips them.
 */
import { DEV_SAFE_WORDS } from './config.js';

/**
 * Detect dev safe word in message content.
 * Checks both global DEV_SAFE_WORDS and group-specific devSafeWords.
 * Returns { found, strippedContent } — the safe word is removed from content.
 */
export function detectDevSafeWord(
  content: string,
  groupSafeWords?: string[],
): {
  found: boolean;
  strippedContent: string;
} {
  const allWords = [...DEV_SAFE_WORDS, ...(groupSafeWords || [])];
  for (const word of allWords) {
    if (content.includes(word)) {
      const stripped = content.replace(word, '').replace(/\s+/g, ' ').trim();
      return { found: true, strippedContent: stripped };
    }
  }
  return { found: false, strippedContent: content };
}
