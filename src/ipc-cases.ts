/**
 * Case IPC handlers — processes case lifecycle events from container agents.
 *
 * Architecture:
 *   Container (MCP tools) → IPC files → Host (ipc.ts dispatcher) → this module
 *   This module handles all `case_*` IPC types and delegates to:
 *     - cases.ts for SQLite operations (primary store)
 *     - case-backend.ts for cloud sync (GitHub Issues V1, swappable)
 *     - case-auth.ts for authorization decisions
 *     - github-api.ts for dev case issue creation (kaizen repo)
 *
 * Separation of concerns:
 *   - ipc.ts: dispatch routing, file watching, non-case IPC
 *   - ipc-cases.ts (this file): case lifecycle business logic
 *   - case-backend.ts + case-backend-github.ts: cloud backend adapter
 *   - cases.ts: data model and SQLite operations
 */

import fs from 'fs';
import path from 'path';

import { authorizeCaseCreation } from './case-auth.js';
import { getCaseSyncService } from './case-backend.js';
import { DATA_DIR } from './config.js';
import {
  createCaseWorkspace,
  generateCaseId,
  generateCaseName,
  getActiveCasesByGithubIssue,
  getCaseById,
  insertCase,
  pruneCaseWorkspace,
  removeWorktreeLock,
  suggestDevCase,
  updateCase,
  updateWorktreeLockHeartbeat,
} from './cases.js';
import type { Case } from './cases.js';
import { createGitHubIssue, DEV_CASE_ISSUE_REPO } from './github-api.js';
import { logger } from './logger.js';
import type { IpcDeps } from './ipc.js';
import type { RegisteredGroup } from './types.js';

/**
 * Handle a case-related IPC task. Returns true if handled, false if not a case type.
 */
export async function processCaseIpc(
  data: { type: string; caseId?: string; [key: string]: unknown },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<boolean> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'case_mark_done':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          if (caseItem.worktree_path) {
            removeWorktreeLock(caseItem.worktree_path);
          }
          updateCase(data.caseId, {
            status: 'done',
            done_at: new Date().toISOString(),
            last_activity_at: new Date().toISOString(),
            conclusion: (data.conclusion as string) || null,
            last_message: (data.conclusion as string) || caseItem.last_message,
          });
          logger.info(
            { caseId: data.caseId, sourceGroup },
            'Case marked done via IPC',
          );
        }
      }
      return true;

    case 'case_mark_blocked':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          updateCase(data.caseId, {
            status: 'blocked',
            blocked_on: (data.blocked_on as string) || 'user',
            last_activity_at: new Date().toISOString(),
          });
          logger.info(
            { caseId: data.caseId, sourceGroup },
            'Case marked blocked via IPC',
          );
        }
      }
      return true;

    case 'case_mark_active':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          updateCase(data.caseId, {
            status: 'active',
            blocked_on: null,
            last_activity_at: new Date().toISOString(),
          });
          logger.info(
            { caseId: data.caseId, sourceGroup },
            'Case marked active via IPC',
          );
        }
      }
      return true;

    case 'case_mark_reviewed':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          if (caseItem.status !== 'done') {
            logger.warn(
              { caseId: data.caseId, status: caseItem.status },
              'Cannot review case — not in done status',
            );
          } else {
            updateCase(data.caseId, {
              status: 'reviewed',
              reviewed_at: new Date().toISOString(),
              last_activity_at: new Date().toISOString(),
            });
            logger.info(
              { caseId: data.caseId, sourceGroup },
              'Case marked reviewed via IPC',
            );
          }
        }
      }
      return true;

    case 'case_prune':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          try {
            pruneCaseWorkspace(caseItem);
            updateCase(data.caseId, {
              status: 'pruned',
              pruned_at: new Date().toISOString(),
              last_activity_at: new Date().toISOString(),
            });
            logger.info(
              { caseId: data.caseId, sourceGroup },
              'Case pruned via IPC — workspace removed',
            );
          } catch (pruneErr) {
            logger.warn(
              { caseId: data.caseId, err: pruneErr },
              'Case prune refused — status guard or lock prevented deletion',
            );
          }
        }
      }
      return true;

    case 'case_add_comment':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          const text = (data.text as string) || '';
          const author = (data.author as string) || 'agent';

          updateCase(data.caseId, {
            last_activity_at: new Date().toISOString(),
            last_message: text.slice(0, 200),
          });

          const syncService = getCaseSyncService();
          if (syncService) {
            syncService
              .onCaseMutated({
                type: 'comment',
                case: caseItem,
                comment: { text, author },
              })
              .catch(() => {});
          }

          logger.info(
            { caseId: data.caseId, author, sourceGroup },
            'Case comment added via IPC',
          );
        }
      }
      return true;

    case 'case_update_activity':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          const updates: Record<string, unknown> = {
            last_activity_at: new Date().toISOString(),
          };
          if (data.last_message) {
            updates.last_message = data.last_message;
          }
          updateCase(data.caseId, updates as Parameters<typeof updateCase>[1]);
        }
      }
      return true;

    case 'case_create':
      await handleCaseCreate(data, sourceGroup, isMain, deps, registeredGroups);
      return true;

    case 'case_suggest_dev':
      handleCaseSuggestDev(data, sourceGroup, deps, registeredGroups);
      return true;

    case 'case_heartbeat':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          if (caseItem.worktree_path) {
            updateWorktreeLockHeartbeat(caseItem.worktree_path);
          }
          updateCase(data.caseId, {
            last_activity_at: new Date().toISOString(),
          });
          logger.debug(
            { caseId: data.caseId, sourceGroup },
            'Case heartbeat updated',
          );
        }
      }
      return true;

    case 'case_unlock':
      if (data.caseId) {
        const caseItem = getCaseById(data.caseId);
        if (caseItem && (isMain || caseItem.group_folder === sourceGroup)) {
          if (caseItem.worktree_path) {
            removeWorktreeLock(caseItem.worktree_path);
            logger.info(
              { caseId: data.caseId, sourceGroup },
              'Case worktree unlocked via IPC',
            );
          }
        }
      }
      return true;

    default:
      return false;
  }
}

