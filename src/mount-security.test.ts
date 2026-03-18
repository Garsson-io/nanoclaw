import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir: string;
let allowlistPath: string;

vi.mock('./config.js', () => ({
  get MOUNT_ALLOWLIST_PATH() {
    return allowlistPath;
  },
}));

vi.mock('pino', () => {
  const noop = () => mockLogger;
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { default: noop };
});

import {
  _resetCacheForTest,
  DEFAULT_BLOCKED_PATTERNS,
  expandPath,
  findAllowedRoot,
  generateAllowlistTemplate,
  isValidContainerPath,
  loadMountAllowlist,
  matchesBlockedPattern,
  validateAdditionalMounts,
  validateMount,
} from './mount-security.js';
import type { AllowedRoot, MountAllowlist } from './types.js';

function writeAllowlist(config: MountAllowlist): void {
  fs.writeFileSync(allowlistPath, JSON.stringify(config));
}

function makeAllowlist(
  overrides: Partial<MountAllowlist> = {},
): MountAllowlist {
  return {
    allowedRoots: [
      { path: tmpDir, allowReadWrite: true, description: 'test root' },
    ],
    blockedPatterns: [],
    nonMainReadOnly: false,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-security-test-'));
  allowlistPath = path.join(tmpDir, 'mount-allowlist.json');
  _resetCacheForTest();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// matchesBlockedPattern

describe('matchesBlockedPattern', () => {
  it('INVARIANT: exact path component match is blocked', () => {
    expect(matchesBlockedPattern('/home/user/.ssh/keys', ['.ssh'])).toBe(
      '.ssh',
    );
  });

  it('INVARIANT: substring match within path component is blocked', () => {
    expect(
      matchesBlockedPattern('/home/user/my.env.bak/config', ['.env']),
    ).toBe('.env');
  });

  it('INVARIANT: .dotenv is not blocked by .env pattern (different substring)', () => {
    // .dotenv does not contain .env as a substring (.d-o-t-e-n-v vs .e-n-v)
    expect(
      matchesBlockedPattern('/home/user/.dotenv/config', ['.env']),
    ).toBeNull();
  });

  it('INVARIANT: full path substring match is blocked', () => {
    expect(
      matchesBlockedPattern('/home/user/credentials/db.json', ['credentials']),
    ).toBe('credentials');
  });

  it('INVARIANT: non-matching path returns null', () => {
    expect(
      matchesBlockedPattern('/home/user/projects/myapp', ['.ssh', '.aws']),
    ).toBeNull();
  });

  it('INVARIANT: all default blocked patterns are non-empty strings', () => {
    for (const pattern of DEFAULT_BLOCKED_PATTERNS) {
      expect(typeof pattern).toBe('string');
      expect(pattern.length).toBeGreaterThan(0);
    }
  });

  it('INVARIANT: common sensitive directories are in DEFAULT_BLOCKED_PATTERNS', () => {
    const critical = [
      '.ssh',
      '.gnupg',
      '.aws',
      '.kube',
      '.docker',
      'credentials',
      '.env',
      'id_rsa',
      'id_ed25519',
      'private_key',
    ];
    for (const pattern of critical) {
      expect(DEFAULT_BLOCKED_PATTERNS).toContain(pattern);
    }
  });

  it('INVARIANT: each default pattern blocks its own path', () => {
    for (const pattern of DEFAULT_BLOCKED_PATTERNS) {
      const testPath = `/home/user/${pattern}/file.txt`;
      expect(matchesBlockedPattern(testPath, DEFAULT_BLOCKED_PATTERNS)).toBe(
        pattern,
      );
    }
  });

  it('returns null for empty blocked patterns list', () => {
    expect(matchesBlockedPattern('/home/user/.ssh', [])).toBeNull();
  });
});

// isValidContainerPath

describe('isValidContainerPath', () => {
  it('INVARIANT: relative path without traversal is valid', () => {
    expect(isValidContainerPath('myproject')).toBe(true);
    expect(isValidContainerPath('my-project/subdir')).toBe(true);
  });

  it('INVARIANT: path traversal (..) is rejected', () => {
    expect(isValidContainerPath('../escape')).toBe(false);
    expect(isValidContainerPath('sub/../escape')).toBe(false);
    expect(isValidContainerPath('..')).toBe(false);
  });

  it('INVARIANT: absolute paths are rejected', () => {
    expect(isValidContainerPath('/etc/passwd')).toBe(false);
    expect(isValidContainerPath('/workspace/something')).toBe(false);
  });

  it('INVARIANT: empty or whitespace-only paths are rejected', () => {
    expect(isValidContainerPath('')).toBe(false);
    expect(isValidContainerPath('   ')).toBe(false);
  });
});

// expandPath

describe('expandPath', () => {
  it('INVARIANT: tilde expands to home directory', () => {
    const home = process.env.HOME || os.homedir();
    expect(expandPath('~/projects')).toBe(path.join(home, 'projects'));
  });

  it('INVARIANT: bare tilde expands to home directory', () => {
    const home = process.env.HOME || os.homedir();
    expect(expandPath('~')).toBe(home);
  });

  it('INVARIANT: absolute path is returned resolved', () => {
    expect(expandPath('/tmp/test')).toBe('/tmp/test');
  });

  it('INVARIANT: relative path is resolved to absolute', () => {
    const result = expandPath('relative/path');
    expect(path.isAbsolute(result)).toBe(true);
  });
});

// findAllowedRoot

describe('findAllowedRoot', () => {
  it('INVARIANT: path under allowed root returns that root', () => {
    const subdir = path.join(tmpDir, 'project');
    fs.mkdirSync(subdir);
    const roots: AllowedRoot[] = [
      { path: tmpDir, allowReadWrite: true, description: 'test' },
    ];
    expect(findAllowedRoot(subdir, roots)).toEqual(roots[0]);
  });

  it('INVARIANT: path not under any root returns null', () => {
    const roots: AllowedRoot[] = [
      { path: '/nonexistent/root', allowReadWrite: true, description: 'test' },
    ];
    expect(findAllowedRoot(tmpDir, roots)).toBeNull();
  });

  it('INVARIANT: root that does not exist on disk is skipped', () => {
    const roots: AllowedRoot[] = [
      {
        path: '/this/path/does/not/exist',
        allowReadWrite: true,
        description: 'missing',
      },
      { path: tmpDir, allowReadWrite: false, description: 'exists' },
    ];
    const subdir = path.join(tmpDir, 'project');
    fs.mkdirSync(subdir);
    expect(findAllowedRoot(subdir, roots)).toEqual(roots[1]);
  });

  it('INVARIANT: the exact root path itself is allowed', () => {
    const roots: AllowedRoot[] = [
      { path: tmpDir, allowReadWrite: true, description: 'test' },
    ];
    expect(findAllowedRoot(tmpDir, roots)).toEqual(roots[0]);
  });

  it('INVARIANT: empty roots list returns null', () => {
    expect(findAllowedRoot(tmpDir, [])).toBeNull();
  });
});

// loadMountAllowlist

describe('loadMountAllowlist', () => {
  it('INVARIANT: returns null when allowlist file does not exist', () => {
    expect(loadMountAllowlist()).toBeNull();
  });

  it('INVARIANT: caches the load error — second call also returns null without re-reading', () => {
    expect(loadMountAllowlist()).toBeNull();
    // Create the file after first call
    writeAllowlist(makeAllowlist());
    // Still null because error is cached
    expect(loadMountAllowlist()).toBeNull();
  });

  it('INVARIANT: valid allowlist is parsed and returned', () => {
    writeAllowlist(makeAllowlist());
    const result = loadMountAllowlist();
    expect(result).not.toBeNull();
    expect(result!.allowedRoots).toHaveLength(1);
  });

  it('INVARIANT: default blocked patterns are merged with config blocked patterns', () => {
    writeAllowlist(makeAllowlist({ blockedPatterns: ['custom_secret'] }));
    const result = loadMountAllowlist();
    expect(result).not.toBeNull();
    // Should contain both defaults and custom
    expect(result!.blockedPatterns).toContain('.ssh');
    expect(result!.blockedPatterns).toContain('custom_secret');
  });

  it('INVARIANT: merged blocked patterns are deduplicated', () => {
    writeAllowlist(makeAllowlist({ blockedPatterns: ['.ssh', '.aws'] }));
    const result = loadMountAllowlist();
    expect(result).not.toBeNull();
    const sshCount = result!.blockedPatterns.filter((p) => p === '.ssh').length;
    expect(sshCount).toBe(1);
  });

  it('INVARIANT: result is cached — second call returns same object', () => {
    writeAllowlist(makeAllowlist());
    const first = loadMountAllowlist();
    const second = loadMountAllowlist();
    expect(first).toBe(second);
  });

  it('INVARIANT: invalid JSON returns null', () => {
    fs.writeFileSync(allowlistPath, 'not json');
    expect(loadMountAllowlist()).toBeNull();
  });

  it('INVARIANT: valid JSON but invalid schema returns null', () => {
    fs.writeFileSync(allowlistPath, JSON.stringify({ wrong: 'schema' }));
    expect(loadMountAllowlist()).toBeNull();
  });
});

// validateMount

describe('validateMount', () => {
  it('INVARIANT: mount is rejected when no allowlist exists', () => {
    const result = validateMount({ hostPath: tmpDir }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('allowlist');
  });

  it('INVARIANT: mount under allowed root with valid path is allowed', () => {
    const subdir = path.join(tmpDir, 'project');
    fs.mkdirSync(subdir);
    writeAllowlist(makeAllowlist());
    const result = validateMount({ hostPath: subdir }, true);
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe(fs.realpathSync(subdir));
    expect(result.resolvedContainerPath).toBe('project');
  });

  it('INVARIANT: mount with explicit containerPath uses it', () => {
    const subdir = path.join(tmpDir, 'project');
    fs.mkdirSync(subdir);
    writeAllowlist(makeAllowlist());
    const result = validateMount(
      { hostPath: subdir, containerPath: 'custom-name' },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('custom-name');
  });

  it('INVARIANT: mount with path traversal in containerPath is rejected', () => {
    const subdir = path.join(tmpDir, 'project');
    fs.mkdirSync(subdir);
    writeAllowlist(makeAllowlist());
    const result = validateMount(
      { hostPath: subdir, containerPath: '../escape' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('..');
  });

  it('INVARIANT: mount with absolute containerPath is rejected', () => {
    const subdir = path.join(tmpDir, 'project');
    fs.mkdirSync(subdir);
    writeAllowlist(makeAllowlist());
    const result = validateMount(
      { hostPath: subdir, containerPath: '/etc/passwd' },
      true,
    );
    expect(result.allowed).toBe(false);
  });

  it('INVARIANT: nonexistent host path is rejected', () => {
    writeAllowlist(makeAllowlist());
    const result = validateMount({ hostPath: '/no/such/path' }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  it('INVARIANT: path matching a blocked pattern is rejected', () => {
    const sshDir = path.join(tmpDir, '.ssh');
    fs.mkdirSync(sshDir);
    writeAllowlist(makeAllowlist());
    const result = validateMount({ hostPath: sshDir }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.ssh');
  });

  it('INVARIANT: path not under any allowed root is rejected', () => {
    // Use /tmp itself, which is not under tmpDir allowlist root
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    try {
      writeAllowlist(
        makeAllowlist({
          allowedRoots: [
            { path: tmpDir, allowReadWrite: true, description: 'test' },
          ],
        }),
      );
      const result = validateMount({ hostPath: outsideDir }, true);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not under any allowed root');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('INVARIANT: symlink to blocked path is rejected', () => {
    const secretDir = path.join(tmpDir, '.secret');
    fs.mkdirSync(secretDir);
    const linkPath = path.join(tmpDir, 'innocent-link');
    fs.symlinkSync(secretDir, linkPath);
    writeAllowlist(makeAllowlist());
    const result = validateMount({ hostPath: linkPath }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.secret');
  });
});

// Read-write policy

describe('validateMount read-write policy', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);
  });

  it('INVARIANT: default mount is read-only', () => {
    writeAllowlist(makeAllowlist());
    const result = validateMount({ hostPath: projectDir }, true);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('INVARIANT: explicit readonly=false is granted when root allows read-write and sender is main', () => {
    writeAllowlist(makeAllowlist());
    const result = validateMount(
      { hostPath: projectDir, readonly: false },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('INVARIANT: non-main group is forced read-only when nonMainReadOnly=true', () => {
    writeAllowlist(makeAllowlist({ nonMainReadOnly: true }));
    const result = validateMount(
      { hostPath: projectDir, readonly: false },
      false,
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('INVARIANT: non-main group can get read-write when nonMainReadOnly=false', () => {
    writeAllowlist(makeAllowlist({ nonMainReadOnly: false }));
    const result = validateMount(
      { hostPath: projectDir, readonly: false },
      false,
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('INVARIANT: read-write is denied when root does not allow it', () => {
    writeAllowlist(
      makeAllowlist({
        allowedRoots: [
          {
            path: tmpDir,
            allowReadWrite: false,
            description: 'read-only root',
          },
        ],
      }),
    );
    const result = validateMount(
      { hostPath: projectDir, readonly: false },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });
});

// validateAdditionalMounts

describe('validateAdditionalMounts', () => {
  it('INVARIANT: returns only allowed mounts', () => {
    const goodDir = path.join(tmpDir, 'good');
    fs.mkdirSync(goodDir);
    const badDir = path.join(tmpDir, '.ssh');
    fs.mkdirSync(badDir);
    writeAllowlist(makeAllowlist());

    const results = validateAdditionalMounts(
      [{ hostPath: goodDir }, { hostPath: badDir }],
      'test-group',
      true,
    );
    expect(results).toHaveLength(1);
    expect(results[0].hostPath).toBe(fs.realpathSync(goodDir));
  });

  it('INVARIANT: container paths are prefixed with /workspace/extra/', () => {
    const dir = path.join(tmpDir, 'myproject');
    fs.mkdirSync(dir);
    writeAllowlist(makeAllowlist());

    const results = validateAdditionalMounts(
      [{ hostPath: dir }],
      'test-group',
      true,
    );
    expect(results).toHaveLength(1);
    expect(results[0].containerPath).toBe('/workspace/extra/myproject');
  });

  it('INVARIANT: empty mounts list returns empty array', () => {
    writeAllowlist(makeAllowlist());
    expect(validateAdditionalMounts([], 'test-group', true)).toEqual([]);
  });

  it('INVARIANT: all mounts rejected when no allowlist exists', () => {
    const dir = path.join(tmpDir, 'project');
    fs.mkdirSync(dir);
    const results = validateAdditionalMounts(
      [{ hostPath: dir }],
      'test-group',
      true,
    );
    expect(results).toEqual([]);
  });
});

// generateAllowlistTemplate

describe('generateAllowlistTemplate', () => {
  it('INVARIANT: template is valid JSON', () => {
    const template = generateAllowlistTemplate();
    expect(() => JSON.parse(template)).not.toThrow();
  });

  it('INVARIANT: template contains required fields', () => {
    const parsed = JSON.parse(generateAllowlistTemplate());
    expect(parsed).toHaveProperty('allowedRoots');
    expect(parsed).toHaveProperty('blockedPatterns');
    expect(parsed).toHaveProperty('nonMainReadOnly');
    expect(Array.isArray(parsed.allowedRoots)).toBe(true);
    expect(parsed.allowedRoots.length).toBeGreaterThan(0);
  });
});
