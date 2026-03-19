/**
 * Dev Session Orchestrator — wires case lifecycle to dev session management.
 *
 * This module connects case status transitions to dev session operations:
 * - Case activated → claim bot, start session, notify admin
 * - Case done/blocked → stop session, release bot, notify admin
 *
 * Provides the public API for starting/stopping dev sessions from
 * the case lifecycle (ipc-cases.ts) and message routing (index.ts).
 */
import {
  claimDevBot,
  releaseDevBot,
  getDevBot,
  isDevBotAvailable,
} from './dev-bot.js';
import {
  startDevSession,
  stopDevSession,
  getActiveDevSession,
  type DevSessionConfig,
  type DevSession,
} from './dev-session.js';
import {
  notifySessionStarted,
  notifySessionCompleted,
  type DevRouterDeps,
} from './dev-session-router.js';
import type { Case } from './cases.js';
import type { RegisteredGroup } from './types.js';
import type { ContainerOutput } from './container-runner.js';
import { logger } from './logger.js';

export interface OrchestratorDeps extends DevRouterDeps {
  /** Get the registered group for the case's group folder */
  getGroupByFolder: (folder: string) => RegisteredGroup | undefined;
  /** Whether the group folder is the main group */
  isMainGroup: (folder: string) => boolean;
  /** Called when the dev session produces output (for usage tracking, etc.) */
  onOutput?: (caseId: string, output: ContainerOutput) => Promise<void>;
}

/**
 * Activate a dev session for a case.
 * Claims the dev bot, spawns a persistent container, and notifies the admin.
 *
 * Returns the session on success, or null with a reason on failure.
 */
export async function activateDevSession(
  c: Case,
  initialPrompt: string,
  deps: OrchestratorDeps,
): Promise<{ session: DevSession | null; error?: string }> {
  // Validate case type
  if (c.type !== 'dev') {
    return { session: null, error: 'Only dev cases can have dev sessions' };
  }

  // Check if session already exists
  const existing = getActiveDevSession(c.id);
  if (existing) {
    return { session: existing, error: undefined };
  }

  // Claim the dev bot
  const bot = claimDevBot(c.id, c.name);
  if (!bot) {
    return {
      session: null,
      error: 'Dev bot is busy with another case. Try again later.',
    };
  }

  // Get group config
  const group = deps.getGroupByFolder(c.group_folder);
  if (!group) {
    releaseDevBot(c.id);
    return {
      session: null,
      error: `Group not found for folder: ${c.group_folder}`,
    };
  }

  const isMain = deps.isMainGroup(c.group_folder);

  const config: DevSessionConfig = {
    case: c,
    group,
    isMain,
    notifyChatJid: c.chat_jid,
    botName: bot.displayName,
    initialPrompt,
  };

  try {
    const session = await startDevSession(
      config,
      // Output callback
      async (output) => {
        if (deps.onOutput) {
          await deps.onOutput(c.id, output);
        }
      },
      // Session end callback
      (endedSession, reason) => {
        handleSessionEnd(endedSession, reason, deps);
      },
    );

    // Notify admin that the dev session has started
    await notifySessionStarted(c.id, c.name, c.github_issue, deps).catch(
      (err) => {
        logger.error(
          { caseId: c.id, err },
          'Failed to send session start notification',
        );
      },
    );

    logger.info(
      {
        caseId: c.id,
        caseName: c.name,
        botName: bot.displayName,
        containerName: session.containerName,
      },
      'Dev session activated',
    );

    return { session };
  } catch (err) {
    releaseDevBot(c.id);
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ caseId: c.id, err }, 'Failed to start dev session');
    return { session: null, error: message };
  }
}

/**
 * Deactivate a dev session for a case.
 * Stops the container, releases the bot, and notifies the admin.
 */
export async function deactivateDevSession(
  caseId: string,
  reason: string,
  deps: DevRouterDeps,
): Promise<void> {
  stopDevSession(caseId, reason);
  releaseDevBot(caseId);

  await notifySessionCompleted(caseId, reason, deps).catch((err) => {
    logger.error(
      { caseId, err },
      'Failed to send session completion notification',
    );
  });
}

/** Called when a session ends (container exit, timeout, etc.) */
function handleSessionEnd(
  session: DevSession,
  reason: string,
  deps: DevRouterDeps,
): void {
  releaseDevBot(session.caseId);

  // Fire notification (non-blocking)
  notifySessionCompleted(session.caseId, reason, deps).catch((err) => {
    logger.error(
      { caseId: session.caseId, err },
      'Failed to send session end notification',
    );
  });

  logger.info(
    {
      caseId: session.caseId,
      botName: session.botName,
      reason,
    },
    'Dev session deactivated',
  );
}

/** Check if a dev session can be started (bot available, etc.) */
export function canStartDevSession(): { available: boolean; reason?: string } {
  const bot = getDevBot();

  if (!isDevBotAvailable()) {
    return {
      available: false,
      reason: `Dev bot ${bot.displayName} is busy with another case`,
    };
  }

  return { available: true };
}