async function handleCaseCreate(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  registeredGroups: Record<string, RegisteredGroup>,
): Promise<void> {
  const d = data as unknown as {
    description: string;
    context?: string;
    shortName?: string;
    caseType?: string;
    chatJid?: string;
    initiator?: string;
    githubIssue?: number;
  };
  if (!d.description) {
    logger.warn({ sourceGroup }, 'case_create missing description');
    return;
  }

  if (d.githubIssue) {
    const existing = getActiveCasesByGithubIssue(d.githubIssue);
    if (existing.length > 0) {
      const names = existing.map((c) => c.name).join(', ');
      logger.warn(
        { githubIssue: d.githubIssue, existingCases: names, sourceGroup },
        `Kaizen #${d.githubIssue} already has active case(s): ${names}`,
      );
      const warnJid =
        d.chatJid ||
        Object.entries(registeredGroups).find(
          ([, g]) => g.folder === sourceGroup,
        )?.[0];
      if (warnJid) {
        deps
          .sendMessage(
            warnJid,
            `⚠️ Kaizen #${d.githubIssue} already has active case(s): ${names}. Creating another anyway.`,
          )
          .catch(() => {});
      }
    }
  }

  const requestedType = d.caseType === 'dev' ? 'dev' : 'work';
  const authDecision = authorizeCaseCreation({
    requestedType,
    description: d.description,
    sourceGroup,
    isMain,
  });

  const { caseType, autoPromoted } = authDecision;
  const id = generateCaseId();
  const name = generateCaseName(d.description, d.shortName);
  const now = new Date().toISOString();

  const resolvedChatJid =
    d.chatJid ||
    Object.entries(registeredGroups).find(
      ([, g]) => g.folder === sourceGroup,
    )?.[0] ||
    '';

  // Unauthorized dev case → route through approval gate
  if (authDecision.status === 'suggested') {
    const suggested = suggestDevCase({
      groupFolder: sourceGroup,
      chatJid: resolvedChatJid,
      description: autoPromoted
        ? `[auto-promoted work→dev] ${d.description}`
        : d.description,
      sourceWorkCaseId: 'direct-request',
      initiator: d.initiator || 'agent',
      initiatorChannel: undefined,
      githubIssue: d.githubIssue,
    });

    logger.info(
      {
        caseId: suggested.id,
        name: suggested.name,
        sourceGroup,
        autoPromoted,
        reason: authDecision.reason,
      },
      'Dev case routed to approval gate',
    );

    const resultDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'case_results');
    fs.mkdirSync(resultDir, { recursive: true });
    const resultFile = data.requestId
      ? `${data.requestId}.json`
      : `${suggested.id}.json`;
    fs.writeFileSync(
      path.join(resultDir, resultFile),
      JSON.stringify({
        id: suggested.id,
        name: suggested.name,
        workspace_path: '',
        github_issue: suggested.github_issue,
        issue_url: null,
        status: 'suggested',
        needs_approval: true,
      }),
    );

    const mainJid = Object.entries(registeredGroups).find(
      ([, g]) => g.isMain,
    )?.[0];
    if (mainJid) {
      deps
        .sendMessage(
          mainJid,
          `🔒 Dev case needs approval: ${suggested.name}\n${d.description.slice(0, 200)}\n(from: ${sourceGroup}${autoPromoted ? ', auto-promoted from work' : ''})\nReply "approve" to activate.`,
        )
        .catch(() => {});
    }
    return;
  }

  // Authorized case — create immediately
  let githubIssue = d.githubIssue ?? null;
  let issueUrl: string | null = null;
  if (caseType === 'dev' && !githubIssue) {
    const issueBody = d.context
      ? `## TL;DR\n\n${d.description}\n\n---\n\n## Details\n\n${d.context}\n\n---\n\n*Auto-created by dev case \`${name}\`*`
      : `${d.description}\n\n---\n*Auto-created by dev case \`${name}\`*`;
    const issueResult = await createGitHubIssue({
      owner: DEV_CASE_ISSUE_REPO.owner,
      repo: DEV_CASE_ISSUE_REPO.repo,
      title: d.description,
      body: issueBody,
      labels: ['kaizen'],
    });
    if (issueResult.success && issueResult.issueNumber) {
      githubIssue = issueResult.issueNumber;
      issueUrl = issueResult.issueUrl ?? null;
      logger.info(
        { caseId: id, issueNumber: githubIssue, issueUrl },
        'Auto-created GitHub issue for dev case',
      );
    } else {
      logger.warn(
        { caseId: id, error: issueResult.error },
        'Failed to auto-create GitHub issue for dev case (continuing without)',
      );
    }
  }

  const { workspacePath, worktreePath, branchName } = createCaseWorkspace(
    name,
    caseType,
    id,
  );

  const newCase: Case = {
    id,
    group_folder: sourceGroup,
    chat_jid: resolvedChatJid,
    name,
    description: d.description,
    type: caseType,
    status: 'active',
    blocked_on: null,
    worktree_path: worktreePath,
    workspace_path: workspacePath,
    branch_name: branchName,
    initiator: d.initiator || 'agent',
    initiator_channel: null,
    last_message: null,
    last_activity_at: now,
    conclusion: null,
    created_at: now,
    done_at: null,
    reviewed_at: null,
    pruned_at: null,
    total_cost_usd: 0,
    token_source: null,
    time_spent_ms: 0,
    github_issue: githubIssue,
    github_issue_url: issueUrl || null,
    customer_name: (data.customer_name as string) || null,
    customer_phone: (data.customer_phone as string) || null,
    customer_email: (data.customer_email as string) || null,
    customer_org: (data.customer_org as string) || null,
    priority: null,
    gap_type: null,
  };

  insertCase(newCase);
  logger.info(
    {
      caseId: id,
      name,
      caseType,
      sourceGroup,
      githubIssue,
      autoPromoted,
      reason: authDecision.reason,
    },
    'Case created via IPC',
  );

  const resultDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'case_results');
  fs.mkdirSync(resultDir, { recursive: true });
  const resultFile = data.requestId ? `${data.requestId}.json` : `${id}.json`;
  fs.writeFileSync(
    path.join(resultDir, resultFile),
    JSON.stringify({
      id,
      name,
      workspace_path: workspacePath,
      github_issue: githubIssue,
      issue_url: issueUrl,
    }),
  );

  const notifyJid =
    caseType === 'dev'
      ? Object.entries(registeredGroups).find(([, g]) => g.isMain)?.[0] ||
        resolvedChatJid
      : resolvedChatJid;
  if (notifyJid) {
    const issueInfo = issueUrl ? `\nGitHub: ${issueUrl}` : '';
    deps
      .sendMessage(
        notifyJid,
        `📋 New ${caseType} case created: ${name}\n${d.description.slice(0, 200)}${issueInfo}`,
      )
      .catch(() => {});
  }
}

