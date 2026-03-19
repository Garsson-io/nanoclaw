/**
 * Dev Session Manager — manages persistent dev agent containers.
 *
 * Dev agents run as session-based containers: spawn on case activation,
 * stay alive for the session (up to 30 min), die on completion/timeout.
 * Code repos are mounted read-only; agent clones locally for writes.
 * Output is a GitHub PR, not files on the host.
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_NAME_PREFIX,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { ContainerOutputSchema } from './schemas.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import type { Case } from './cases.js';
import type { ContainerOutput } from './container-runner.js';

// Dev session timeout: 30 minutes max
export const DEV_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
// Idle timeout: 5 minutes without output
export const DEV_SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// Sentinel markers for output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface DevSessionConfig {
  /** The case this session is for */
  case: Case;
  /** The registered group (for mounts, config) */
  group: RegisteredGroup;
  /** Whether this is the main group */
  isMain: boolean;
  /** Chat JID to notify on session events */
  notifyChatJid: string;
  /** Dev bot display name (e.g., "DevAda") */
  botName: string;
  /** Initial prompt for the agent (describes the work to do) */
  initialPrompt: string;
}

export interface DevSession {
  /** Case ID */
  caseId: string;
  /** Case name */
  caseName: string;
  /** Container name */
  containerName: string;
  /** Container process (for monitoring) */
  process: ChildProcess;
  /** Group folder the session runs in */
  groupFolder: string;
  /** IPC directory for this session's group */
  ipcDir: string;
  /** Bot name used for this session */
  botName: string;
  /** Chat JID for notifications */
  notifyChatJid: string;
  /** When the session started */
  startedAt: Date;
  /** Whether the session has ended */
  ended: boolean;
  /** Session timeout handle */
  sessionTimeout: ReturnType<typeof setTimeout>;
  /** Idle timeout handle */
  idleTimeout: ReturnType<typeof setTimeout>;
  /** The latest session ID from the agent SDK */
  sdkSessionId?: string;
}

// Active dev sessions, keyed by case ID
const activeSessions = new Map<string, DevSession>();

/** Get the active dev session for a case, if any. */
export function getActiveDevSession(caseId: string): DevSession | undefined {
  return activeSessions.get(caseId);
}

/** Get all active dev sessions. */
export function getAllActiveDevSessions(): DevSession[] {
  return Array.from(activeSessions.values());
}

/** Find a dev session by bot name (for message routing). */
export function getDevSessionByBotName(
  botName: string,
): DevSession | undefined {
  for (const session of activeSessions.values()) {
    if (session.botName === botName && !session.ended) {
      return session;
    }
  }
  return undefined;
}

/** Find a dev session by container name. */
export function getDevSessionByContainerName(
  containerName: string,
): DevSession | undefined {
  for (const session of activeSessions.values()) {
    if (session.containerName === containerName) {
      return session;
    }
  }
  return undefined;
}

/**
 * Build container args for a dev session.
 * Dev sessions get read-only code mounts and clone inside the container.
 */
