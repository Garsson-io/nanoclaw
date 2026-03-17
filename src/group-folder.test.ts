import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupStaleUploads,
  isValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(
      true,
    );
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveGroupIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
  });
});

// Mock logger before importing module under test
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('cleanupStaleUploads', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-upload-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes files older than maxAgeMs from uploads directories', () => {
    const uploadsDir = path.join(tmpDir, 'test-group', 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });

    // Create an old file (mtime set to 10 days ago)
    const oldFile = path.join(uploadsDir, '1-old-doc.pdf');
    fs.writeFileSync(oldFile, 'old content');
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

    // Create a recent file
    const newFile = path.join(uploadsDir, '2-new-doc.pdf');
    fs.writeFileSync(newFile, 'new content');

    cleanupStaleUploads(7 * 24 * 60 * 60 * 1000, tmpDir);

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
  });

  it('skips groups without uploads directory', () => {
    fs.mkdirSync(path.join(tmpDir, 'empty-group'), { recursive: true });

    expect(() =>
      cleanupStaleUploads(7 * 24 * 60 * 60 * 1000, tmpDir),
    ).not.toThrow();
  });

  it('does not throw when groups directory does not exist', () => {
    const nonexistent = path.join(tmpDir, 'nonexistent');
    expect(() =>
      cleanupStaleUploads(7 * 24 * 60 * 60 * 1000, nonexistent),
    ).not.toThrow();
  });

  it('keeps files younger than maxAgeMs', () => {
    const uploadsDir = path.join(tmpDir, 'test-group', 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });

    const recentFile = path.join(uploadsDir, '1-recent.pdf');
    fs.writeFileSync(recentFile, 'recent');

    cleanupStaleUploads(7 * 24 * 60 * 60 * 1000, tmpDir);

    expect(fs.existsSync(recentFile)).toBe(true);
  });

  it('cleans uploads across multiple groups', () => {
    for (const group of ['group-a', 'group-b']) {
      const uploadsDir = path.join(tmpDir, group, 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });

      const oldFile = path.join(uploadsDir, 'old.pdf');
      fs.writeFileSync(oldFile, 'old');
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);
    }

    cleanupStaleUploads(7 * 24 * 60 * 60 * 1000, tmpDir);

    expect(
      fs.existsSync(path.join(tmpDir, 'group-a', 'uploads', 'old.pdf')),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(tmpDir, 'group-b', 'uploads', 'old.pdf')),
    ).toBe(false);
  });
});
