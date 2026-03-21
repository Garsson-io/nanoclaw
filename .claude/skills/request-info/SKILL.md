---
name: request-info
description: Request structured information from stakeholders (Aviad, Liraz, or others) via a GitHub issue with fillable questionnaires, embedded screenshots, and downloadable files. Use when you need human input to proceed — workflow priorities, permission decisions, domain knowledge, or configuration choices. Triggers on "request info", "ask stakeholders", "need input from", "questionnaire", "ask aviad", "ask liraz", "get answers".
---

# Request Structured Information from Stakeholders

**Role:** Create a well-structured GitHub issue that makes it easy for non-technical stakeholders to provide the information you need. Produces fillable spreadsheets, embeds screenshots, and provides clear tables with checkboxes.

**When to use:**
- You need human decisions before proceeding (permissions, priorities, workflow choices)
- You've explored a system and need domain knowledge to interpret what you found
- You need configuration choices that only the business owner can make
- You want to present options with visual context (screenshots, diagrams)

**When NOT to use:**
- You can find the answer in code, docs, or by testing
- The question is purely technical (ask in the conversation instead)
- The answer is already documented somewhere

## Principles

1. **Make answering easy.** Provide checkboxes, tables, and fill-in-the-blank — not open-ended questions. Stakeholders are busy; reduce their effort to marking X's and short phrases.
2. **Show, don't just tell.** Embed screenshots directly in the issue body so stakeholders see exactly what you're asking about. Reference specific UI elements by their Hebrew labels.
3. **Provide multiple response formats.** Some people prefer filling a spreadsheet, others prefer commenting inline. Support both.
4. **Include context.** Explain WHY you need each piece of information and what you'll do with the answer.
5. **Be specific.** "Which of these 12 actions need approval?" beats "What permissions should the agent have?"

## Output Artifacts

Every request-info invocation produces:

| Artifact | Format | Purpose |
|----------|--------|---------|
| Questionnaire spreadsheet | CSV (UTF-8 BOM for Hebrew) | Fillable in Excel/Google Sheets |
| GitHub issue | Markdown with embedded images | Self-contained visual context |
| Documentation file | Markdown in `docs/` | Durable reference for the answers |
| Screenshots | PNG in `docs/screenshots/` | Visual context for questions |

## Procedure

### Step 1: Identify what you need

