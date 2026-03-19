#!/bin/bash
# Build the NanoClaw agent container image with per-branch slot rotation.
# Each branch gets :current and :previous tags. :latest always tracks the last build.
#
# Usage:
#   ./build.sh              # Auto-detect branch, build with slot rotation
#   ./build.sh latest       # Legacy: build with explicit tag (no rotation)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/image-lib.sh"
cd "$SCRIPT_DIR"

EXPLICIT_TAG="${1:-}"

# Legacy mode: explicit tag skips slot rotation (backward compat)
if [ -n "$EXPLICIT_TAG" ]; then
  echo "Building ${IMAGE_NAME}:${EXPLICIT_TAG} (explicit tag, no rotation)..."
  "${CONTAINER_RUNTIME}" build -t "${IMAGE_NAME}:${EXPLICIT_TAG}" .
  echo ""
  echo "Build complete! Image: ${IMAGE_NAME}:${EXPLICIT_TAG}"
  exit 0
fi

# Detect and sanitize branch name
RAW_BRANCH=$(detect_branch)
BRANCH_TAG=$(sanitize_branch "$RAW_BRANCH")

echo "Building NanoClaw agent container image..."
echo "Branch: ${RAW_BRANCH} -> tag prefix: ${BRANCH_TAG}"

# Step 1: Build to a temporary tag so we can verify before rotating
BUILD_TAG="build-temp"
echo "Building ${IMAGE_NAME}:${BUILD_TAG}..."
if ! "${CONTAINER_RUNTIME}" build -t "${IMAGE_NAME}:${BUILD_TAG}" .; then
  echo ""
  echo "Build FAILED. ${BRANCH_TAG}-current unchanged."
  # Clean up temp tag if it was partially created
  "${CONTAINER_RUNTIME}" rmi "${IMAGE_NAME}:${BUILD_TAG}" 2>/dev/null || true
  exit 1
fi

# Step 2: Rotate slots — current becomes previous
CURRENT_TAG="${BRANCH_TAG}-current"
PREVIOUS_TAG="${BRANCH_TAG}-previous"

if image_exists "$CURRENT_TAG"; then
  echo "Rotating: ${CURRENT_TAG} -> ${PREVIOUS_TAG}"
  # Remove old previous if it exists
  if image_exists "$PREVIOUS_TAG"; then
    "${CONTAINER_RUNTIME}" rmi "${IMAGE_NAME}:${PREVIOUS_TAG}" 2>/dev/null || true
  fi
  # Tag current as previous
  "${CONTAINER_RUNTIME}" tag "${IMAGE_NAME}:${CURRENT_TAG}" "${IMAGE_NAME}:${PREVIOUS_TAG}"
fi

# Step 3: Promote build to current
echo "Promoting: ${BUILD_TAG} -> ${CURRENT_TAG}"
"${CONTAINER_RUNTIME}" tag "${IMAGE_NAME}:${BUILD_TAG}" "${IMAGE_NAME}:${CURRENT_TAG}"
# Remove the temp build tag
"${CONTAINER_RUNTIME}" rmi "${IMAGE_NAME}:${BUILD_TAG}" 2>/dev/null || true

# Step 4: Update :latest for backward compatibility
echo "Updating :latest -> ${CURRENT_TAG}"
"${CONTAINER_RUNTIME}" tag "${IMAGE_NAME}:${CURRENT_TAG}" "${IMAGE_NAME}:latest"

# Step 5: Clean up dangling images
"${CONTAINER_RUNTIME}" image prune -f >/dev/null 2>&1 || true

echo ""
echo "Build complete!"
echo "  Current:  ${IMAGE_NAME}:${CURRENT_TAG}"
if image_exists "$PREVIOUS_TAG"; then
  echo "  Previous: ${IMAGE_NAME}:${PREVIOUS_TAG}"
fi
echo "  Latest:   ${IMAGE_NAME}:latest"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:latest"
