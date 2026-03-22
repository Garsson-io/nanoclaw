/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { CONTAINER_NAME_PREFIX } from './config.js';
import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    const stderr =
      err instanceof Error && 'stderr' in err
        ? Buffer.isBuffer((err as { stderr: unknown }).stderr)
          ? (err as { stderr: Buffer }).stderr.toString().trim()
          : String((err as { stderr: unknown }).stderr).trim()
        : undefined;
    logger.error(
      { reason: stderr || (err instanceof Error ? err.message : String(err)) },
      'Failed to reach container runtime',
    );
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/**
 * Advisory check: warn if Docker image count exceeds the soft cap.
 * The soft cap is based on active case count + 1 stable work container,
 * with 2 slots (current + previous) each.
 *
 * Also warns about dangling images (orphaned by builds without rotation).
 */
export function checkImageAdvisory(): void {
  try {
    // Count tagged nanoclaw-agent images
    const tagOutput = execSync(
      `${CONTAINER_RUNTIME_BIN} images nanoclaw-agent --format '{{.Tag}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const tags = tagOutput
      .trim()
      .split('\n')
      .filter((t) => t && t !== '<none>');
    const taggedCount = tags.length;

    // Count dangling images
    const danglingOutput = execSync(
      `${CONTAINER_RUNTIME_BIN} images --filter "dangling=true" --format '{{.ID}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const danglingCount = danglingOutput
      .trim()
      .split('\n')
      .filter(Boolean).length;

    if (danglingCount > 3) {
      logger.warn(
        { danglingCount },
        `${danglingCount} dangling Docker images detected. Run ./container/gc.sh --force to clean up.`,
      );
    }

    if (taggedCount > 0) {
      logger.info(
        { taggedCount, tags },
        `Docker images: ${taggedCount} tagged nanoclaw-agent images`,
      );
    }

    // Soft cap advisory: warn if we have many branch slots
    // We consider > 10 tagged images as a heuristic threshold
    // (a more precise check would query the case DB, but we keep this lightweight)
    if (taggedCount > 10) {
      logger.warn(
        { taggedCount },
        `${taggedCount} tagged images exceeds recommended limit. Run ./container/gc.sh to review.`,
      );
    }
  } catch {
    // Docker not available or query failed — skip advisory silently
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=${CONTAINER_NAME_PREFIX} --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn(
      { reason: err instanceof Error ? err.message : String(err) },
      'Failed to clean up orphaned containers',
    );
  }
}