List the specific decisions/information you need. For each item:
- What is the question?
- What are the options? (provide them — don't ask open-ended)
- What will you do with the answer?
- Who can answer? (Aviad, Liraz, both, other)

### Step 2: Gather visual context

If the questions relate to a UI or system:
- Take screenshots of the relevant pages/screens
- Save to `docs/screenshots/` in the appropriate repo
- Use descriptive filenames (e.g., `roeto-tasks-page.png`, not `screenshot1.png`)
- Ensure text is readable (check font/encoding — Hebrew needs `fonts-noto-core`)

### Step 3: Create the questionnaire CSV

Generate a CSV file with:
- **UTF-8 BOM** (`\uFEFF` prefix) for Hebrew support in Excel
- Column headers: descriptive, with instructions in row 2
- Section separators (rows with `--- SECTION NAME ---`)
- Checkbox columns marked `(mark X)`
- Free-text columns for notes/answers
- Save to `docs/` in the appropriate repo

```javascript
// Template for CSV generation
const BOM = '\uFEFF';
const rows = [
  ['Item', 'Hebrew', 'Context', 'Option A', 'Option B', 'Option C', 'Notes'],
  ['', '', '', '(mark X)', '(mark X)', '(mark X)', ''],
  ['--- SECTION ---', '', '', '', '', '', ''],
  ['Question 1', 'עברית', 'Where in the UI', '', '', '', ''],
];
const csv = BOM + rows.map(r => r.map(c => '"' + c.replace(/"/g, '""') + '"').join(',')).join('\n');
require('fs').writeFileSync('docs/questionnaire.csv', csv);
```

### Step 4: Create the GitHub issue

Structure the issue body with:

1. **Context section** — what you did, what you found, why you need input
2. **How to respond** — two options: fill CSV or answer inline
3. **File links** — direct links to docs, CSV, raw data in the repo
4. **Embedded screenshots** — for private repos, use the blob URL with `?raw=true` (NOT `raw.githubusercontent.com` which breaks for private repos):
   ```
   ![Description](https://github.com/{org}/{repo}/blob/main/docs/screenshots/{file}.png?raw=true)
   ```
5. **Fillable tables** — with checkbox characters (☐) for quick inline answers
6. **Specific questions** — numbered, with options, not open-ended

Use `gh issue create` or `gh issue edit` to set the body.

### Step 5: Commit and push all artifacts

Commit the CSV, screenshots, and documentation to the repo BEFORE creating/updating the issue, so all links work immediately.

### Step 6: Link everything

- Issue body links to repo files
- Repo docs reference the issue number
- CSV filename matches the issue topic

## Processing Responses — MANDATORY

When stakeholder responses come back (filled CSV, comments, documents):

### Rule 1: Use a proper CSV parser — NEVER hand-parse

```javascript
// WRONG — strips empty columns, shifts positional data
const cols = line.split(',').filter(c => c); // BUG: "","","x" becomes ["x"]

// RIGHT — use a real parser that preserves column positions
const { parse } = require('csv-parse/sync');
const records = parse(csvContent, { columns: true, bom: true, skip_empty_lines: true });
// Each record is { "Action": "...", "Autonomous?": "", "Never Automate?": "x" }
```

This is not optional. A hand-rolled parser once inverted an entire permission model — 21 "Never automate" actions were classified as "Autonomous" because `.filter(c => c)` collapsed empty columns.

### Rule 2: Explain back BEFORE acting

After parsing responses, ALWAYS present a summary to the user before creating configs, PRs, or code:

> "Here's what I understood from your answers:
> - 0 autonomous actions
> - 17 actions need Liraz's approval
> - 21 actions are forbidden
> Does this match your intent?"

Wait for confirmation. Then build.

### Rule 3: Install the parser

Add `csv-parse` to the tools that process questionnaire responses:
```bash
npm install csv-parse  # in the vertical's tools/
```

## Template: Issue Body Structure

```markdown
## Context
[What you explored/discovered and why you need input]

## How to respond
### Option A: Fill the questionnaire
1. Download: [`docs/{filename}.csv`](link)
2. Open in Excel or Google Sheets
3. Fill in the columns
4. Upload as a comment on this issue

### Option B: Answer in comments
Reply to this issue with your answers inline.

## Documentation
| File | Description |
|------|-------------|
| [`docs/file.md`](link) | Description |
| [`docs/file.csv`](link) | Fillable questionnaire |

## Screenshots
![Page Name](https://raw.githubusercontent.com/{org}/{repo}/main/docs/screenshots/{file}.png)

## Questions
### 1. [Topic]
| Option | Description | Choose |
|--------|-------------|:------:|
| A | ... | ☐ |
| B | ... | ☐ |

### 2. [Topic]
[Fillable table with checkboxes]

## Summary of what we found
[Tables, counts, key findings that inform the questions]
```

## Example Usage

The Roeto workflow prioritization (garsson-insurance#14) is the reference implementation:
- 69-row questionnaire CSV with action permissions + workflow priorities + general questions
- 8 embedded screenshots showing every key page
- Tables with ☐ checkboxes for inline answers
- Links to 4 documentation files (action map, app map, raw data, questionnaire)
- Sections for both checkbox answers and free-text responses

## Anti-patterns

- **Don't ask questions you can answer yourself** — search the code, docs, and git history first
- **Don't send a wall of text** — stakeholders will skip it. Lead with the table, add context below
- **Don't ask one question per issue** — batch related questions into one well-organized issue
- **Don't forget screenshots** — a picture of the UI element is worth 100 words of description
- **Don't use English-only** — if the stakeholders work in Hebrew, include Hebrew labels alongside English
- **Don't hand-parse CSV** — use `csv-parse` or equivalent. Empty columns WILL be silently dropped
- **Don't act on parsed data without confirming** — always explain back what you understood first
