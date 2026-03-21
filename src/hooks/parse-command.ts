/**
 * parse-command.ts — Command parsing utilities for hook trigger detection.
 *
 * Port of .claude/kaizen/hooks/lib/parse-command.sh to TypeScript.
 * Improvements over bash: proper string handling, no sed/grep pipelines,
 * typed return values, testable pure functions.
 */

import { git, shell } from './hook-utils.js';

// ── Heredoc stripping ────────────────────────────────────────────────

/**
 * Strip heredoc bodies from a command line to prevent false-positive
 * pattern matches on embedded text.
 *
 * Returns the command text before the first heredoc delimiter.
 */
export function stripHeredocBody(command: string): string {
  const heredocPattern = /<<\s*-?\s*['"]?[A-Za-z_]\w*['"]?/;
  const lines = command.split('\n');

  const result: string[] = [];
  for (const line of lines) {
    if (heredocPattern.test(line)) {
      result.push(line);
      break;
    }
    result.push(line);
  }

  return result.join('\n') || lines[0] || '';
}

// ── Command segment splitting ────────────────────────────────────────

/**
 * Split a command by pipe/chain operators (|, &&, ||, ;) into segments.
 */
function splitCommandSegments(cmdLine: string): string[] {
  return cmdLine
    .split(/\s*(?:\|\||&&|[|;])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── Trigger detection ────────────────────────────────────────────────

/**
 * Check if command line contains `gh pr <subcommand>` as an actual invocation.
 * @param subcommands - Pipe-separated subcommands, e.g. "create|merge"
 */
export function isGhPrCommand(cmdLine: string, subcommands: string): boolean {
  const pattern = new RegExp(`^gh\\s+pr\\s+(${subcommands})(\\s|$)`);
  return splitCommandSegments(cmdLine).some((seg) => pattern.test(seg));
}

/**
 * Check if command line contains `git <subcommand>`.
 * Handles `git -C <path> <subcommand>`.
 */
export function isGitCommand(cmdLine: string, subcommand: string): boolean {
  const escaped = subcommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^git\\s+(-C\\s+\\S+\\s+)?${escaped}(\\s|$)`);
  return splitCommandSegments(cmdLine).some((seg) => pattern.test(seg));
}

// ── PR number & repo extraction ──────────────────────────────────────

/** Extract bare PR number from `gh pr <subcommand> NNN`. */
export function extractPrNumber(cmdLine: string, subcommand: string): string {
  const escaped = subcommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`gh\\s+pr\\s+${escaped}\\s+(\\d+)`);
  const match = cmdLine.match(pattern);
  return match?.[1] ?? '';
}

/** Extract --repo owner/name from command line. */
export function extractRepoFlag(cmdLine: string): string {
  const match = cmdLine.match(/--repo\s+(\S+)/);
  return match?.[1] ?? '';
}

/** Detect repo from git origin remote URL. */
export function detectGhRepo(): string {
  const url = git('remote get-url origin');
  const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  return match?.[1] ?? '';
}

/** Extract -C <path> from a git command. */
export function extractGitCPath(cmdLine: string): string {
  for (const seg of splitCommandSegments(cmdLine)) {
    const match = seg.match(/^git\s+-C\s+(\S+)/);
    if (match) return match[1];
  }
  return '';
}

// ── Changed files ────────────────────────────────────────────────────

/**
 * Get changed file list for a PR command.
 * For merge: uses gh pr diff (actual PR files on GitHub).
 * For create: uses git diff (local branch vs base).
 */
export function getPrChangedFiles(cmdLine: string, isMerge: boolean): string {
  if (isMerge) {
    const prNum = extractPrNumber(cmdLine, 'merge');
    const repo = extractRepoFlag(cmdLine) || detectGhRepo();
    const repoFlag = repo ? `--repo ${repo}` : '';

    let result = '';
    if (prNum) {
      result = shell(`gh pr diff ${prNum} --name-only ${repoFlag}`);
    } else {
      result = shell(`gh pr diff --name-only ${repoFlag}`);
    }
    if (!result) {
      result = git('diff --name-only main...HEAD');
    }
    return result;
  }
  return git('diff --name-only main...HEAD');
}

// ── PR URL reconstruction ────────────────────────────────────────────

const PR_URL_PATTERN =
  /https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/pull\/\d+/;

/**
 * Reconstruct a full PR URL from command/output using a fallback chain:
 *   1. Extract URL from stdout
 *   2. Extract URL from stderr
 *   3. Extract URL from command args
 *   4. Reconstruct from --repo + bare PR number
 *   5. Reconstruct from bare PR number + detected repo
 */
export function reconstructPrUrl(
  cmdLine: string,
  stdout: string,
  stderr: string,
  subcommand: string,
): string {
  // Try stdout
  let match = stdout.match(PR_URL_PATTERN);
  if (match) return match[0];

  // Try stderr
  match = stderr.match(PR_URL_PATTERN);
  if (match) return match[0];

  // Try command args
  match = cmdLine.match(PR_URL_PATTERN);
  if (match) return match[0];

  // Reconstruct from --repo + bare PR number
  const prNum = extractPrNumber(cmdLine, subcommand);
  if (prNum) {
    const repo = extractRepoFlag(cmdLine) || detectGhRepo();
    if (repo) {
      return `https://github.com/${repo}/pull/${prNum}`;
    }
  }

  return '';
}