export function buildDevSessionContainerArgs(
  config: DevSessionConfig,
  containerName: string,
): { args: string[]; ipcDir: string } {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(config.group.folder);

  // Timezone
  args.push('-e', `TZ=${TIMEZONE}`);

  // Case context
  args.push('-e', `NANOCLAW_CASE_ID=${config.case.id}`);
  args.push('-e', `NANOCLAW_CASE_NAME=${config.case.name}`);
  args.push('-e', `NANOCLAW_CASE_TYPE=dev`);
  args.push('-e', 'NANOCLAW_DEV_MODE=1');
  args.push('-e', `NANOCLAW_BOT_NAME=${config.botName}`);
  args.push('-e', 'NANOCLAW_SESSION_MODE=dev');

  // GitHub credentials for pushing branches/creating PRs
  if (process.env.GITHUB_TOKEN) {
    args.push('-e', `GITHUB_TOKEN=${process.env.GITHUB_TOKEN}`);
    args.push('-e', `GH_TOKEN=${process.env.GITHUB_TOKEN}`);
  }

  // Anthropic API via credential proxy
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Project root — read-only (agent clones locally for writes)
  args.push(...readonlyMountArgs(projectRoot, '/workspace/project'));

  // Shadow .env
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    args.push(...readonlyMountArgs('/dev/null', '/workspace/project/.env'));
  }

  // Group folder (for CLAUDE.md, group memory)
  fs.mkdirSync(groupDir, { recursive: true });
  args.push('-v', `${groupDir}:/workspace/group`);

  // Global instructions
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    args.push(...readonlyMountArgs(globalDir, '/workspace/global'));
  }

  // Per-group Claude sessions directory
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    config.group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  args.push('-v', `${groupSessionsDir}:/home/node/.claude`);

  // Agent-runner source
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    config.group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  args.push('-v', `${groupAgentRunnerDir}:/app/src`);

  // IPC directory
  const groupIpcDir = resolveGroupIpcPath(config.group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  args.push('-v', `${groupIpcDir}:/workspace/ipc`);

  // Additional mounts (validated — read-only for non-main)
  if (config.group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      config.group.containerConfig.additionalMounts,
      config.group.name,
      config.isMain,
    );
    for (const mount of validatedMounts) {
      if (mount.readonly) {
        args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
      } else {
        args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
      }
    }
  }

  // Container image + dev entrypoint override
  args.push('--entrypoint', '/app/dev-entrypoint.sh');
  args.push(CONTAINER_IMAGE);

  return { args, ipcDir: groupIpcDir };
}

/**
 * Build the ContainerInput JSON for the dev session agent.
 * This is written to stdin and read by the agent-runner.
 */
export function buildDevSessionInput(config: DevSessionConfig): string {
  return JSON.stringify({
    prompt: config.initialPrompt,
    groupFolder: config.group.folder,
    chatJid: config.notifyChatJid,
    isMain: config.isMain,
    assistantName: config.botName,
    caseId: config.case.id,
    caseName: config.case.name,
    caseType: 'dev',
    devModeRequested: true,
  });
}

/**
 * Start a dev session container for a case.
 * The container stays alive, processing IPC messages until the case completes.
 */
export async function startDevSession(
  config: DevSessionConfig,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onSessionEnd?: (session: DevSession, reason: string) => void,
): Promise<DevSession> {
  // Prevent duplicate sessions for the same case
  if (activeSessions.has(config.case.id)) {
    throw new Error(
      `Dev session already active for case ${config.case.id} (${config.case.name})`,
    );
  }

  const safeName = config.group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `${CONTAINER_NAME_PREFIX}dev-${safeName}-${Date.now()}`;

  const { args, ipcDir } = buildDevSessionContainerArgs(config, containerName);

  logger.info(
    {
      caseId: config.case.id,
      caseName: config.case.name,
      containerName,
      botName: config.botName,
    },
    'Starting dev session container',
  );

  const container = spawn(CONTAINER_RUNTIME_BIN, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Write ContainerInput to stdin
  const inputJson = buildDevSessionInput(config);
  container.stdin.write(inputJson);
  container.stdin.end();

  // Create session object
  const session: DevSession = {
    caseId: config.case.id,
    caseName: config.case.name,
    containerName,
    process: container,
    groupFolder: config.group.folder,
    ipcDir,
    botName: config.botName,
    notifyChatJid: config.notifyChatJid,
    startedAt: new Date(),
    ended: false,
    sessionTimeout: setTimeout(() => {
      endDevSession(session, 'timeout');
    }, DEV_SESSION_TIMEOUT_MS),
    idleTimeout: setTimeout(() => {
      endDevSession(session, 'idle');
    }, DEV_SESSION_IDLE_TIMEOUT_MS),
  };

  activeSessions.set(config.case.id, session);

  // Parse stdout for output markers
  let parseBuffer = '';
  container.stdout.on('data', (data: Buffer) => {
    const chunk = data.toString();
    parseBuffer += chunk;

    let startIdx: number;
    while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
      const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
      if (endIdx === -1) break;

      const jsonStr = parseBuffer
        .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
        .trim();
      parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

      try {
        const parsed: ContainerOutput = ContainerOutputSchema.parse(
          JSON.parse(jsonStr),
        );
        if (parsed.newSessionId) {
          session.sdkSessionId = parsed.newSessionId;
        }
        // Reset idle timeout on output
        resetIdleTimeout(session);

        if (onOutput) {
          onOutput(parsed).catch((err) => {
            logger.error(
              { caseId: session.caseId, err },
              'Dev session output callback failed',
            );
          });
        }
      } catch (err) {
        logger.warn(
          { caseId: session.caseId, err },
          'Failed to parse dev session output',
        );
      }
    }
  });

  // Log stderr
  container.stderr.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line) logger.debug({ devSession: session.caseName }, line);
    }
  });

  // Handle container exit
  container.on('close', (code) => {
    const reason = code === 0 ? 'completed' : `exit-code-${code}`;
    cleanupSession(session, reason, onSessionEnd);
  });

  container.on('error', (err) => {
    logger.error(
      { caseId: session.caseId, containerName, err },
      'Dev session container error',
    );
    cleanupSession(session, `error: ${err.message}`, onSessionEnd);
  });

  return session;
}

