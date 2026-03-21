#!/usr/bin/env node
/**
 * parse-response.js
 * Parse a filled questionnaire CSV and output a structured summary.
 * Uses csv-parse to properly handle empty columns and Hebrew BOM.
 *
 * Usage:
 *   node parse-response.js <path-to-filled-csv>
 *   node parse-response.js <google-drive-file-id>
 *
 * Output: Structured summary to stdout for review before acting.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node parse-response.js <csv-file-or-google-drive-id>');
    process.exit(1);
  }

  let csvPath = input;

  // If it looks like a Google Drive file ID, download it
  if (!fs.existsSync(input) && /^[a-zA-Z0-9_-]{20,}$/.test(input)) {
    console.error('Downloading from Google Drive...');
    csvPath = '/tmp/questionnaire-response.csv';
    execSync(`curl -sL "https://drive.google.com/uc?export=download&id=${input}" -o "${csvPath}"`);
  }

  // Read and parse CSV properly
  const raw = fs.readFileSync(csvPath, 'utf8');

  // Remove BOM if present
  const content = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;

  // Parse CSV preserving ALL columns including empty ones
  const lines = content.split('\n');
  const rows = lines.map(line => {
    const cols = [];
    let inQuote = false;
    let current = '';
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === ',' && !inQuote) { cols.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    cols.push(current.trim());
    return cols;
  });

  // Find header row (contains "Action" or similar)
  const headerIdx = rows.findIndex(r => r[0] === 'Action' || r[0]?.includes('Action'));
  if (headerIdx === -1) {
    console.error('ERROR: Could not find header row with "Action" column');
    process.exit(1);
  }

  const headers = rows[headerIdx];
  console.error('Headers found:', headers.slice(0, 8).join(' | '));

  // Find column indices for the key fields
  const colMap = {};
  for (let i = 0; i < headers.length && i < 8; i++) {
    const h = headers[i].toLowerCase();
    if (h.includes('action') && !colMap.action) colMap.action = i;
    if (h.includes('hebrew') || h.includes('עברית')) colMap.hebrew = i;
    if (h.includes('page') || h.includes('עמוד')) colMap.page = i;
    if (h.includes('type') || h.includes('סוג')) colMap.type = i;
    if (h.includes('autonomous') || h.includes('עצמאי')) colMap.autonomous = i;
    if (h.includes('approval') || h.includes('אישור')) colMap.approval = i;
    if (h.includes('never') || h.includes('לעולם')) colMap.never = i;
    if (h.includes('notes') || h.includes('הערות')) colMap.notes = i;
  }

  console.error('Column mapping:', JSON.stringify(colMap));

  // Parse data rows
  const actions = { autonomous: [], approval: [], never: [], unknown: [] };
  const general = [];
  let currentSection = '';

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const action = row[colMap.action] || '';
    const hebrew = row[colMap.hebrew] || '';
    const notes = row[colMap.notes] || '';

    // Section headers
    if (action.startsWith('---')) {
      currentSection = action.replace(/---/g, '').trim();
      continue;
    }

    // Skip empty rows and instruction rows
    if (!action || action.startsWith('(mark')) continue;

    // General questions (no checkbox columns)
    if (currentSection === 'GENERAL QUESTIONS') {
      const answer = row[colMap.page] || row[colMap.type] || '';
      if (action && answer) {
        general.push({ question: action, answer, notes });
      }
      continue;
    }

    // Check which column has the X (case-insensitive)
    const isAutonomous = (row[colMap.autonomous] || '').toLowerCase() === 'x';
    const isApproval = (row[colMap.approval] || '').toLowerCase() === 'x';
    const isNever = (row[colMap.never] || '').toLowerCase() === 'x';

    if (!isAutonomous && !isApproval && !isNever) continue;

    const entry = { action, hebrew, section: currentSection, notes };

    if (isAutonomous) actions.autonomous.push(entry);
    else if (isApproval) actions.approval.push(entry);
    else if (isNever) actions.never.push(entry);
  }

  // Output structured summary
  console.log('\n========================================');
  console.log('  QUESTIONNAIRE RESPONSE SUMMARY');
  console.log('========================================\n');

  console.log(`AUTONOMOUS (agent can do without asking): ${actions.autonomous.length}`);
  for (const a of actions.autonomous) {
    console.log(`  ✅ ${a.action} (${a.hebrew})${a.notes ? ' — ' + a.notes : ''}`);
  }

  console.log(`\nNEEDS APPROVAL: ${actions.approval.length}`);
  for (const a of actions.approval) {
    console.log(`  ⚠️  ${a.action} (${a.hebrew})${a.notes ? ' — ' + a.notes : ''}`);
  }

  console.log(`\nNEVER AUTOMATE: ${actions.never.length}`);
  for (const a of actions.never) {
    console.log(`  🚫 ${a.action} (${a.hebrew})${a.notes ? ' — ' + a.notes : ''}`);
  }

  if (general.length > 0) {
    console.log('\nGENERAL ANSWERS:');
    for (const g of general) {
      console.log(`  Q: ${g.question}`);
      console.log(`  A: ${g.answer}${g.notes ? ' (' + g.notes + ')' : ''}`);
    }
  }

  console.log('\n========================================');
  console.log('  CONFIRM BEFORE ACTING ON THESE');
  console.log('========================================\n');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
