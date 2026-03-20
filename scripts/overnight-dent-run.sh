#!/bin/bash
# overnight-dent-run — Thin wrapper for trampoline compatibility.
#
# The trampoline (overnight-dent.sh) calls this script by path.
# This delegates to the TypeScript runner which has real-time
# stream-json observability.
#
# Usage: overnight-dent-run.sh <state-file>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec npx tsx "$SCRIPT_DIR/overnight-dent-run.ts" "$@"
