#!/bin/bash
# Thin wrapper: delegates to TypeScript implementation.
# Migrated from kaizen-reflect.sh (197 lines) → src/hooks/kaizen-reflect.ts
# See: Garsson-io/kaizen#320, docs/hook-language-boundaries.md Phase 3
exec npx tsx "$(git rev-parse --show-toplevel)/src/hooks/kaizen-reflect.ts"
