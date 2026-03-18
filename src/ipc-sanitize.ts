/**
 * Sanitize IPC requestId values to prevent path traversal attacks.
 *
 * Agent-provided requestId values are used in file paths for IPC result files.
 * Without sanitization, a crafted requestId like "../../etc/something" could
 * write result files to arbitrary locations on the host filesystem.
 *
 * See: https://github.com/Garsson-io/kaizen/issues/47
 */

/**
 * Strip all characters except alphanumeric, hyphens, and underscores.
 * Returns empty string if input is falsy or entirely stripped.
 */
export function sanitizeRequestId(requestId: string): string {
  return requestId.replace(/[^a-zA-Z0-9_-]/g, '');
}
