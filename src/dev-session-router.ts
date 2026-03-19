/**
 * Dev Session Router — routes messages to/from dev agent sessions.
 *
 * When the admin sends a message that @mentions the dev bot (or replies
 * to it), this module routes it to the active dev session's container
 * via IPC. It also handles notifications from dev sessions back to
 * the admin via Telegram.
 */
import { getDevBotClaim, isDevBotMention } from './dev-bot.js';
import { getActiveDevSession, sendMessageToDevSession } from './dev-session.js';
import { logger } from './logger.js';

export interface DevRouterDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendPoolMessage?: (
    jid: string,
    text: string,
    sender: string,
    groupFolder: string,
  ) => Promise<boolean>;
}

/**
 * Try to route an incoming message to a dev session.
 * Returns true if the message was routed, false if it should be
 * handled normally (no active dev session or not addressed to dev bot).
 */
export function tryRouteToDevSession(
  text: string,
  chatJid: string,
  senderName: string,
): boolean {
  // Check if the message mentions the dev bot
  if (!isDevBotMention(text)) {
    return false;
  }

  // Check if there's an active claim
  const claim = getDevBotClaim();
  if (!claim) {
    logger.debug(
      { text: text.slice(0, 100) },
      'Dev bot mentioned but no active claim',
    );
    return false;
  }

  // Check if there's an active session for the claimed case
  const session = getActiveDevSession(claim.caseId);
  if (!session || session.ended) {
    logger.warn(
      { caseId: claim.caseId },
      'Dev bot claimed but no active session',
    );
    return false;
  }

  // Route the message to the dev session via IPC
  const routedText = `[from ${senderName}] ${text}`;
  const sent = sendMessageToDevSession(session, routedText);

  if (sent) {
    logger.info(
      {
        caseId: session.caseId,
        botName: session.botName,
        senderName,
        textLength: text.length,
      },
      'Message routed to dev session',
    );
  }

  return sent;
}

/**
 * Send a notification from a dev session to the admin.
 * Uses pool bot routing if available (so the message appears from the dev bot).
 */
export async function notifyFromDevSession(
  caseId: string,
  text: string,
  deps: DevRouterDeps,
): Promise<void> {
  const session = getActiveDevSession(caseId);
  if (!session) {
    logger.warn({ caseId }, 'Cannot notify — no active dev session');
    return;
  }

  const claim = getDevBotClaim();
  const botName = claim?.bot.displayName ?? session.botName;
  const prefixedText = `[${botName}] ${text}`;

  // Try pool bot routing first (sends as the dev bot identity in Telegram)
  if (deps.sendPoolMessage && session.notifyChatJid.startsWith('tg:')) {
    const sent = await deps.sendPoolMessage(
      session.notifyChatJid,
      text,
      botName,
      session.groupFolder,
    );
    if (sent) {
      logger.info(
        { caseId, botName, chatJid: session.notifyChatJid },
        'Dev session notification sent via pool bot',
      );
      return;
    }
  }

  // Fallback: send as regular message with bot name prefix
  await deps.sendMessage(session.notifyChatJid, prefixedText);
  logger.info(
    { caseId, botName, chatJid: session.notifyChatJid },
    'Dev session notification sent (fallback)',
  );
}

/**
 * Send a "session started" notification.
 */
export async function notifySessionStarted(
  caseId: string,
  caseName: string,
  githubIssue: number | null,
  deps: DevRouterDeps,
): Promise<void> {
  const issueRef = githubIssue ? ` (kaizen #${githubIssue})` : '';
  await notifyFromDevSession(
    caseId,
    `Starting work on ${caseName}${issueRef}. I'll update you when I have a PR.`,
    deps,
  );
}

/**
 * Send a "session completed" notification.
 */
export async function notifySessionCompleted(
  caseId: string,
  reason: string,
  deps: DevRouterDeps,
): Promise<void> {
  await notifyFromDevSession(caseId, `Session ended: ${reason}`, deps);
}
