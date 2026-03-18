/**
 * GitHub Issues — host-side proxy for creating issues via GitHub REST API.
 * Work agents call the MCP tool, which writes an IPC request.
 * The host processes it here using its own GITHUB_TOKEN.
 *
 * Security: No token is passed to containers. The host enforces an allowlist
 * of repos and labels, preventing misuse even if the IPC protocol is abused.
 */

import { CASE_SYNC_REPO } from './config.js';
import { logger } from './logger.js';

export interface CreateIssueRequest {
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
}

export interface CreateIssueResult {
  success: boolean;
  issueUrl?: string;
  issueNumber?: number;
  error?: string;
}

export interface UpdateIssueRequest {
  owner: string;
  repo: string;
  issueNumber: number;
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  labels?: string[];
}

export interface AddCommentRequest {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}

/** Default repo for auto-created dev case issues. */
export const DEV_CASE_ISSUE_REPO = { owner: 'Garsson-io', repo: 'kaizen' };

/**
 * Repos that agents are allowed to create issues in.
 * Dynamic: always includes kaizen + the configured CASE_SYNC_REPO.
 */
function getAllowedRepos(): Set<string> {
  const repos = new Set(['Garsson-io/kaizen']);
  if (CASE_SYNC_REPO) {
    repos.add(CASE_SYNC_REPO);
  }
  return repos;
}

/**
 * Labels that agents are allowed to apply.
 * Includes both agent labels and case-sync status/type labels.
 */
const ALLOWED_LABEL_PREFIXES = ['status:', 'type:'];
const ALLOWED_LABELS_EXACT = new Set([
  'work-agent',
  'needs-dev',
  'kaizen',
  'bug',
  'enhancement',
]);

export function isRepoAllowed(owner: string, repo: string): boolean {
  return getAllowedRepos().has(`${owner}/${repo}`);
}

export function filterAllowedLabels(labels: string[]): string[] {
  return labels.filter(
    (l) =>
      ALLOWED_LABELS_EXACT.has(l) ||
      ALLOWED_LABEL_PREFIXES.some((p) => l.startsWith(p)),
  );
}

export async function createGitHubIssue(
  req: CreateIssueRequest,
): Promise<CreateIssueResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { success: false, error: 'GITHUB_TOKEN not configured on host' };
  }

  if (!isRepoAllowed(req.owner, req.repo)) {
    return {
      success: false,
      error: `Repository ${req.owner}/${req.repo} is not in the allowed list`,
    };
  }

  const safeLabels = filterAllowedLabels(req.labels);

  const url = `https://api.github.com/repos/${encodeURIComponent(req.owner)}/${encodeURIComponent(req.repo)}/issues`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: req.title,
        body: req.body,
        labels: safeLabels,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(
        { status: response.status, body: errorBody },
        'GitHub API error creating issue',
      );
      return {
        success: false,
        error: `GitHub API returned ${response.status}: ${errorBody.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as {
      html_url: string;
      number: number;
    };

    logger.info(
      {
        repo: `${req.owner}/${req.repo}`,
        issueNumber: data.number,
        labels: safeLabels,
      },
      'GitHub issue created via IPC proxy',
    );

    return {
      success: true,
      issueUrl: data.html_url,
      issueNumber: data.number,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to create GitHub issue');
    return {
      success: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

export async function updateGitHubIssue(
  req: UpdateIssueRequest,
): Promise<CreateIssueResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { success: false, error: 'GITHUB_TOKEN not configured on host' };
  }

  if (!isRepoAllowed(req.owner, req.repo)) {
    return {
      success: false,
      error: `Repository ${req.owner}/${req.repo} is not in the allowed list`,
    };
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(req.owner)}/${encodeURIComponent(req.repo)}/issues/${req.issueNumber}`;

  const body: Record<string, unknown> = {};
  if (req.title !== undefined) body.title = req.title;
  if (req.body !== undefined) body.body = req.body;
  if (req.state !== undefined) body.state = req.state;
  if (req.labels !== undefined) body.labels = filterAllowedLabels(req.labels);

  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: githubHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(
        { status: response.status, body: errorBody },
        'GitHub API error updating issue',
      );
      return {
        success: false,
        error: `GitHub API returned ${response.status}: ${errorBody.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as {
      html_url: string;
      number: number;
    };

    logger.info(
      { repo: `${req.owner}/${req.repo}`, issueNumber: data.number },
      'GitHub issue updated',
    );

    return {
      success: true,
      issueUrl: data.html_url,
      issueNumber: data.number,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to update GitHub issue');
    return {
      success: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function addGitHubIssueComment(
  req: AddCommentRequest,
): Promise<CreateIssueResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { success: false, error: 'GITHUB_TOKEN not configured on host' };
  }

  if (!isRepoAllowed(req.owner, req.repo)) {
    return {
      success: false,
      error: `Repository ${req.owner}/${req.repo} is not in the allowed list`,
    };
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(req.owner)}/${encodeURIComponent(req.repo)}/issues/${req.issueNumber}/comments`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: githubHeaders(),
      body: JSON.stringify({ body: req.body }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(
        { status: response.status, body: errorBody },
        'GitHub API error adding comment',
      );
      return {
        success: false,
        error: `GitHub API returned ${response.status}: ${errorBody.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as {
      html_url: string;
      id: number;
    };

    logger.info(
      { repo: `${req.owner}/${req.repo}`, issueNumber: req.issueNumber },
      'GitHub issue comment added',
    );

    return {
      success: true,
      issueUrl: data.html_url,
      issueNumber: req.issueNumber,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to add GitHub issue comment');
    return {
      success: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
