#!/usr/bin/env tsx
/**
 * Check vertical compatibility against the harness contract.
 *
 * Compares a vertical's nanoclaw-compat.json against contract.json to
 * determine if an update is safe or breaking.
 *
 * Usage:
 *   npx tsx scripts/check-vertical-compat.ts <path-to-nanoclaw-compat.json>
 *   npx tsx scripts/check-vertical-compat.ts <path-to-nanoclaw-compat.json> <path-to-contract.json>
 *
 * Exit codes:
 *   0 — compatible (safe to update)
 *   1 — breaking changes detected
 *   2 — invalid input (missing files, bad schema)
 */
import fs from 'fs';
import path from 'path';

interface CompatFile {
  name: string;
  minContractVersion: number;
  uses: {
    mcpTools?: string[];
    ipcTypes?: string[];
    mountPaths?: string[];
    envVars?: string[];
    configSchema?: string[];
    caseSyncAdapter?: string[];
  };
}

interface Contract {
  contractVersion: number;
  surfaces: {
    mcpTools: string[];
    ipcTypes: string[];
    mountPaths: string[];
    envVars: string[];
    configSchema: Record<string, string>;
    caseSyncAdapter: string[];
    containerRuntime: unknown;
  };
}

interface BreakingChange {
  surface: string;
  type: 'removed' | 'version';
  details: string[];
}

export function checkCompat(
  compat: CompatFile,
  contract: Contract,
): { compatible: boolean; breaking: BreakingChange[] } {
  const breaking: BreakingChange[] = [];

  // Check contract version
  if (contract.contractVersion < compat.minContractVersion) {
    breaking.push({
      surface: 'contractVersion',
      type: 'version',
      details: [
        `Vertical requires contractVersion >= ${compat.minContractVersion}, harness has ${contract.contractVersion}`,
      ],
    });
  }

  // Check each surface the vertical declares it uses
  const arraySurfaces: Array<{
    key: keyof CompatFile['uses'];
    contractKey: keyof Contract['surfaces'];
  }> = [
    { key: 'mcpTools', contractKey: 'mcpTools' },
    { key: 'ipcTypes', contractKey: 'ipcTypes' },
    { key: 'mountPaths', contractKey: 'mountPaths' },
    { key: 'envVars', contractKey: 'envVars' },
    { key: 'caseSyncAdapter', contractKey: 'caseSyncAdapter' },
  ];

  for (const { key, contractKey } of arraySurfaces) {
    const used = compat.uses[key];
    if (!used || used.length === 0) continue;

    const available = contract.surfaces[contractKey];
    if (!Array.isArray(available)) continue;

    const availableSet = new Set(available);
    const missing = used.filter((item) => !availableSet.has(item));

    if (missing.length > 0) {
      breaking.push({
        surface: key,
        type: 'removed',
        details: missing,
      });
    }
  }

  // Check configSchema separately (it's an object, not an array)
  const usedConfigs = compat.uses.configSchema;
  if (usedConfigs && usedConfigs.length > 0) {
    const availableConfigs = new Set(
      Object.keys(contract.surfaces.configSchema),
    );
    const missing = usedConfigs.filter((c) => !availableConfigs.has(c));
    if (missing.length > 0) {
      breaking.push({
        surface: 'configSchema',
        type: 'removed',
        details: missing,
      });
    }
  }

  return {
    compatible: breaking.length === 0,
    breaking,
  };
}

// CLI entry point
if (
  process.argv[1] &&
  path.basename(process.argv[1]).includes('check-vertical-compat')
) {
  const compatPath = process.argv[2];
  if (!compatPath) {
    console.error(
      'Usage: check-vertical-compat.ts <nanoclaw-compat.json> [contract.json]',
    );
    process.exit(2);
  }

  const contractPath =
    process.argv[3] || path.join(import.meta.dirname, '..', 'contract.json');

  let compat: CompatFile;
  let contract: Contract;

  try {
    compat = JSON.parse(fs.readFileSync(compatPath, 'utf-8'));
  } catch {
    console.error(`Failed to read compat file: ${compatPath}`);
    process.exit(2);
  }

  try {
    contract = JSON.parse(fs.readFileSync(contractPath, 'utf-8'));
  } catch {
    console.error(`Failed to read contract file: ${contractPath}`);
    process.exit(2);
  }

  const result = checkCompat(compat, contract);

  if (result.compatible) {
    console.log(
      `${compat.name}: compatible with contract v${contract.contractVersion}`,
    );
    process.exit(0);
  } else {
    console.error(
      `${compat.name}: BREAKING CHANGES detected against contract v${contract.contractVersion}`,
    );
    for (const b of result.breaking) {
      if (b.type === 'version') {
        console.error(`  ${b.surface}: ${b.details[0]}`);
      } else {
        console.error(`  ${b.surface}: missing ${b.details.join(', ')}`);
      }
    }
    process.exit(1);
  }
}
