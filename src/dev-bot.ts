/**
 * Dev Bot Identity — manages the single dev bot for Phase 1.
 *
 * The dev bot has a persona and can be claimed by one case at a time.
 * When claimed, messages @mentioning the bot are routed to the case's
 * container via IPC. Phase 2 will add a pool of dev bots.
 */
import { logger } from './logger.js';

export interface DevBotConfig {
  /** Internal ID (e.g., "dev_bot_1") */
  id: string;
  /** Display name shown in Telegram (e.g., "DevAda") */
  displayName: string;
  /** Short persona description included in the agent's system prompt */
  persona: string;
}

export interface DevBotClaim {
  /** Bot config */
  bot: DevBotConfig;
  /** Case ID that claimed this bot */
  caseId: string;
  /** Case name */
  caseName: string;
  /** When the bot was claimed */
  claimedAt: Date;
}

// Default dev bot for Phase 1 (single bot, no pool)
const DEFAULT_DEV_BOT: DevBotConfig = {
  id: 'dev_bot_1',
  displayName: 'DevAda',
  persona:
    'You are DevAda, a dev agent working on NanoClaw improvements. ' +
    'You work autonomously in a container, cloning code from read-only mounts. ' +
    'Your output is GitHub PRs. You can communicate with the admin via Telegram.',
};

// Current claim state (Phase 1: single bot, so just one slot)
let currentClaim: DevBotClaim | null = null;

/** Get the dev bot configuration. */
export function getDevBot(): DevBotConfig {
  return DEFAULT_DEV_BOT;
}

/** Check if the dev bot is available (not claimed). */
export function isDevBotAvailable(): boolean {
  return currentClaim === null;
}

/** Get the current claim, if any. */
export function getDevBotClaim(): DevBotClaim | null {
  return currentClaim;
}

/**
 * Claim the dev bot for a case.
 * Returns the bot config on success, or null if already claimed.
 */
export function claimDevBot(
  caseId: string,
  caseName: string,
): DevBotConfig | null {
  if (currentClaim !== null) {
    logger.warn(
      {
        caseId,
        existingCaseId: currentClaim.caseId,
        existingCaseName: currentClaim.caseName,
      },
      'Dev bot already claimed',
    );
    return null;
  }

  currentClaim = {
    bot: DEFAULT_DEV_BOT,
    caseId,
    caseName,
    claimedAt: new Date(),
  };

  logger.info(
    { caseId, caseName, botName: DEFAULT_DEV_BOT.displayName },
    'Dev bot claimed',
  );

  return DEFAULT_DEV_BOT;
}

/**
 * Release the dev bot from its current claim.
 * Only the claiming case can release it (or force release).
 */
export function releaseDevBot(caseId: string, force = false): boolean {
  if (currentClaim === null) return true;

  if (currentClaim.caseId !== caseId && !force) {
    logger.warn(
      {
        requestedBy: caseId,
        claimedBy: currentClaim.caseId,
      },
      'Cannot release dev bot — claimed by different case',
    );
    return false;
  }

  logger.info(
    {
      caseId: currentClaim.caseId,
      caseName: currentClaim.caseName,
      botName: DEFAULT_DEV_BOT.displayName,
      duration: Date.now() - currentClaim.claimedAt.getTime(),
    },
    'Dev bot released',
  );

  currentClaim = null;
  return true;
}

/**
 * Check if a message sender name matches the dev bot.
 * Used for routing incoming messages to the dev session.
 */
export function isDevBotMention(text: string): boolean {
  const botName = DEFAULT_DEV_BOT.displayName.toLowerCase();
  const lowerText = text.toLowerCase();
  return (
    lowerText.includes(`@${botName}`) || lowerText.startsWith(`${botName}:`)
  );
}

/** @internal — for tests only. Reset claim state. */
export function _resetDevBot(): void {
  currentClaim = null;
}
