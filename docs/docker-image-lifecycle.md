# Docker Image Lifecycle Management

How NanoClaw manages Docker images across branches, when images are cleaned up, and what operators need to know.

## How It Works

### Per-Branch Slot Rotation

Every `./container/build.sh` invocation creates per-branch image slots:

```
nanoclaw-agent:{branch}-current    ← latest build for this branch
nanoclaw-agent:{branch}-previous   ← rollback target (previous build)
nanoclaw-agent:latest              ← always points to the last-built :current
```

Branch names are sanitized for Docker tags: `case/260319-k182-docker-lifecycle` becomes `case-260319-k182-docker-lifecycle`.

### Build Flow

```
./container/build.sh
  │
  ├─ Detect branch from git
  ├─ Build to temp tag (nanoclaw-agent:build-temp)
  │
  ├─ On FAILURE: temp tag removed, :current unchanged
  │
  └─ On SUCCESS:
       ├─ Rotate: current → previous (old previous deleted)
       ├─ Promote: build-temp → current
       ├─ Update: latest → current
       └─ Prune dangling images
```

### Backward Compatibility

`container-runner.ts`, `dev-session.ts`, and `router-container.ts` all reference `CONTAINER_IMAGE` from config, which defaults to `nanoclaw-agent:latest`. The `:latest` tag is always maintained by `build.sh`, so **no runtime code changes were needed**.

Legacy usage (`./container/build.sh latest`) still works — it builds with the explicit tag and skips slot rotation.

## Staleness Detection

An image slot is "stale" when **both** conditions are true:

1. No local worktree exists for that branch (`git worktree list`)
2. No active case references that branch (case DB: status not in `done`, `reviewed`, `pruned`)

An image slot is "active" when **either**:
- A worktree exists for that branch
- An active/blocked case references that branch

This piggybacks on the existing case lifecycle rather than inventing parallel tracking.

## Soft Cap

The soft cap limits how many tagged images should exist. Formula:

```
soft_cap = (active_case_count + 1) × 2
```

- `active_case_count`: cases in `suggested`, `backlog`, `active`, or `blocked` status
- `+1`: stable work container (always needed)
- `×2`: each branch gets `current` + `previous` slots

When the image count exceeds the soft cap, the startup advisory warns and `gc.sh` can clean up.

## Startup Advisory

At NanoClaw startup, `checkImageAdvisory()` runs alongside `cleanupOrphans()`. It:

- Counts tagged `nanoclaw-agent` images
- Counts dangling `<none>` images
- Warns if dangling count exceeds 3
- Warns if tagged count exceeds 10 (heuristic threshold)
- Logs image inventory at info level

This is advisory only — it never deletes images automatically.

## Operating Policy

### When to Build

Build when you change container-affecting code:
- `container/Dockerfile` changes
- `container/agent-runner/` source changes
- `container/entrypoint.sh` or `container/dev-entrypoint.sh` changes
- `container/skills/` changes (new or modified skills)

Build is **not** needed for:
- `src/` changes (harness code, not container code)
- `CLAUDE.md` or `docs/` changes
- Vertical repo changes (mounted live)

### When to Run GC

Run `./container/gc.sh` when:
- The startup advisory warns about image count
- You're running low on disk space
- After merging and pruning several case worktrees
- Periodically (weekly during active development)

Always start with a **dry run** (no arguments) to review what would be removed:
```bash
./container/gc.sh          # Dry run — shows stale images
./container/gc.sh --force  # Actually removes them
```

### When to Check Status

Run `./container/status.sh` to get a snapshot:
- All tagged images with active/stale classification
- Dangling image count
- Build cache size and reclaimable space
- Soft cap vs current count
- VHDX size (WSL only)

## Cleanup Policy

### What Gets Cleaned

| Resource | Cleaned by | When |
|----------|-----------|------|
| Dangling `<none>` images | `build.sh` (after each build) | Every build |
| Stale branch slots | `gc.sh --force` | Manual or advisory |
| Unreferenced build cache | `gc.sh --force` | Manual |
| Active branch slots | Never auto-removed | Protected |
| `:latest` tag | Retagged on build | Every build |

### What Is Never Auto-Removed

- `:current` for branches with active worktrees
- `:current` for branches with active cases
- `:latest` (always retagged, never removed)
- Build cache referenced by existing images (base layers critical for fast rebuilds)

### VHDX Compaction (WSL Only)

Docker Desktop on WSL stores data in a VHDX file that **grows but never auto-shrinks**. Even after `gc.sh` removes images inside Docker, the host disk space is not reclaimed.

To compact:
```bash
wsl --shutdown
# Then in PowerShell as admin:
diskpart
select vdisk file="C:\Users\{username}\AppData\Local\Docker\wsl\disk\docker_data.vhdx"
compact vdisk
exit
```

This is destructive (requires shutting down WSL). Only do it when disk space is critically low.

## Scripts Reference

| Script | Purpose | Usage |
|--------|---------|-------|
| `container/build.sh` | Build with slot rotation | `./container/build.sh` (auto) or `./container/build.sh <tag>` (legacy) |
| `container/gc.sh` | Garbage collect stale images | `./container/gc.sh` (dry run) or `./container/gc.sh --force` |
| `container/status.sh` | Disk accounting and status | `./container/status.sh` |
| `container/image-lib.sh` | Shared library (sourced, not executed) | `source container/image-lib.sh` |

## Future Work (Deferred)

- **rollback.sh**: Swap `{branch}:current` ↔ `{branch}:previous`. Deferred because "just rebuild" is the practical response.
- **Golden/stable promotion**: `:stable` (auto-promoted on green CI) and `:golden` (manually promoted, never auto-evicted). Deferred until CI integration is designed.
- **Automatic GC on case prune**: Hook into `pruneCaseWorkspace()` to trigger image slot cleanup when a case is pruned.
