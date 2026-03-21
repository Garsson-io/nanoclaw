/**
 * hook-utils.ts — Shared utilities for TypeScript Claude Code hooks.
 *
 * Claude Code hooks receive JSON on stdin with tool_input/tool_response.
 * This module provides typed parsing of that input plus common helpers.
 */

import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

// ── Types ────────────────────────────────────────────────────────────

export interface HookInput {
  tool_name?: string;
  tool_input: {
    command?: string;
    file_path?: string;
    [key: string]: unknown;
  };
  tool_response: {
    stdout?: string;
    stderr?: string;
    exit_code?: string | number;
  };
}

// ── Stdin parsing ────────────────────────────────────────────────────

/** Read all of stdin synchronously and parse as JSON HookInput. */
export function readHookInput(): HookInput {
  const raw = fs.readFileSync(0, 'utf-8');
  return JSON.parse(raw) as HookInput;
}

/** Get exit code as a number, defaulting to 0. */
export function exitCode(input: HookInput): number {
  const code = input.tool_response.exit_code;
  if (code === undefined || code === null) return 0;
  return typeof code === 'number' ? code : parseInt(code, 10) || 0;
}

// ── Output helpers ───────────────────────────────────────────────────

/** Write a message to stdout (shown to the agent). */
export function emit(msg: string): void {
  process.stdout.write(msg);
}

/** Exit the hook. 0 = pass/advisory, 2 = block (PreToolUse). */
export function exitHook(code: number = 0): never {
  process.exit(code);
}

// ── Git helpers ──────────────────────────────────────────────────────

/** Run a git command and return trimmed stdout. Returns fallback on error. */
export function git(args: string, fallback: string = ''): string {
  try {
    return execSync(`git ${args}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return fallback;
  }
}

/** Get current branch name. */
export function currentBranch(): string {
  return git('rev-parse --abbrev-ref HEAD', 'unknown');
}

/** Get current HEAD SHA. */
export function headSha(): string {
  return git('rev-parse HEAD', '');
}

/** Resolve the main checkout path (first worktree). */
export function mainCheckout(): string {
  const output = git('worktree list --porcelain');
  const match = output.match(/^worktree (.+)/m);
  return match?.[1] ?? '.';
}

// ── Shell execution ──────────────────────────────────────────────────

/** Run a shell command, return stdout. Returns empty string on error. */
export function shell(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}
