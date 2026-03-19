#!/bin/bash
# Docker image garbage collection for NanoClaw.
# Removes stale branch image slots, dangling images, and unreferenced build cache.
#
# A branch's slots are "stale" when BOTH:
#   1. No local worktree exists for that branch
#   2. No active case references that branch
#
# Usage:
#   ./gc.sh          # Dry run (show what would be removed)
#   ./gc.sh --force  # Actually remove stale images

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/image-lib.sh"

DRY_RUN=true
if [ "${1:-}" = "--force" ]; then
  DRY_RUN=false
fi

echo "NanoClaw Docker Image GC"
echo "========================"
echo ""

# Collect active branches from worktrees and cases
ACTIVE_BRANCHES=$(mktemp)
{
  active_worktree_branches
  active_case_branches
} | sort -u > "$ACTIVE_BRANCHES"

active_count=$(wc -l < "$ACTIVE_BRANCHES" | tr -d ' ')
echo "Active branches (worktree or case): $active_count"

# Get all branch-prefixed tags (pattern: {branch}-current or {branch}-previous)
STALE_TAGS=$(mktemp)
ACTIVE_TAGS=$(mktemp)
ALL_TAGS=$(list_image_tags '-(current|previous)$' 2>/dev/null || true)

for tag in $ALL_TAGS; do
  # Extract branch prefix: remove -current or -previous suffix
  branch_prefix=$(echo "$tag" | sed 's/-\(current\|previous\)$//')

  # Check if any active branch sanitizes to this prefix
  is_active=false
  while IFS= read -r active_branch; do
    sanitized=$(sanitize_branch "$active_branch")
    if [ "$sanitized" = "$branch_prefix" ]; then
      is_active=true
      break
    fi
  done < "$ACTIVE_BRANCHES"

  if $is_active; then
    echo "$tag" >> "$ACTIVE_TAGS"
  else
    echo "$tag" >> "$STALE_TAGS"
  fi
done

stale_count=$(wc -l < "$STALE_TAGS" 2>/dev/null | tr -d ' ')
active_tag_count=$(wc -l < "$ACTIVE_TAGS" 2>/dev/null | tr -d ' ')

echo "Active image tags: $active_tag_count"
echo "Stale image tags:  $stale_count"
echo ""

# Remove stale tags
if [ "$stale_count" -gt 0 ]; then
  echo "Stale images to remove:"
  while IFS= read -r tag; do
    size=$(image_size "$tag")
    echo "  ${IMAGE_NAME}:${tag} ($size)"
    if ! $DRY_RUN; then
      ${CONTAINER_RUNTIME} rmi "${IMAGE_NAME}:${tag}" 2>/dev/null || true
    fi
  done < "$STALE_TAGS"
  echo ""
fi

# Clean dangling images
dangling=$(count_dangling_images)
if [ "$dangling" -gt 0 ]; then
  echo "Dangling images: $dangling"
  if ! $DRY_RUN; then
    ${CONTAINER_RUNTIME} image prune -f
  fi
  echo ""
fi

# Prune unreferenced build cache
if ! $DRY_RUN; then
  echo "Pruning unreferenced build cache..."
  ${CONTAINER_RUNTIME} builder prune -f 2>/dev/null || true
  echo ""
fi

# VHDX advisory (WSL only)
if [ -f /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
  VHDX_PATH="/mnt/c/Users/$(cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d '\r')/AppData/Local/Docker/wsl/disk/docker_data.vhdx"
  if [ -f "$VHDX_PATH" ]; then
    vhdx_size=$(du -sh "$VHDX_PATH" 2>/dev/null | cut -f1)
    echo "WSL VHDX size: $vhdx_size"
    echo "Note: VHDX does not auto-shrink. To reclaim host disk space:"
    echo "  wsl --shutdown && diskpart (select vdisk, compact)"
    echo ""
  fi
fi

# Summary
if $DRY_RUN; then
  echo "DRY RUN — no changes made. Run with --force to remove stale images."
else
  echo "GC complete."
fi

# Cleanup temp files
rm -f "$ACTIVE_BRANCHES" "$STALE_TAGS" "$ACTIVE_TAGS"
