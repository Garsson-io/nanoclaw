/**
 * Message Dispatch — pure decision logic for message processing.
 *
 * Extracted from index.ts processGroupMessages to make the trigger-to-outcome
 * wiring testable. This module answers: "Given these messages and this state,
 * what should the system do?" — without executing the decision.
 *
 * Addresses kaizen #173 (trigger-to-outcome test harness) and
 * kaizen #174 (dev session activation tests).
 */
import type { Case } from './cases.js';
import type { NewMessage, RegisteredGroup } from './types.js';
import type { RouterRequest, RouterResponse } from './router-types.js';
import type { SenderAllowlistConfig } from './sender-allowlist.js';
import { logger } from './logger.js';

// The possible outcomes of message dispatch
export type DispatchAction =
  | { type: 'skip'; reason: string }
  | {
      type: 'status_command';
      activeCases: Case[];
      suggestedCases: Case[];
      lastTimestamp: string;
    }
  | { type: 'direct_answer'; text: string; lastTimestamp: string }
  | {
      type: 'dev_session';
      targetCase: Case;
      prompt: string;
      lastTimestamp: string;
    }
  | {
      type: 'run_container';
      targetCase: Case | undefined;
      prompt: string;
      devMode: boolean;
      lastTimestamp: string;
    };

export interface DispatchInput {
  chatJid: string;
  group: RegisteredGroup;
  isMainGroup: boolean;
  messages: NewMessage[];
  triggerPattern: RegExp;
  assistantName: string;
  timezone: string;
}

export interface DispatchDeps {
  loadSenderAllowlist: () => SenderAllowlistConfig;
  isTriggerAllowed: (
    chatJid: string,
    sender: string,
    config: SenderAllowlistConfig,
  ) => boolean;
  shouldAutoTrigger: (
    sender: string,
    content: string,
    config: SenderAllowlistConfig,
  ) => boolean;
  detectDevSafeWord: (
    content: string,
    groupSafeWords?: string[],
  ) => { found: boolean; strippedContent: string };
  getActiveCases: (chatJid: string) => Case[];
  getRoutableCases: (chatJid: string) => Case[];
  getSuggestedCases: (chatJid: string) => Case[];
  getCaseById: (id: string) => Case | undefined;
  formatMessages: (msgs: NewMessage[], tz: string) => string;
  routeMessage: (req: RouterRequest) => Promise<RouterResponse>;
}

/**
 * Resolve what action to take for a batch of messages.
 *
 * This is a pure decision function — it reads state and returns a decision,
 * but does not execute side effects (no messages sent, no files written,
 * no containers spawned).
 *
 * Note: may mutate message content when stripping safe words, matching
 * the existing behavior in processGroupMessages.
 */
export async function resolveDispatch(
  input: DispatchInput,
  deps: DispatchDeps,
): Promise<DispatchAction> {
  const { chatJid, group, isMainGroup, messages, triggerPattern, timezone } =
    input;

  if (messages.length === 0) {
    return { type: 'skip', reason: 'no messages' };
  }

  const lastTimestamp = messages[messages.length - 1].timestamp;

  // Step 1: Trigger check (non-main groups only)
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = deps.loadSenderAllowlist();
    const hasTrigger = messages.some(
      (m) =>
        (triggerPattern.test(m.content.trim()) &&
          (m.is_from_me ||
            deps.isTriggerAllowed(chatJid, m.sender, allowlistCfg))) ||
        deps.shouldAutoTrigger(m.sender, m.content, allowlistCfg),
    );
    if (!hasTrigger) {
      return { type: 'skip', reason: 'no trigger in non-main group' };
    }
  }

  // Step 2: Safe word detection
  const groupSafeWords = group.containerConfig?.devSafeWords;
  let devModeRequested = false;
  for (const msg of messages) {
    const result = deps.detectDevSafeWord(msg.content, groupSafeWords);
    if (result.found) {
      devModeRequested = true;
      msg.content = result.strippedContent;
      logger.info(
        { chatJid, sender: msg.sender_name || msg.sender },
        'Dev safe word detected — escalating to dev mode',
      );
      break;
    }
  }

  // Step 3: Case routing
  const activeCases = deps.getActiveCases(chatJid);
  let targetCase: Case | undefined;

  if (activeCases.length > 0) {
    const lastMsg = messages[messages.length - 1].content.trim();

    // Status command
    if (/^(status|cases|tasks)\b/i.test(lastMsg)) {
      const suggestedCases = deps.getSuggestedCases(chatJid);
      return {
        type: 'status_command',
        activeCases,
        suggestedCases,
        lastTimestamp,
      };
    }

    // Route message to a case
    const routableCases = deps.getRoutableCases(chatJid);

    if (routableCases.length >= 2) {
      const lastMsgText = messages[messages.length - 1].content;
      const senderName =
        messages[messages.length - 1].sender_name ||
        messages[messages.length - 1].sender;

      try {
        const routerRequest: RouterRequest = {
          type: 'route',
          requestId: `route-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          messageText: lastMsgText,
          senderName,
          groupFolder: group.folder,
          cases: routableCases.map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type,
            status: c.status,
            description: c.description,
            lastMessage: c.last_message,
            lastActivityAt: c.last_activity_at,
          })),
        };

        const routerResponse = await deps.routeMessage(routerRequest);

        if (
          routerResponse.decision === 'direct_answer' &&
          routerResponse.directAnswer
        ) {
          return {
            type: 'direct_answer',
            text: routerResponse.directAnswer,
            lastTimestamp,
          };
        } else if (
          routerResponse.decision === 'route_to_case' &&
          routerResponse.caseId
        ) {
          targetCase = deps.getCaseById(routerResponse.caseId) || undefined;
          logger.info(
            {
              caseId: routerResponse.caseId,
              caseName: routerResponse.caseName,
              confidence: routerResponse.confidence,
            },
            'Message routed to case via router',
          );
        }
        // suggest_new: targetCase remains undefined
      } catch (routerErr) {
        logger.warn(
          { err: routerErr },
          'Container router failed, dispatching without case context',
        );
      }
    } else if (routableCases.length === 1) {
      targetCase = routableCases[0];
    }
  }

  const prompt = deps.formatMessages(messages, timezone);

  // Step 4: Dev session activation
  if (devModeRequested && targetCase?.type === 'dev') {
    return { type: 'dev_session', targetCase, prompt, lastTimestamp };
  }

  // Step 5: Regular container
  return {
    type: 'run_container',
    targetCase,
    prompt,
    devMode: devModeRequested,
    lastTimestamp,
  };
}
