#!/usr/bin/env npx tsx
/**
 * pr-kaizen-clear.ts — Clears the PR kaizen gate on valid impediment declarations.
 *
 * Port of .claude/kaizen/hooks/pr-kaizen-clear.sh (290 lines) to TypeScript.
 * PostToolUse hook on Bash — always exits 0 (state management, not blocking).
 *
 * Triggers:
 *   1. echo "KAIZEN_IMPEDIMENTS: [...]" — structured impediment declaration
 *   2. echo "KAIZEN_NO_ACTION [category]: <reason>" — restricted bypass
 *
 * Improvements over bash:
 * - Native JSON parsing (no jq pipelines or sed extraction)
 * - Typed validation with clear error messages
 * - No pipe-splitting corruption (IFS='|' read bug)
 * - Proper blocklist checking without per-pattern grep
 * - Atomic state file operations
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  readHookInput,
  exitCode,
  emit,
  exitHook,
  currentBranch,
} from './hook-utils.js';
import { stripHeredocBody } from './parse-command.js';
import {
  findStateWithStatusAnyBranch,
  clearStateWithStatusAnyBranch,
  markReflectionDone,
  autoCloseKaizenIssues,
} from './state-utils.js';

// ── Types ────────────────────────────────────────────────────────────

interface Impediment {
  impediment?: string;
  finding?: string;
  type?: string;
  disposition?: string;
  ref?: string;
  reason?: string;
  impact_minutes?: number;
}

// ── Audit logging ────────────────────────────────────────────────────

import { fileURLToPath } from 'node:url';
const __hookDirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_DIR = path.resolve(__hookDirname, '../../.claude/kaizen');
const AUDIT_DIR = path.join(HOOK_DIR, 'audit');

function logNoAction(category: string, reason: string, prUrl: string): void {
  const branch = currentBranch();
  const timestamp = new Date().toISOString();
  const line = `${timestamp} | branch=${branch} | category=${category} | pr=${prUrl} | reason=${reason}\n`;
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(path.join(AUDIT_DIR, 'no-action.log'), line);
  } catch {}
}

function logWaiver(
  desc: string,
  reason: string,
  findingType: string,
  prUrl: string,
): void {
  const branch = currentBranch();
  const timestamp = new Date().toISOString();
  const line = `${timestamp} | branch=${branch} | type=${findingType} | pr=${prUrl} | desc=${desc} | reason=${reason}\n`;
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(path.join(AUDIT_DIR, 'waiver.log'), line);
  } catch {}
}

// ── Waiver quality enforcement ───────────────────────────────────────

const WAIVER_BLOCKLIST: string[] = [
  'low frequency',
  'rare enough',
  'rarely happens',
  'infrequent',
  'overengineering',
  'over-engineering',
  'not worth',
  'too much work',
  'too much effort',
  'self-correct',
  'self correct',
  'acceptable tradeoff',
  'acceptable trade-off',
  'minor enough',
  'not important enough',
  "won't happen again",
  'unlikely to recur',
  'edge case',
];

function checkWaiverBlocklist(reason: string): string | null {
  const lower = reason.toLowerCase();
  for (const pattern of WAIVER_BLOCKLIST) {
    if (lower.includes(pattern)) return pattern;
  }
  return null;
}

// ── Validation ───────────────────────────────────────────────────────

const STANDARD_DISPOSITIONS = new Set([
  'filed',
  'incident',
  'fixed-in-pr',
  'waived',
]);
const META_DISPOSITIONS = new Set(['filed', 'fixed-in-pr', 'waived']);
const POSITIVE_DISPOSITIONS = new Set([
  'filed',
  'incident',
  'fixed-in-pr',
  'waived',
  'no-action',
]);

function validateImpediments(items: Impediment[]): string[] {
  const errors: string[] = [];

  for (const item of items) {
    const desc = item.impediment || item.finding || '';
    const disposition = item.disposition ?? '';
    const type = item.type ?? '';

    if (!desc) {
      errors.push('missing "impediment" or "finding" field');
      continue;
    }
    if (!disposition) {
      errors.push(`missing "disposition" for: ${desc}`);
      continue;
    }

    // Type-aware disposition validation (kaizen #162, #205, #213)
    if (type === 'meta' && !META_DISPOSITIONS.has(disposition)) {
      errors.push(
        `meta-finding "${desc}" has disposition "${disposition}" \u2014 meta-findings must be "filed" (with ref), "fixed-in-pr", or "waived" (with reason). If it is truly not actionable, use "waived" and explain why.`,
      );
      continue;
    }
    if (type === 'positive' && !POSITIVE_DISPOSITIONS.has(disposition)) {
      errors.push(
        `invalid disposition "${disposition}" for: ${desc} (must be filed|incident|fixed-in-pr|waived|no-action)`,
      );
      continue;
    }
    if (
      type !== 'meta' &&
      type !== 'positive' &&
      !STANDARD_DISPOSITIONS.has(disposition)
    ) {
      errors.push(
        `invalid disposition "${disposition}" for: ${desc} (must be filed|incident|fixed-in-pr|waived)`,
      );
      continue;
    }

    // Ref requirement for filed/incident
    if ((disposition === 'filed' || disposition === 'incident') && !item.ref) {
      errors.push(
        `disposition "${disposition}" requires "ref" field for: ${desc}`,
      );
    }

    // Reason requirement for waived/no-action
    if (
      (disposition === 'waived' || disposition === 'no-action') &&
      !item.reason
    ) {
      errors.push(
        `disposition "${disposition}" requires "reason" field for: ${desc}`,
      );
    }
  }

  return errors;
}

function validateWaiverQuality(
  items: Impediment[],
  gatePrUrl: string,
): string[] {
  const errors: string[] = [];

  const waivedItems = items.filter((i) => i.disposition === 'waived');
  for (const item of waivedItems) {
    const desc = item.impediment || item.finding || '';
    const reason = item.reason ?? '';
    const type = item.type ?? '';

    // Check blocklist
    const matched = checkWaiverBlocklist(reason);
    if (matched) {
      errors.push(
        `waiver for "${desc}" uses blocklisted rationalization "${matched}". Filing an issue is not implementing a fix \u2014 if the observation is true, file it. Reconsider: is this actually not worth a 2-minute issue?`,
      );
    }

    // Meta-findings require impact_minutes (kaizen #280)
    if (type === 'meta') {
      if (item.impact_minutes === undefined || item.impact_minutes === null) {
        errors.push(
          `meta-finding "${desc}" waived without impact_minutes. Add "impact_minutes": N (estimated minutes of agent/human time wasted per occurrence). If impact >= 5, file instead of waiving.`,
        );
      } else if (item.impact_minutes >= 5) {
        errors.push(
          `meta-finding "${desc}" has impact_minutes=${item.impact_minutes} (>= 5 min/occurrence) \u2014 too high to waive. File it: \`gh issue create --repo Garsson-io/kaizen ...\``,
        );
      }
    }

    // Log all waivers to audit trail
    logWaiver(desc, reason, type || 'impediment', gatePrUrl);
  }

  return errors;
}

// ── JSON extraction ──────────────────────────────────────────────────

/**
 * Extract the KAIZEN_IMPEDIMENTS JSON from stdout or command line.
 * Handles: "KAIZEN_IMPEDIMENTS: [...]", "KAIZEN_IMPEDIMENTS: [] reason"
 * Returns { json, emptyReason } where emptyReason is set for "[] reason" format.
 */
