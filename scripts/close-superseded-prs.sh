#!/usr/bin/env bash
# close-superseded-prs.sh — Auto-close PRs whose kaizen issues are already resolved
#
# Usage:
#   ./scripts/close-superseded-prs.sh [--dry-run]
#
# When multiple overnight-dent runs target the same kaizen backlog, they can
# produce overlapping PRs. This script detects PRs whose referenced kaizen
# issues are already closed and auto-closes them with a comment.
#
# Part of kaizen #318 — prevents wasted review time on superseded PRs.

set -euo pipefail

DRY_RUN=false
REPO="${REPO:-Garsson-io/nanoclaw}"
KAIZEN_REPO="${KAIZEN_REPO:-Garsson-io/kaizen}"

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      sed -n '2,/^$/{ s/^# //; s/^#//; p; }' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

closed=0
checked=0

# Get all open PRs
prs=$(gh pr list --repo "$REPO" --state open --json number,title,body,headRefName --limit 100 2>/dev/null)
[ -z "$prs" ] && { echo "No open PRs found."; exit 0; }

echo "$prs" | jq -c '.[]' | while IFS= read -r pr; do
  pr_num=$(echo "$pr" | jq -r '.number')
  pr_title=$(echo "$pr" | jq -r '.title')
  pr_body=$(echo "$pr" | jq -r '.body // ""')

  checked=$((checked + 1))

  # Extract kaizen issue references from PR body
  # Patterns: Garsson-io/kaizen#NNN, kaizen/issues/NNN, (kaizen #NNN)
  issue_nums=""

  # Match: Garsson-io/kaizen#NNN or Garsson-io/kaizen/issues/NNN
  refs=$(echo "$pr_body" | grep -oP 'Garsson-io/kaizen[#/issues/]*\K[0-9]+' 2>/dev/null | sort -un || true)

  # Match: https://github.com/Garsson-io/kaizen/issues/NNN
  url_refs=$(echo "$pr_body" | grep -oP 'https://github\.com/Garsson-io/kaizen/issues/\K[0-9]+' 2>/dev/null | sort -un || true)

  # Match: (kaizen #NNN) in title or body
  title_refs=$(echo "$pr_title" | grep -oP 'kaizen\s*#\K[0-9]+' 2>/dev/null || true)
  body_refs=$(echo "$pr_body" | grep -oP 'kaizen\s*#\K[0-9]+' 2>/dev/null || true)

  # Combine and deduplicate
  issue_nums=$(printf '%s\n%s\n%s\n%s' "$refs" "$url_refs" "$title_refs" "$body_refs" | sort -un | grep -v '^$' || true)

  [ -z "$issue_nums" ] && continue

  # Check if ALL referenced kaizen issues are closed
  all_closed=true
  closed_issues=""
  open_issues=""

  while IFS= read -r issue_num; do
    [ -z "$issue_num" ] && continue
    state=$(gh issue view "$issue_num" --repo "$KAIZEN_REPO" --json state --jq .state 2>/dev/null || echo "UNKNOWN")
    if [ "$state" = "CLOSED" ]; then
      closed_issues="${closed_issues:+$closed_issues, }#$issue_num"
    else
      all_closed=false
      open_issues="${open_issues:+$open_issues, }#$issue_num($state)"
    fi
  done <<< "$issue_nums"

  if $all_closed && [ -n "$closed_issues" ]; then
    if $DRY_RUN; then
      echo "WOULD CLOSE: PR #$pr_num ($pr_title) — kaizen issues already resolved: $closed_issues"
    else
      gh pr close "$pr_num" --repo "$REPO" --comment "Auto-closed: all referenced kaizen issues are already resolved ($closed_issues). This PR is superseded.

Closed by \`close-superseded-prs.sh\` (kaizen #318)." 2>/dev/null
      echo "CLOSED: PR #$pr_num ($pr_title) — kaizen issues: $closed_issues"
    fi
    closed=$((closed + 1))
  fi
done

echo ""
echo "Done. Checked PRs, closed $closed superseded."
$DRY_RUN && echo "(Dry run — no PRs were actually closed)"
