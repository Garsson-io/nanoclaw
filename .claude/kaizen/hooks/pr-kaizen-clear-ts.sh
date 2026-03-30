#!/bin/bash
# Thin bash wrapper for pr-kaizen-clear.ts (TypeScript migration of pr-kaizen-clear.sh)
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# Migration: kaizen #320 (Phase 3 of #223)
#
# Always exits 0 — state management hook (PostToolUse).

# Subshell ensures exit 0 is always reachable even if source fails (kaizen #371)
(source "$(dirname "$0")/lib/resolve-project-root.sh" && exec npx tsx "$PROJECT_ROOT/src/hooks/pr-kaizen-clear.ts") 2>/dev/null
exit 0
