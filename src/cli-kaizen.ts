#!/usr/bin/env node
/**
 * CLI wrapper for kaizen issue operations.
 * Used by skills (markdown prompts) that need to call the domain model from bash.
 *
 * Usage:
 *   node dist/cli-kaizen.js list [--state open|closed|all] [--labels L1,L2] [--limit N]
 *   node dist/cli-kaizen.js view <number>
 */

import {
  listGitHubIssues,
  getGitHubIssue,
  DEV_CASE_ISSUE_REPO,
} from './github-api.js';

const { owner, repo } = DEV_CASE_ISSUE_REPO;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    console.error('Usage:');
    console.error(
      '  node dist/cli-kaizen.js list [--state open|closed|all] [--labels L1,L2] [--limit N]',
    );
    console.error('  node dist/cli-kaizen.js view <number>');
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
  } else {
    console.error(`Unknown command: ${command}`);
    console.error('Available commands: list, view');
    process.exit(1);
  }
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
