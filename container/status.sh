#!/bin/bash
# Docker image status for NanoClaw.
# Shows all nanoclaw-agent images, cross-referenced with worktree/case status.
#
# Usage:
#   ./status.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/image-lib.sh"

echo "NanoClaw Docker Image Status"
echo "============================"
echo ""

# Collect active branches for cross-reference
ACTIVE_BRANCHES=$(mktemp)
{
  active_worktree_branches
  active_case_branches
} | sort -u > "$ACTIVE_BRANCHES"

# Show all nanoclaw-agent images
echo "Tagged images:"
ALL_TAGS=$(list_image_tags 2>/dev/null || true)
if [ -z "$ALL_TAGS" ]; then
  echo "  (none)"
else
  for tag in $ALL_TAGS; do
    if [ "$tag" = "<none>" ]; then continue; fi
    size=$(image_size "$tag")
    created=$(image_created "$tag")

    # Determine status
    status=""
    if [ "$tag" = "latest" ]; then
      status="[compat]"
    elif echo "$tag" | grep -qE '-(current|previous)$'; then
      branch_prefix=$(echo "$tag" | sed 's/-\(current\|previous\)$//')
      is_active=false
      while IFS= read -r active_branch; do
        sanitized=$(sanitize_branch "$active_branch")
        if [ "$sanitized" = "$branch_prefix" ]; then
          is_active=true
          break
        fi
      done < "$ACTIVE_BRANCHES"
      if $is_active; then
        status="[active]"
      else
        status="[stale]"
      fi
    fi

    printf "  %-50s %8s  %s  %s\n" "${IMAGE_NAME}:${tag}" "$size" "$created" "$status"
  done
fi
echo ""

# Dangling images
dangling=$(count_dangling_images)
echo "Dangling images: $dangling"

# Build cache
echo ""
echo "Build cache:"
${CONTAINER_RUNTIME} system df --format '{{.Type}}\t{{.TotalCount}}\t{{.Size}}\t{{.Reclaimable}}' 2>/dev/null | \
  grep -i "build" | while IFS=$'\t' read -r type count size reclaimable; do
    echo "  Entries: $count  Size: $size  Reclaimable: $reclaimable"
  done || echo "  (unable to query)"

# Soft cap
echo ""
soft_cap=$(calculate_soft_cap)
tagged_count=$(count_tagged_images)
echo "Soft cap: $soft_cap (based on active cases + 1 stable work container)"
echo "Current tagged images: $tagged_count"
if [ "$tagged_count" -gt "$soft_cap" ]; then
  echo "  WARNING: Exceeds soft cap. Run ./gc.sh to clean up stale images."
fi

# VHDX info (WSL only)
if [ -f /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
  echo ""
  VHDX_PATH="/mnt/c/Users/$(cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d '\r')/AppData/Local/Docker/wsl/disk/docker_data.vhdx"
  if [ -f "$VHDX_PATH" ]; then
    vhdx_size=$(du -sh "$VHDX_PATH" 2>/dev/null | cut -f1)
    echo "WSL Docker VHDX: $vhdx_size"
    # Show actual Docker disk usage for comparison
    actual=$(${CONTAINER_RUNTIME} system df --format '{{.Size}}' 2>/dev/null | paste -sd+ | bc 2>/dev/null || echo "unknown")
    echo "  VHDX does not auto-shrink. Use 'wsl --shutdown && diskpart' to compact."
  fi
fi

echo ""

# Cleanup
rm -f "$ACTIVE_BRANCHES"
