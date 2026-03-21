#!/bin/bash
# Thin wrapper: delegates to TypeScript implementation.
# Migrated from pr-kaizen-clear.sh (290 lines) → src/hooks/pr-kaizen-clear.ts
# See: Garsson-io/kaizen#320, docs/hook-language-boundaries.md Phase 3
exec npx tsx "$(git rev-parse --show-toplevel)/src/hooks/pr-kaizen-clear.ts"