function extractImpedimentsJson(
  stdout: string,
  cmdLine: string,
): { json: unknown[] | null; emptyReason: string } {
  // Find raw text after "KAIZEN_IMPEDIMENTS:"
  let rawAfterPrefix = '';
  if (stdout) {
    const match = stdout.match(/KAIZEN_IMPEDIMENTS:\s*([\s\S]*)/);
    if (match) rawAfterPrefix = match[1].replace(/\n/g, ' ').trim();
  }
  if (!rawAfterPrefix) {
    const match = cmdLine.match(/KAIZEN_IMPEDIMENTS:\s*([\s\S]*)/);
    if (match) rawAfterPrefix = match[1].replace(/\n/g, ' ').trim();
  }

  if (!rawAfterPrefix) return { json: null, emptyReason: '' };

  // Try parsing as-is
  try {
    const parsed = JSON.parse(rawAfterPrefix);
    if (Array.isArray(parsed)) return { json: parsed, emptyReason: '' };
  } catch {}

  // Check for "[] reason text" format
  const emptyArrayMatch = rawAfterPrefix.match(/^\[\]\s*(.*)/);
  if (emptyArrayMatch) {
    const reason = emptyArrayMatch[1]
      .trim()
      .replace(/^['"]/, '')
      .replace(/['"]$/, '')
      .trim();
    return { json: [], emptyReason: reason };
  }

  return { json: null, emptyReason: '' };
}

// ── KAIZEN_NO_ACTION handling ────────────────────────────────────────

const VALID_NO_ACTION_CATEGORIES = new Set([
  'docs-only',
  'formatting',
  'typo',
  'config-only',
  'test-only',
  'trivial-refactor',
]);

interface NoActionResult {
  category: string;
  reason: string;
}

function extractNoAction(
  stdout: string,
  cmdLine: string,
): NoActionResult | null {
  // Try extracting from stdout, then command line
  const sources = [stdout, cmdLine].filter(Boolean);

  for (const src of sources) {
    const match = src.match(/KAIZEN_NO_ACTION\s*\[([a-z-]+)\]\s*:\s*(.*)/);
    if (match) {
      return {
        category: match[1],
        reason: match[2]
          .trim()
          .replace(/^['"]/, '')
          .replace(/['"]$/, '')
          .trim(),
      };
    }
  }

  return null;
}

// ── Main ─────────────────────────────────────────────────────────────

function main(): void {
  const input = readHookInput();

  // Only process Bash tool calls
  if (input.tool_name !== 'Bash') exitHook(0);
  if (exitCode(input) !== 0) exitHook(0);

  const command = input.tool_input.command ?? '';
  const stdout = input.tool_response.stdout ?? '';
  const cmdLine = stripHeredocBody(command);

  // Check if there's an active PR kaizen gate (kaizen #239)
  const gateState = findStateWithStatusAnyBranch('needs_pr_kaizen');
  if (!gateState) exitHook(0);

  const gatePrUrl = gateState.prUrl;
  let shouldClear = false;
  let clearReason = '';
  let allPassive = false;

  // ── Trigger 1: KAIZEN_IMPEDIMENTS ──────────────────────────────
  if (
    /KAIZEN_IMPEDIMENTS:/.test(cmdLine) ||
    /KAIZEN_IMPEDIMENTS:/.test(stdout)
  ) {
    const { json, emptyReason } = extractImpedimentsJson(stdout, cmdLine);

    if (json === null) {
      emit(`
KAIZEN_IMPEDIMENTS: Invalid JSON. Expected a JSON array, e.g.:
  echo 'KAIZEN_IMPEDIMENTS: []'
  or
  echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
  [{"impediment": "...", "disposition": "filed", "ref": "#NNN"}]
  IMPEDIMENTS
`);
      exitHook(0);
    }

    if (!Array.isArray(json)) {
      emit(`
KAIZEN_IMPEDIMENTS: Expected a JSON array, got a different type.
  Use [] for no impediments, or [{"impediment": "...", ...}, ...] for a list.
`);
      exitHook(0);
    }

    if (json.length === 0) {
      // Empty array requires a reason (kaizen #140)
      if (!emptyReason) {
        emit(`
KAIZEN_IMPEDIMENTS: Empty array requires a reason.
  Provide a brief justification after the empty array:
  echo 'KAIZEN_IMPEDIMENTS: [] straightforward bug fix, no process issues'

  If your reflection identified ANY concrete improvement, use the full
  structured format with dispositions instead of an empty array.
`);
        exitHook(0);
      }

      logNoAction('empty-array', emptyReason, gatePrUrl);
      shouldClear = true;
      clearReason = `no impediments identified (${emptyReason})`;
    } else {
      // Validate each entry
      const items = json as Impediment[];
      const validationErrors = validateImpediments(items);

      if (validationErrors.length > 0) {
        emit(
          `\nKAIZEN_IMPEDIMENTS: Validation failed:\n${validationErrors.join('\n')}\n\nFix the issues and resubmit.\n`,
        );
        exitHook(0);
      }

      // Waiver quality enforcement (kaizen #280, #258, #198)
      const waiverErrors = validateWaiverQuality(items, gatePrUrl);
      if (waiverErrors.length > 0) {
        emit(
          `\nKAIZEN_IMPEDIMENTS: Waiver quality check failed (kaizen #280):\n${waiverErrors.join('\n')}\n\nKnown anti-patterns:\n- "Low frequency" ignores impact-per-occurrence. A 15-min blocker that happens once a week is worth filing.\n- "Overengineering" confuses filing with implementing. Filing takes 2 min; implementation is a separate decision.\n- "Self-correcting" assumes future agents improve without evidence. They don't \u2014 that's why this check exists.\n\nFix the issues and resubmit. To file: \`gh issue create --repo Garsson-io/kaizen --title "[LN] description" --label kaizen,level-N,area/...\`\n`,
        );
        exitHook(0);
      }

      // All-passive advisory (kaizen #205)
      allPassive = items.every(
        (i) => i.disposition === 'waived' || i.disposition === 'no-action',
      );

      shouldClear = true;
      clearReason = `${items.length} finding(s) addressed`;
    }
  }

  // ── Trigger 2: KAIZEN_NO_ACTION ────────────────────────────────
  if (
    !shouldClear &&
    (/KAIZEN_NO_ACTION/.test(cmdLine) || /KAIZEN_NO_ACTION/.test(stdout))
  ) {
    const noAction = extractNoAction(stdout, cmdLine);

    if (!noAction?.category) {
      emit(`
KAIZEN_NO_ACTION: Missing category. Format: KAIZEN_NO_ACTION [category]: reason
  Valid categories: ${Array.from(VALID_NO_ACTION_CATEGORIES).join(', ')}

  Example: echo 'KAIZEN_NO_ACTION [docs-only]: updated README formatting'

  KAIZEN_NO_ACTION is for trivial changes only. If your reflection
  identified ANY concrete improvement, use KAIZEN_IMPEDIMENTS instead.
`);
      exitHook(0);
    }

    if (!VALID_NO_ACTION_CATEGORIES.has(noAction.category)) {
      emit(`
KAIZEN_NO_ACTION: Invalid category "${noAction.category}".
  Valid categories: ${Array.from(VALID_NO_ACTION_CATEGORIES).join(', ')}

  Example: echo 'KAIZEN_NO_ACTION [docs-only]: updated README formatting'
`);
      exitHook(0);
    }

    if (!noAction.reason) {
      emit(`
KAIZEN_NO_ACTION: Missing reason after category.
  Format: KAIZEN_NO_ACTION [${noAction.category}]: your reason here
`);
      exitHook(0);
    }

    logNoAction(noAction.category, noAction.reason, gatePrUrl);
    shouldClear = true;
    clearReason = `no action needed [${noAction.category}]: ${noAction.reason}`;
  }

  // ── Clear gate if valid ────────────────────────────────────────
  if (shouldClear) {
    if (allPassive) {
      emit(`
All findings waived \u2014 none filed or fixed-in-pr.
"Every failure is a gift \u2014 if you file the issue."
Are any of these actionable at L2+? If so, file them before proceeding.
`);
    }

    clearStateWithStatusAnyBranch('needs_pr_kaizen', gatePrUrl);
    markReflectionDone(gatePrUrl);

    // Auto-close referenced kaizen issues if PR is merged (kaizen #283)
    try {
      const closedCount = autoCloseKaizenIssues(gatePrUrl);
      if (closedCount > 0) {
        emit(
          `Auto-closed ${closedCount} kaizen issue(s) referenced in ${gatePrUrl}\n`,
        );
      }
    } catch {}

    emit(
      `\nPR kaizen gate cleared (${clearReason}). You may proceed with other work.\n`,
    );
  }

  exitHook(0);
}

main();
