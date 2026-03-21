#!/bin/bash
# Thin wrapper: delegates to TypeScript implementation.
# Migrated from pr-review-loop.sh (452 lines) → src/hooks/pr-review-loop.ts
# See: Garsson-io/kaizen#320, docs/hook-language-boundaries.md Phase 3
exec npx tsx "$(git rev-parse --show-toplevel)/src/hooks/pr-review-loop.ts"
