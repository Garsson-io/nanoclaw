/**
 * GitHub Issues adapter for case sync.
 * Maps NanoClaw cases to GitHub Issues with structured metadata.
 */

import type { Case } from './cases.js';
import type { CaseSyncAdapter, SyncResult } from './case-sync.js';
import {
  createGitHubIssue,
  updateGitHubIssue,
  addGitHubIssueComment,
} from './github-issues.js';
import { updateCase } from './cases.js';
import { logger } from './logger.js';

const METADATA_VERSION = 'v1';
const METADATA_START = `<!-- nanoclaw:${METADATA_VERSION}`;
const METADATA_END = '-->';

export interface CaseMetadata {
  case_id: string;
  case_name: string;
  type: string;
  status: string;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
  customer_org?: string;
  initiator: string;
  created_at: string;
  cost_usd: number;
  time_spent_ms: number;
}

export function serializeMetadata(meta: CaseMetadata): string {
  const lines = [METADATA_START];
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined && value !== null && value !== '') {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push(METADATA_END);
  return lines.join('\n');
}

export function parseMetadata(body: string): CaseMetadata | null {
  const startIdx = body.indexOf(METADATA_START);
  if (startIdx === -1) return null;

  const endIdx = body.indexOf(METADATA_END, startIdx + METADATA_START.length);
  if (endIdx === -1) return null;

  const block = body.slice(startIdx + METADATA_START.length, endIdx).trim();
  const meta: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) {
      meta[key] = value;
    }
  }

  return {
    case_id: meta.case_id ?? '',
    case_name: meta.case_name ?? '',
    type: meta.type ?? '',
    status: meta.status ?? '',
    customer_name: meta.customer_name,
    customer_phone: meta.customer_phone,
    customer_email: meta.customer_email,
    customer_org: meta.customer_org,
    initiator: meta.initiator ?? '',
    created_at: meta.created_at ?? '',
    cost_usd: parseFloat(meta.cost_usd ?? '0') || 0,
    time_spent_ms: parseInt(meta.time_spent_ms ?? '0', 10) || 0,
  };
}

function caseToMetadata(c: Case): CaseMetadata {
  return {
    case_id: c.id,
    case_name: c.name,
    type: c.type,
    status: c.status,
    customer_name: c.customer_name ?? undefined,
    customer_phone: c.customer_phone ?? undefined,
    customer_email: c.customer_email ?? undefined,
    customer_org: c.customer_org ?? undefined,
    initiator: c.initiator,
    created_at: c.created_at,
    cost_usd: c.total_cost_usd,
    time_spent_ms: c.time_spent_ms,
  };
}

function buildIssueBody(c: Case): string {
  const meta = serializeMetadata(caseToMetadata(c));
  const parts = [meta, '', `## ${c.description}`];

  const statusLine: string[] = [];
  statusLine.push(`**Status:** ${c.status}`);
  if (c.customer_name) statusLine.push(`**Customer:** ${c.customer_name}`);
  if (c.total_cost_usd > 0)
    statusLine.push(`**Cost:** $${c.total_cost_usd.toFixed(2)}`);

  parts.push('', statusLine.join(' | '));

  if (c.conclusion) {
    parts.push('', `### Conclusion`, '', c.conclusion);
  }

  return parts.join('\n');
}

function statusLabels(c: Case): string[] {
  return [`status:${c.status}`, `type:${c.type}`];
}

export class GitHubCaseSyncAdapter implements CaseSyncAdapter {
  constructor(
    private owner: string,
    private repo: string,
  ) {}

  async createCase(c: Case): Promise<SyncResult> {
    const result = await createGitHubIssue({
      owner: this.owner,
      repo: this.repo,
      title: `[${c.type}] ${c.name}: ${c.description.slice(0, 100)}`,
      body: buildIssueBody(c),
      labels: statusLabels(c),
    });

    if (result.success && result.issueNumber) {
      // Store the issue URL and number back in SQLite
      try {
        updateCase(c.id, {
          github_issue: result.issueNumber,
        });
        // Also store the URL via direct DB update (github_issue_url)
        // This is handled by the caller if needed
      } catch (err) {
        logger.warn(
          { caseId: c.id, err },
          'Failed to store GitHub issue reference in SQLite',
        );
      }
    }

    return result;
  }

  async updateCase(c: Case, changes: Partial<Case>): Promise<SyncResult> {
    if (!c.github_issue) {
      // No linked issue — create one
      return this.createCase(c);
    }

    const update: {
      title?: string;
      body?: string;
      labels?: string[];
      state?: 'open' | 'closed';
    } = {};

    // Always update body to reflect latest metadata
    update.body = buildIssueBody(c);
    update.labels = statusLabels(c);

    if (changes.description) {
      update.title = `[${c.type}] ${c.name}: ${c.description.slice(0, 100)}`;
    }

    return updateGitHubIssue({
      owner: this.owner,
      repo: this.repo,
      issueNumber: c.github_issue,
      ...update,
    });
  }

  async addComment(c: Case, text: string, author: string): Promise<SyncResult> {
    if (!c.github_issue) {
      logger.warn(
        { caseId: c.id },
        'Cannot add comment — no linked GitHub issue',
      );
      return { success: false, error: 'No linked GitHub issue' };
    }

    return addGitHubIssueComment({
      owner: this.owner,
      repo: this.repo,
      issueNumber: c.github_issue,
      body: `**${author}:** ${text}`,
    });
  }

  async closeCase(c: Case): Promise<SyncResult> {
    if (!c.github_issue) {
      // No linked issue — nothing to close
      return { success: true };
    }

    // Add conclusion as comment, then close
    if (c.conclusion) {
      await addGitHubIssueComment({
        owner: this.owner,
        repo: this.repo,
        issueNumber: c.github_issue,
        body: `### Case completed\n\n${c.conclusion}\n\n**Cost:** $${c.total_cost_usd.toFixed(2)} | **Time:** ${Math.round(c.time_spent_ms / 60000)} min`,
      });
    }

    return updateGitHubIssue({
      owner: this.owner,
      repo: this.repo,
      issueNumber: c.github_issue,
      body: buildIssueBody(c),
      state: 'closed',
      labels: [`status:done`, `type:${c.type}`],
    });
  }
}
