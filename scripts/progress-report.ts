#!/usr/bin/env npx tsx
/**
 * progress-report.ts — Automated system progress report.
 *
 * Gathers PR/issue/test data mechanistically via gh CLI,
 * calls Claude (Sonnet, subscription auth) for narrative analysis,
 * posts to GitHub Discussions on the kaizen repo.
 *
 * Usage:
 *   npx tsx scripts/progress-report.ts                    # generate and post
 *   npx tsx scripts/progress-report.ts --check-threshold  # exit 0 if ≥10 PRs, 1 if not
 *   npx tsx scripts/progress-report.ts --dry-run          # print report without posting
 *
 * Auth:
 *   CLAUDE_CODE_OAUTH_TOKEN — Claude subscription token (from `claude setup-token`)
 *   GH_PAT — GitHub PAT with discussion:write scope on kaizen repo (for cross-repo posting)
 *   GH_TOKEN — fallback for same-repo operations (data gathering)
 */

import { execSync, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Config ──────────────────────────────────────────────────────────────

const KAIZEN_REPO = 'Garsson-io/kaizen';
const NANOCLAW_REPO = 'Garsson-io/nanoclaw';
const DISCUSSION_CATEGORY_ID = 'DIC_kwDORof1pc4C49QK'; // Announcements
const PR_THRESHOLD = 10;
const REPORT_WINDOW_HOURS = 48; // look back 48h for data

// ── Data Gathering (mechanistic — no LLM) ───────────────────────────────

interface RawData {
  mergedPRs: Array<{ number: number; title: string; mergedAt: string }>;
  closedIssues: Array<{ number: number; title: string; closedAt: string }>;
  openIssueCount: number;
  diffStats: { filesChanged: number; insertions: number; deletions: number };
  prBreakdown: Record<string, number>;
}

function gh(cmd: string, token?: string): string {
  try {
    const env = token ? { ...process.env, GH_TOKEN: token } : undefined;
    return execSync(`gh ${cmd}`, {
      encoding: 'utf8',
      timeout: 30_000,
      env,
    }).trim();
  } catch (e: any) {
    console.error(`gh command failed: gh ${cmd.slice(0, 80)}`);
    return '';
  }
}

function getSinceDate(): string {
  const d = new Date(Date.now() - REPORT_WINDOW_HOURS * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function gatherData(): RawData {
  const since = getSinceDate();
  console.log(`Gathering data since ${since}...`);

  // Merged PRs
  const prsJson = gh(
    `pr list --repo ${NANOCLAW_REPO} --state merged --search "merged:>=${since}" --json number,title,mergedAt --limit 100`,
  );
  const mergedPRs = prsJson
    ? JSON.parse(prsJson).sort(
        (a: any, b: any) =>
          new Date(a.mergedAt).getTime() - new Date(b.mergedAt).getTime(),
      )
    : [];

  // Closed kaizen issues
  const issuesJson = gh(
    `issue list --repo ${KAIZEN_REPO} --state closed --search "closed:>=${since}" --json number,title,closedAt --limit 100`,
  );
  const closedIssues = issuesJson ? JSON.parse(issuesJson) : [];

  // Open issue count
  const openJson = gh(
    `issue list --repo ${KAIZEN_REPO} --state open --json number --limit 300`,
  );
  const openIssueCount = openJson ? JSON.parse(openJson).length : 0;

  // Diff stats
  let diffStats = { filesChanged: 0, insertions: 0, deletions: 0 };
  if (mergedPRs.length > 0) {
    try {
      const shortstat = execSync(
        `git log --since="${since}" --shortstat --format="" | tail -1`,
        { encoding: 'utf8', timeout: 10_000 },
      ).trim();
      const filesMatch = shortstat.match(/(\d+) files? changed/);
      const insMatch = shortstat.match(/(\d+) insertions?/);
      const delMatch = shortstat.match(/(\d+) deletions?/);
      diffStats = {
        filesChanged: filesMatch ? parseInt(filesMatch[1]) : 0,
        insertions: insMatch ? parseInt(insMatch[1]) : 0,
        deletions: delMatch ? parseInt(delMatch[1]) : 0,
      };
    } catch {
      // Git stats optional — may not be in a repo context in CI
    }
  }

  // PR type breakdown
  const prBreakdown: Record<string, number> = {};
  for (const pr of mergedPRs) {
    const match = pr.title.match(/^(\w+):/);
    const type = match ? match[1] : 'other';
    prBreakdown[type] = (prBreakdown[type] || 0) + 1;
  }

  return { mergedPRs, closedIssues, openIssueCount, diffStats, prBreakdown };
}

// ── Spirit docs (context for narrative voice) ───────────────────────────

function loadSpiritDocs(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(scriptDir, '..');
  const docs: string[] = [];

  const files = ['.claude/kaizen/zen.md', '.claude/kaizen/horizon.md'];

  for (const f of files) {
    try {
      const content = readFileSync(resolve(root, f), 'utf-8');
      docs.push(`### ${f}\n${content.slice(0, 2000)}`);
    } catch {
      // File not found — skip
    }
  }

  return docs.join('\n\n');
}

// ── Narrative Generation (Claude CLI, subscription auth) ────────────────

async function generateNarrative(data: RawData): Promise<string> {
  // Check claude CLI is available
  try {
    execSync('claude --version', { encoding: 'utf8', timeout: 5_000 });
  } catch {
    console.log('claude CLI not available — using template-only report');
    return generateTemplateReport(data);
  }

  const prList = data.mergedPRs
    .map((pr) => `#${pr.number}: ${pr.title}`)
    .join('\n');

  const spirit = loadSpiritDocs();

  const prompt = `You are the narrator of NanoClaw's kaizen journey — a system that improves itself through autonomous agents. Write a progress report that tells the STORY of what happened in the last 48 hours.

## Raw Data

**${data.mergedPRs.length} PRs merged:**
${prList}

**${data.closedIssues.length} kaizen issues closed**
**${data.openIssueCount} kaizen issues remaining open**
**Code: ${data.diffStats.filesChanged} files, +${data.diffStats.insertions}/-${data.diffStats.deletions} lines**
**PR breakdown:** ${Object.entries(data.prBreakdown)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ')}

## Your task

Write a progress report that combines hard data with narrative storytelling. Include ALL PRs and issues with their numbers. But tell the STORY:

1. **The Numbers** — summary table with all metrics. Every PR listed with its number.

2. **The Story** — What was the arc of these 48 hours? What was the system trying to become? Group PRs into narrative threads (not just categories). Example: "The system learned to question its own assumptions" is more interesting than "5 hook fixes merged." Find the dramatic tension: what was broken, what the agents struggled with, what breakthrough connected the pieces.

3. **The Philosophy** — What does this period reveal about autonomous improvement? Reference specific PRs as evidence. Draw connections between seemingly unrelated changes. What pattern is emerging that the individual PRs don't see? Connect to the Zen of Kaizen principles where they apply naturally (not forced): compound interest, enforcement over instructions, specs as hypotheses, etc.

4. **The Horizon** — Where is the system on its L0-L8 journey? What moved? What is the frontier? What is the next wall to hit?

5. **The Gaps** — What is conspicuously absent? What should have happened but did not? What is the system avoiding?

**Style:** Write like a thoughtful engineering retrospective crossed with a philosophical diary. Concrete (reference PR numbers, specific changes) but reflective (what does it mean?). The reader should feel the momentum AND understand exactly what shipped. Avoid corporate-speak and filler. Be honest about failures and gaps.

## Spirit & Philosophy (read these to understand the voice)

${spirit}`;

  try {
    // Pipe prompt via stdin to avoid shell quoting issues.
    // The prompt contains backticks, quotes, newlines that break CLI args.
    // Auth: CLAUDE_CODE_OAUTH_TOKEN env var (subscription, set in CI secrets)
    const result = spawnSync(
      'claude',
      [
        '-p',
        '--model',
        'claude-sonnet-4-6',
        '--output-format',
        'text',
        '--max-turns',
        '1',
        '--dangerously-skip-permissions',
      ],
      {
        input: prompt,
        encoding: 'utf8',
        timeout: 300_000, // 5 min — large prompt with 100+ PRs needs time
        maxBuffer: 2 * 1024 * 1024,
      },
    );

    if (result.error) {
      throw result.error;
    }

    // claude CLI writes "Reached max turns" to stderr — this is informational, not an error
    if (result.status !== 0) {
      const stderr = result.stderr || '';
      // Filter out the "Reached max turns" info message
      const realErrors = stderr
        .split('\n')
        .filter((l) => l && !l.includes('Reached max turns'))
        .join('\n');
      if (realErrors) {
        console.error(`claude CLI stderr: ${realErrors.slice(0, 300)}`);
      }
      // If we got stdout despite non-zero exit, use it (max-turns exit is normal)
      if (result.stdout?.trim()) {
        return result.stdout.trim();
      }
      console.error(`claude CLI exited ${result.status} with no output`);
      return generateTemplateReport(data);
    }

    const output = result.stdout?.trim();
    if (!output) {
      console.error('Empty claude CLI response');
      return generateTemplateReport(data);
    }
    return output;
  } catch (e: any) {
    console.error(
      `claude CLI failed: ${e.message?.split('\n')[0] || 'unknown error'}`,
    );
    return generateTemplateReport(data);
  }
}

function generateTemplateReport(data: RawData): string {
  const since = getSinceDate();
  const now = new Date().toISOString().slice(0, 10);

  const prLines = data.mergedPRs
    .map(
      (pr) => `| #${pr.number} | ${pr.title} | ${pr.mergedAt.slice(0, 10)} |`,
    )
    .join('\n');

  const breakdown = Object.entries(data.prBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');

  return `# System Progress Report: ${since} → ${now}

## Summary

| Metric | Value |
|--------|-------|
| **PRs merged** | ${data.mergedPRs.length} |
| **Kaizen issues closed** | ${data.closedIssues.length} |
| **Kaizen issues open** | ${data.openIssueCount} |
| **Files changed** | ${data.diffStats.filesChanged} |
| **Lines** | +${data.diffStats.insertions} / -${data.diffStats.deletions} |
| **PR breakdown** | ${breakdown} |

## PRs Merged

| PR | Title | Date |
|----|-------|------|
${prLines}

_This is a template report. Install claude CLI and set CLAUDE_CODE_OAUTH_TOKEN for AI-generated narrative._`;
}

// ── Post to GitHub Discussions ──────────────────────────────────────────

function postDiscussion(title: string, body: string): string {
  // Use GH_PAT for cross-repo discussion posting (github.token is repo-scoped)
  const pat = process.env.GH_PAT;
  if (!pat) {
    console.error(
      'GH_PAT not set — cannot post cross-repo discussion. Set via: gh secret set GH_PAT',
    );
    return '';
  }

  const repoId = gh(
    `api graphql -f query='{ repository(owner:"Garsson-io", name:"kaizen") { id } }' --jq '.data.repository.id'`,
    pat,
  );

  if (!repoId) {
    console.error('Could not get kaizen repo ID');
    return '';
  }

  const result = gh(
    `api graphql -f query='mutation($repoId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
      createDiscussion(input: {repositoryId: $repoId, categoryId: $categoryId, title: $title, body: $body}) {
        discussion { url }
      }
    }' -f repoId="${repoId}" -f categoryId="${DISCUSSION_CATEGORY_ID}" -f title=${JSON.stringify(title)} -f body=${JSON.stringify(body)}`,
    pat,
  );

  try {
    const parsed = JSON.parse(result);
    return parsed.data?.createDiscussion?.discussion?.url || '';
  } catch {
    return '';
  }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const checkThreshold = args.includes('--check-threshold');
  const dryRun = args.includes('--dry-run');

  const data = gatherData();

  if (checkThreshold) {
    console.log(
      `PRs merged in window: ${data.mergedPRs.length} (threshold: ${PR_THRESHOLD})`,
    );
    process.exit(data.mergedPRs.length >= PR_THRESHOLD ? 0 : 1);
  }

  console.log(
    `${data.mergedPRs.length} PRs, ${data.closedIssues.length} issues closed`,
  );

  const report = await generateNarrative(data);
  const since = getSinceDate();
  const now = new Date().toISOString().slice(0, 10);
  const title = `[Report] ${since} → ${now}: ${data.mergedPRs.length} PRs merged, ${data.closedIssues.length} issues closed`;

  if (dryRun) {
    console.log('\n--- DRY RUN ---\n');
    console.log(`Title: ${title}\n`);
    console.log(report);
    return;
  }

  // Always print report to stdout (CI logs) regardless of posting success
  console.log(report);

  const url = postDiscussion(title, report);
  if (url) {
    console.log(`\nPosted: ${url}`);
  } else {
    console.error('\nFailed to post discussion — report printed above');
    // Don't exit 1 — the narrative was generated successfully,
    // only the posting failed. The report is in the CI logs.
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
