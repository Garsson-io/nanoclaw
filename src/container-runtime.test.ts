import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_NAME_PREFIX: 'nanoclaw-',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  checkImageAdvisory,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('returns stop command using CONTAINER_RUNTIME_BIN', () => {
    expect(stopContainer('nanoclaw-test-123')).toBe(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-test-123`,
    );
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce(
      'nanoclaw-group1-111\nnanoclaw-group2-222\n',
    );
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group1-111`,
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group2-222`,
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});

// --- checkImageAdvisory ---

describe('checkImageAdvisory', () => {
  it('logs info when tagged images exist', () => {
    // First call: docker images nanoclaw-agent (tags)
    mockExecSync.mockReturnValueOnce('latest\nmain-current\nmain-previous\n');
    // Second call: docker images --filter dangling=true
    mockExecSync.mockReturnValueOnce('');

    checkImageAdvisory();

    expect(logger.info).toHaveBeenCalledWith(
      { taggedCount: 3, tags: ['latest', 'main-current', 'main-previous'] },
      'Docker images: 3 tagged nanoclaw-agent images',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns when dangling images exceed threshold', () => {
    mockExecSync.mockReturnValueOnce('latest\n');
    mockExecSync.mockReturnValueOnce('sha1\nsha2\nsha3\nsha4\n');

    checkImageAdvisory();

    expect(logger.warn).toHaveBeenCalledWith(
      { danglingCount: 4 },
      expect.stringContaining('4 dangling Docker images'),
    );
  });

  it('warns when tagged image count exceeds soft limit', () => {
    // 12 tagged images
    const tags = Array.from({ length: 12 }, (_, i) => `tag-${i}`).join('\n');
    mockExecSync.mockReturnValueOnce(tags + '\n');
    mockExecSync.mockReturnValueOnce('');

    checkImageAdvisory();

    expect(logger.warn).toHaveBeenCalledWith(
      { taggedCount: 12 },
      expect.stringContaining('exceeds recommended limit'),
    );
  });

  it('silently skips when docker is not available', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not found');
    });

    checkImageAdvisory(); // should not throw

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('filters out <none> tags from count', () => {
    mockExecSync.mockReturnValueOnce('latest\n<none>\n');
    mockExecSync.mockReturnValueOnce('');

    checkImageAdvisory();

    expect(logger.info).toHaveBeenCalledWith(
      { taggedCount: 1, tags: ['latest'] },
      'Docker images: 1 tagged nanoclaw-agent images',
    );
  });

  it('handles no tagged images without logging info', () => {
    mockExecSync.mockReturnValueOnce('\n');
    mockExecSync.mockReturnValueOnce('');

    checkImageAdvisory();

    expect(logger.info).not.toHaveBeenCalled();
  });
});