/** Send a message to a running dev session via IPC. */
export function sendMessageToDevSession(
  session: DevSession,
  text: string,
): boolean {
  if (session.ended) return false;

  const inputDir = path.join(session.ipcDir, 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  const filename = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  fs.writeFileSync(
    path.join(inputDir, filename),
    JSON.stringify({ type: 'message', text }),
  );

  logger.info(
    { caseId: session.caseId, filename },
    'Sent IPC message to dev session',
  );
  return true;
}

/** Stop a dev session gracefully. */
export function stopDevSession(caseId: string, reason: string): void {
  const session = activeSessions.get(caseId);
  if (!session || session.ended) return;
  endDevSession(session, reason);
}

/** Reset the idle timeout (called on output). */
function resetIdleTimeout(session: DevSession): void {
  clearTimeout(session.idleTimeout);
  session.idleTimeout = setTimeout(() => {
    endDevSession(session, 'idle');
  }, DEV_SESSION_IDLE_TIMEOUT_MS);
}

/** End a dev session — write _close sentinel and stop container. */
function endDevSession(session: DevSession, reason: string): void {
  if (session.ended) return;
  session.ended = true;

  logger.info(
    { caseId: session.caseId, containerName: session.containerName, reason },
    'Ending dev session',
  );

  // Write _close sentinel so the agent loop exits cleanly
  const closePath = path.join(session.ipcDir, 'input', '_close');
  try {
    fs.writeFileSync(closePath, '');
  } catch {
    // IPC dir might not exist anymore
  }

  // Give the agent a few seconds to exit gracefully, then force-stop
  setTimeout(() => {
    exec(stopContainer(session.containerName), { timeout: 15000 }, (err) => {
      if (err) {
        logger.warn(
          { containerName: session.containerName, err },
          'Failed to stop dev session container (may have already exited)',
        );
      }
    });
  }, 5000);
}

/** Clean up session state after container exits. */
function cleanupSession(
  session: DevSession,
  reason: string,
  onSessionEnd?: (session: DevSession, reason: string) => void,
): void {
  session.ended = true;
  clearTimeout(session.sessionTimeout);
  clearTimeout(session.idleTimeout);
  activeSessions.delete(session.caseId);

  logger.info(
    {
      caseId: session.caseId,
      containerName: session.containerName,
      reason,
      duration: Date.now() - session.startedAt.getTime(),
    },
    'Dev session ended',
  );

  if (onSessionEnd) {
    try {
      onSessionEnd(session, reason);
    } catch (err) {
      logger.error(
        { caseId: session.caseId, err },
        'Dev session end callback failed',
      );
    }
  }
}

/** @internal — for tests only. Clear all active sessions. */
export function _clearActiveSessions(): void {
  for (const session of activeSessions.values()) {
    clearTimeout(session.sessionTimeout);
    clearTimeout(session.idleTimeout);
  }
  activeSessions.clear();
}
