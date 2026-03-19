#!/usr/bin/env node
/**
 * CLI wrapper for kaizen issue operations.
 * Used by skills (markdown prompts) that need to call the domain model from bash.
 *
 * Usage:
 *   node dist/cli-kaizen.js list [--state open|closed|all] [--labels L1,L2] [--limit N]
 *   node dist/cli-kaizen.js view <number>
 *   node dist/cli-kaizen.js case-create --description "..." [--type dev|work] [--issue N] [--name "..."] [--branch "..."] [--worktree "..."]
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  listGitHubIssues,
  getGitHubIssue,
  DEV_CASE_ISSUE_REPO,
} from './github-api.js';
import Database from 'better-sqlite3';

import {
  generateCaseId,
  generateCaseName,
  insertCase,
  getActiveCasesByGithubIssue,
  createCasesSchema,
} from './cases.js';
import type { Case, CaseType } from './cases.js';

const { owner, repo } = DEV_CASE_ISSUE_REPO;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    console.error('Usage:');
    console.error(
      '  node dist/cli-kaizen.js list [--state open|closed|all] [--labels L1,L2] [--limit N]',
    );
    console.error('  node dist/cli-kaizen.js view <number>');
    console.error(
      '  node dist/cli-kaizen.js case-create --description "..." [--type dev|work] [--issue N] [--name "..."] [--branch "..."] [--worktree "..."]',
    );
    process.exit(1);
  }

  if (command === 'list') {
    const state = getFlag(args, '--state') as
      | 'open'
      | 'closed'
      | 'all'
      | undefined;
    const labelsRaw = getFlag(args, '--labels');
    const limitRaw = getFlag(args, '--limit');
    const labels = labelsRaw ? labelsRaw.split(',') : undefined;
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;

    const result = await listGitHubIssues({
      owner,
      repo,
      state,
      labels,
      limit,
    });

    if (!result.success) {
      console.error('Error:', result.error);
      process.exit(1);
    }

    console.log(JSON.stringify(result.issues, null, 2));
  } else if (command === 'view') {
    const issueNumber = parseInt(args[0], 10);
    if (!issueNumber || isNaN(issueNumber)) {
      console.error('Usage: node dist/cli-kaizen.js view <number>');
      process.exit(1);
    }

    const result = await getGitHubIssue({ owner, repo, issueNumber });

    if (!result.success) {
      console.error('Error:', result.error);
      process.exit(1);
    }

    console.log(JSON.stringify(result.issue, null, 2));
  } else if (command === 'case-create') {
    await handleCaseCreate(args);
  } else {
    console.error(`Unknown command: ${command}`);
    console.error('Available commands: list, view, case-create');
    process.exit(1);
  }
}

/**
 * Resolve the main repository root, even when running from a worktree.
 * Uses git's common-dir to find the shared .git directory.
 */
