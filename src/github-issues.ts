/**
 * GitHub Issues — host-side proxy for creating issues via GitHub REST API.
 * Work agents call the MCP tool, which writes an IPC request.
 * The host processes it here using its own GITHUB_TOKEN.
 *
 * Security: No token is passed to containers. The host enforces an allowlist
 * of repos and labels, preventing misuse even if the IPC protocol is abused.
 */

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

/**
 * Repos that agents are allowed to create issues in.
 * Format: "owner/repo"
 */
const ALLOWED_REPOS = new Set(['Garsson-io/kaizen']);

/**
 * Labels that agents are allowed to apply.
 * Prevents agents from applying arbitrary labels like "priority:critical".
 */
const ALLOWED_LABELS = new Set([
  'work-agent',
  'needs-dev',
  'kaizen',
  'bug',
  'enhancement',
]);

export function isRepoAllowed(owner: string, repo: string): boolean {
  return ALLOWED_REPOS.has(`${owner}/${repo}`);
}

export function filterAllowedLabels(labels: string[]): string[] {
  return labels.filter((l) => ALLOWED_LABELS.has(l));
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
