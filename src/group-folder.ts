import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}

/** Default max age for uploads: 7 days in milliseconds. */
const DEFAULT_UPLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Remove upload files older than maxAgeMs from all group upload directories.
 * Called at startup to prevent unbounded disk growth from temporary documents.
 */
export function cleanupStaleUploads(
  maxAgeMs: number = DEFAULT_UPLOAD_MAX_AGE_MS,
  groupsDir: string = GROUPS_DIR,
): void {
  try {
    const entries = fs.readdirSync(groupsDir, { withFileTypes: true });
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const uploadsDir = path.join(groupsDir, entry.name, 'uploads');
      if (!fs.existsSync(uploadsDir)) continue;

      const files = fs.readdirSync(uploadsDir);
      for (const file of files) {
        const filePath = path.join(uploadsDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
            removed++;
          }
        } catch {
          // Skip files we can't stat or remove
        }
      }
    }

    if (removed > 0) {
      logger.info(
        { removed, maxAgeDays: maxAgeMs / 86400000 },
        'Cleaned up stale uploads',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up stale uploads');
  }
}
