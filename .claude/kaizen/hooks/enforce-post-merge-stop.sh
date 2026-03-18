#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# enforce-post-merge-stop.sh — Level 2 kaizen enforcement (Issue #96)
# Stop hook: prevents Claude from finishing when post-merge steps are pending.
#
# After a PR is merged, the agent MUST complete:
#   1. Kaizen reflection (run /kaizen skill)
#   2. Case closure (mark case done if applicable)
#   3. Main sync (git fetch + merge origin/main)
#
# Flow:
#   gh pr merge → pr-review-loop.sh writes STATUS=needs_post_merge
#   → Agent tries to stop → THIS HOOK blocks
#   → Agent runs /kaizen → post-merge-clear.sh clears state
#   → Agent can stop
#
# Exit 0 with no output = allow stop
# Exit 0 with JSON {"decision":"block","reason":"..."} = block stop

source "$(dirname "$0")/lib/state-utils.sh"

INPUT=$(cat)

# Check for pending post-merge workflow
STATE_INFO=$(find_state_with_status "needs_post_merge")
if [ $? -ne 0 ] || [ -z "$STATE_INFO" ]; then
  # No pending post-merge steps — allow stop
  exit 0
fi

PR_URL=$(echo "$STATE_INFO" | cut -d'|' -f1)

# Block stop: agent must complete post-merge workflow first.
jq -n \
  --arg pr_url "$PR_URL" \
  '{
    decision: "block",
    reason: ("STOP BLOCKED: Post-merge workflow is incomplete.\n\nPR: " + $pr_url + "\n\nYou MUST complete these steps before finishing:\n\n1. Run `/kaizen` — reflect on impediments, what you'"'"'d do differently, process friction\n2. Mark the case as done (if a case exists for this work)\n3. Sync main: `git -C /home/aviadr1/projects/nanoclaw fetch origin main && git -C /home/aviadr1/projects/nanoclaw merge origin/main --no-edit`\n4. Update linked kaizen issue if applicable\n\nThe /kaizen skill will clear this gate when complete.")
  }'

exit 0