function resolveMainRepoRoot(): string {
  const commonDir = execSync('git rev-parse --git-common-dir', {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  // commonDir is the path to .git — the repo root is its parent
  return path.resolve(path.dirname(commonDir));
}

async function handleCaseCreate(args: string[]): Promise<void> {
  const description = getFlag(args, '--description');
  if (!description) {
    console.error(
      'Usage: node dist/cli-kaizen.js case-create --description "..." [--type dev|work] [--issue N] [--name "..."] [--branch "..."] [--worktree "..."]',
    );
    console.error('\nOptions:');
    console.error('  --description  Case description (required)');
    console.error('  --type         Case type: dev or work (default: dev)');
    console.error('  --issue        Linked kaizen issue number');
    console.error('  --name         Short name override for case naming');
    console.error(
      '  --branch       Use existing branch instead of creating one',
    );
    console.error(
      '  --worktree     Use existing worktree path instead of creating one',
    );
    process.exit(1);
  }

  // Initialize cases DB directly using the main repo root (not the worktree).
  // We can't use initDatabase() because config.ts captures process.cwd() at
  // import time, which would point to the worktree instead of the shared DB.
  const mainRoot = resolveMainRepoRoot();
  const dbPath = path.join(mainRoot, 'store', 'messages.db');
  const database = new Database(dbPath);
  createCasesSchema(database);

  const caseType: CaseType = (getFlag(args, '--type') as CaseType) || 'dev';
  const issueRaw = getFlag(args, '--issue');
  const githubIssue = issueRaw ? parseInt(issueRaw, 10) : null;
  const shortName = getFlag(args, '--name');
  const existingBranch = getFlag(args, '--branch');
  const existingWorktree = getFlag(args, '--worktree');

  if (caseType !== 'dev' && caseType !== 'work') {
    console.error(`Invalid case type: ${caseType}. Must be 'dev' or 'work'.`);
    process.exit(1);
  }

  if (githubIssue !== null && isNaN(githubIssue)) {
    console.error('--issue must be a number');
    process.exit(1);
  }

  // Collision detection for kaizen issues
  if (githubIssue) {
    const existing = getActiveCasesByGithubIssue(githubIssue);
    if (existing.length > 0) {
      const names = existing.map((c) => c.name).join(', ');
      console.error(
        `Kaizen #${githubIssue} already has active case(s): ${names}`,
      );
      console.error(
        'Resolve the existing case(s) first, or use the MCP tool with allowDuplicate: true.',
      );
      process.exit(1);
    }
  }

  const id = generateCaseId();
  const name = generateCaseName(description, shortName);
  const now = new Date().toISOString();

  let workspacePath: string;
  let worktreePath: string | null = null;
  let branchName: string | null = null;

  if (existingWorktree && existingBranch) {
    // Use existing worktree and branch (e.g., when running inside a worktree)
    workspacePath = existingWorktree;
    worktreePath = existingWorktree;
    branchName = existingBranch;
  } else if (caseType === 'dev') {
    // Create worktree from the main repo root (not the current worktree)
    const worktreesDir = path.join(mainRoot, '.claude', 'worktrees');
    const wt = path.join(worktreesDir, name);
    const br = `case/${name}`;
    try {
      execSync(
        `git worktree add ${JSON.stringify(wt)} -b ${JSON.stringify(br)} main`,
        { cwd: mainRoot, stdio: 'pipe' },
      );
    } catch {
      // Branch might already exist — try without -b
      execSync(`git worktree add ${JSON.stringify(wt)} ${JSON.stringify(br)}`, {
        cwd: mainRoot,
        stdio: 'pipe',
      });
    }
    workspacePath = wt;
    worktreePath = wt;
    branchName = br;
  } else {
    // Work case — create scratch directory in the main repo's data dir
    const scratchDir = path.join(mainRoot, 'data', 'case-workspaces', name);
    fs.mkdirSync(scratchDir, { recursive: true });
    workspacePath = scratchDir;
  }

  // Build GitHub issue URL if issue number provided
  const githubIssueUrl = githubIssue
    ? `https://github.com/${owner}/${repo}/issues/${githubIssue}`
    : null;

  const c: Case = {
    id,
    group_folder: 'cli',
    chat_jid: 'cli:local',
    name,
    description,
    type: caseType,
    status: 'active',
    blocked_on: null,
    worktree_path: worktreePath,
    workspace_path: workspacePath,
    branch_name: branchName,
    initiator: 'cli',
    initiator_channel: 'cli',
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
    github_issue_url: githubIssueUrl,
    customer_name: null,
    customer_phone: null,
    customer_email: null,
    customer_org: null,
    priority: null,
    gap_type: null,
  };

  insertCase(c);

  // Output result as JSON for easy parsing by scripts
  console.log(
    JSON.stringify(
      {
        id: c.id,
        name: c.name,
        type: c.type,
        status: c.status,
        branch_name: c.branch_name,
        worktree_path: c.worktree_path,
        workspace_path: c.workspace_path,
        github_issue: c.github_issue,
        github_issue_url: c.github_issue_url,
      },
      null,
      2,
    ),
  );
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