function handleCaseSuggestDev(
  data: Record<string, unknown>,
  sourceGroup: string,
  deps: IpcDeps,
  registeredGroups: Record<string, RegisteredGroup>,
): void {
  if (!data.description || !data.sourceCaseId) return;

  const d = data as unknown as {
    description: string;
    sourceCaseId: string;
    chatJid?: string;
    githubIssue?: number;
  };

  const sourceCase = getCaseById(d.sourceCaseId);
  let linkedDescription = d.description;
  if (sourceCase?.github_issue_url) {
    linkedDescription += ` (source: ${sourceCase.github_issue_url})`;
  }

  suggestDevCase({
    groupFolder: sourceGroup,
    chatJid: d.chatJid || '',
    description: linkedDescription,
    sourceWorkCaseId: d.sourceCaseId,
    initiator: 'agent',
    initiatorChannel: undefined,
    githubIssue: d.githubIssue,
  });

  const targetJid =
    Object.entries(registeredGroups).find(([, g]) => g.isMain)?.[0] ||
    Object.entries(registeredGroups).find(
      ([, g]) => g.folder === sourceGroup,
    )?.[0];
  if (targetJid) {
    deps
      .sendMessage(
        targetJid,
        `💡 Dev case suggested: ${d.description.slice(0, 200)}\n(from case ${d.sourceCaseId})\nReply "approve" to add to backlog.`,
      )
      .catch(() => {});
  }
}
