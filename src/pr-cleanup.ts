/**
 * Auto-close PRs whose referenced kaizen issues are already resolved.
 *
 * When multiple overnight-dent runs target the same backlog, they produce
 * overlapping PRs. This module detects PRs whose kaizen issues have already
 * been closed (by another PR) and auto-closes them with a comment.
 *
 * Usage:
 *   npx tsx src/cli-kaizen.ts pr-cleanup [--dry-run]
 */

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  html_url: string;
  head: { ref: string };
}

export interface GitHubIssueSummary {
  number: number;
  state: 'open' | 'closed';
}

export interface PrCleanupDeps {
  listOpenPRs: (owner: string, repo: string) => Promise<PullRequest[]>;
  getIssueState: (
    owner: string,
    repo: string,
    issueNumber: number,
  ) => Promise<GitHubIssueSummary>;
  closePR: (
    owner: string,
    repo: string,
    prNumber: number,
    comment: string,
  ) => Promise<void>;
}

export interface CleanupResult {
  prNumber: number;
  prUrl: string;
  title: string;
  referencedIssues: number[];
  closedIssues: number[];
  action: 'closed' | 'skipped';
  reason: string;
}

/**
 * Extract kaizen issue numbers from a PR body.
 * Matches patterns like:
 *   - Closes Garsson-io/kaizen#123
 *   - kaizen #123
 *   - kaizen#123
 *   - (kaizen #123)
 */
export function extractKaizenRefs(body: string | null): number[] {
  if (!body) return [];

  const pattern = /(?:Garsson-io\/kaizen#|kaizen\s*#)(\d+)/gi;
  const matches = new Set<number>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(body)) !== null) {
    const num = parseInt(match[1], 10);
    if (!isNaN(num)) {
      matches.add(num);
    }
  }

  return Array.from(matches).sort((a, b) => a - b);
}

/**
 * Run PR cleanup: find and close PRs whose kaizen issues are all resolved.
 */
export async function runPrCleanup(
  owner: string,
  repo: string,
  deps: PrCleanupDeps,
  dryRun = false,
): Promise<CleanupResult[]> {
  const prs = await deps.listOpenPRs(owner, repo);
  const results: CleanupResult[] = [];

  // Cache issue states to avoid redundant API calls
  const issueCache = new Map<number, GitHubIssueSummary>();

  for (const pr of prs) {
    const refs = extractKaizenRefs(pr.body);

    if (refs.length === 0) {
      continue;
    }

    const closedIssues: number[] = [];
    for (const issueNum of refs) {
      if (!issueCache.has(issueNum)) {
        const issue = await deps.getIssueState(
          'Garsson-io',
          'kaizen',
          issueNum,
        );
        issueCache.set(issueNum, issue);
      }
      const cached = issueCache.get(issueNum)!;
      if (cached.state === 'closed') {
        closedIssues.push(issueNum);
      }
    }

    if (closedIssues.length === refs.length) {
      if (!dryRun) {
        const comment =
          `This PR has been auto-closed because all referenced kaizen issues ` +
          `are already resolved:\n\n` +
          closedIssues
            .map((n) => `- Garsson-io/kaizen#${n} (closed)`)
            .join('\n') +
          `\n\nIf this closure was incorrect, reopen the PR and add a comment explaining why.`;

        await deps.closePR(owner, repo, pr.number, comment);
      }

      results.push({
        prNumber: pr.number,
        prUrl: pr.html_url,
        title: pr.title,
        referencedIssues: refs,
        closedIssues,
        action: dryRun ? 'skipped' : 'closed',
        reason: 'all referenced kaizen issues are closed',
      });
    }
  }

  return results;
}

/**
 * Production dependencies using GitHub REST API.
 */
export function createGitHubDeps(): PrCleanupDeps {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN not configured');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };

  return {
    async listOpenPRs(owner: string, repo: string): Promise<PullRequest[]> {
      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=100`;
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status}`);
      }
      return (await response.json()) as PullRequest[];
    },

    async getIssueState(
      owner: string,
      repo: string,
      issueNumber: number,
    ): Promise<GitHubIssueSummary> {
      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`;
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(
          `GitHub API returned ${response.status} for issue #${issueNumber}`,
        );
      }
      const data = (await response.json()) as {
        number: number;
        state: string;
      };
      return {
        number: data.number,
        state: data.state as 'open' | 'closed',
      };
    },

    async closePR(
      owner: string,
      repo: string,
      prNumber: number,
      comment: string,
    ): Promise<void> {
      // Add comment first
      const commentUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${prNumber}/comments`;
      const commentRes = await fetch(commentUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body: comment }),
      });
      if (!commentRes.ok) {
        throw new Error(
          `Failed to add comment to PR #${prNumber}: ${commentRes.status}`,
        );
      }

      // Close the PR
      const prUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`;
      const closeRes = await fetch(prUrl, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ state: 'closed' }),
      });
      if (!closeRes.ok) {
        throw new Error(`Failed to close PR #${prNumber}: ${closeRes.status}`);
      }
    },
  };
}
