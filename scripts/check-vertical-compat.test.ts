/**
 * Tests for the vertical compatibility checker.
 *
 * INVARIANT: A vertical that only uses surfaces present in the contract
 * must report as compatible. A vertical that uses a removed/missing surface
 * must report as breaking.
 */
import { describe, it, expect } from 'vitest';
import { checkCompat } from './check-vertical-compat.js';

const baseContract = {
  contractVersion: 1,
  surfaces: {
    mcpTools: ['send_message', 'send_image', 'schedule_task', 'create_case'],
    ipcTypes: ['message', 'image', 'schedule_task', 'case_create'],
    mountPaths: ['/workspace/group', '/workspace/ipc', '/workspace/project'],
    envVars: ['TZ', 'NANOCLAW_CASE_ID', 'HOME'],
    configSchema: {
      'config/escalation.yaml': 'Escalation policy',
      'config/materials.json': 'Materials config',
    },
    caseSyncAdapter: ['createCase', 'updateCase', 'closeCase', 'addComment'],
    containerRuntime: {
      baseImage: 'node:22-slim',
      systemPackages: [],
      pythonPackages: [],
      globalNpmPackages: [],
    },
  },
};

describe('checkCompat', () => {
  it('reports compatible when vertical uses a subset of available surfaces', () => {
    const compat = {
      name: 'test-vertical',
      minContractVersion: 1,
      uses: {
        mcpTools: ['send_message', 'send_image'],
        ipcTypes: ['message'],
        mountPaths: ['/workspace/group'],
        envVars: ['TZ'],
        configSchema: ['config/escalation.yaml'],
        caseSyncAdapter: ['createCase'],
      },
    };

    const result = checkCompat(compat, baseContract);
    expect(result.compatible).toBe(true);
    expect(result.breaking).toHaveLength(0);
  });

  it('reports compatible when vertical uses all available surfaces', () => {
    const compat = {
      name: 'test-vertical',
      minContractVersion: 1,
      uses: {
        mcpTools: [
          'send_message',
          'send_image',
          'schedule_task',
          'create_case',
        ],
        caseSyncAdapter: [
          'createCase',
          'updateCase',
          'closeCase',
          'addComment',
        ],
      },
    };

    const result = checkCompat(compat, baseContract);
    expect(result.compatible).toBe(true);
  });

  it('reports compatible when vertical declares no uses', () => {
    const compat = {
      name: 'minimal-vertical',
      minContractVersion: 1,
      uses: {},
    };

    const result = checkCompat(compat, baseContract);
    expect(result.compatible).toBe(true);
  });

  it('detects breaking when an MCP tool is missing', () => {
    const compat = {
      name: 'test-vertical',
      minContractVersion: 1,
      uses: {
        mcpTools: ['send_message', 'nonexistent_tool'],
      },
    };

    const result = checkCompat(compat, baseContract);
    expect(result.compatible).toBe(false);
    expect(result.breaking).toHaveLength(1);
    expect(result.breaking[0].surface).toBe('mcpTools');
    expect(result.breaking[0].details).toEqual(['nonexistent_tool']);
  });

  it('detects breaking when an IPC type is missing', () => {
    const compat = {
      name: 'test-vertical',
      minContractVersion: 1,
      uses: {
        ipcTypes: ['message', 'removed_type'],
      },
    };

    const result = checkCompat(compat, baseContract);
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].surface).toBe('ipcTypes');
    expect(result.breaking[0].details).toEqual(['removed_type']);
  });

  it('detects breaking when a mount path is missing', () => {
    const compat = {
      name: 'test-vertical',
      minContractVersion: 1,
      uses: {
        mountPaths: ['/workspace/group', '/workspace/removed'],
      },
    };

    const result = checkCompat(compat, baseContract);
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].surface).toBe('mountPaths');
  });

  it('detects breaking when an env var is missing', () => {
    const compat = {
      name: 'test-vertical',
      minContractVersion: 1,
      uses: {
        envVars: ['TZ', 'REMOVED_VAR'],
      },
    };

    const result = checkCompat(compat, baseContract);
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].surface).toBe('envVars');
  });

  it('detects breaking when a config schema file is missing', () => {
    const compat = {
      name: 'test-vertical',
      minContractVersion: 1,
      uses: {
        configSchema: ['config/escalation.yaml', 'config/removed.yaml'],
      },
    };

    const result = checkCompat(compat, baseContract);
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].surface).toBe('configSchema');
    expect(result.breaking[0].details).toEqual(['config/removed.yaml']);
  });

  it('detects breaking when a case sync adapter method is missing', () => {
    const compat = {
      name: 'test-vertical',
      minContractVersion: 1,
      uses: {
        caseSyncAdapter: ['createCase', 'deletedMethod'],
      },
    };

    const result = checkCompat(compat, baseContract);
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].details).toEqual(['deletedMethod']);
  });

  it('detects breaking when contract version is too low', () => {
    const compat = {
      name: 'test-vertical',
      minContractVersion: 5,
      uses: {},
    };

    const result = checkCompat(compat, baseContract);
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].surface).toBe('contractVersion');
    expect(result.breaking[0].type).toBe('version');
  });

  it('reports multiple breaking changes across surfaces', () => {
    const compat = {
      name: 'test-vertical',
      minContractVersion: 1,
      uses: {
        mcpTools: ['send_message', 'removed_tool'],
        ipcTypes: ['message', 'removed_ipc'],
        envVars: ['TZ', 'REMOVED_VAR'],
      },
    };

    const result = checkCompat(compat, baseContract);
    expect(result.compatible).toBe(false);
    expect(result.breaking).toHaveLength(3);
    expect(result.breaking.map((b) => b.surface).sort()).toEqual([
      'envVars',
      'ipcTypes',
      'mcpTools',
    ]);
  });

  it('ignores surfaces the vertical does not declare', () => {
    // Vertical only uses mcpTools — doesn't care about IPC changes
    const compat = {
      name: 'test-vertical',
      minContractVersion: 1,
      uses: {
        mcpTools: ['send_message'],
      },
    };

    // Even if contract has fewer IPC types, it's still compatible
    const modifiedContract = {
      ...baseContract,
      surfaces: {
        ...baseContract.surfaces,
        ipcTypes: [], // all IPC types removed
      },
    };

    const result = checkCompat(compat, modifiedContract);
    expect(result.compatible).toBe(true);
  });
});
