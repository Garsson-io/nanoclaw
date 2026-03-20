# Harness / Vertical Architecture

NanoClaw is a **harness** — a platform that powers multiple private vertical business repos. Each vertical is a separate private repo under Garsson-io with its own domain workflows, tools, and data.

```
NanoClaw (harness, public)              Verticals (private repos)
┌────────────────────────┐      ┌──────────────────────┐
│ Channels (TG, WA, etc) │      │ garsson-insurance     │
│ Container runtime      │─────▶│ garsson-prints        │
│ Cases & routing        │      │ (future verticals)    │
│ Skills system          │      └──────────────────────┘
│ Base Dockerfile        │
└────────────────────────┘
```

## Dependency Placement Rules

| Dependency type               | Where it goes                                | Example                                                   |
| ----------------------------- | -------------------------------------------- | --------------------------------------------------------- |
| Universal system deps         | Harness Dockerfile (`container/Dockerfile`)  | `chromium`, `git`, `node`, `ghostscript`, `poppler-utils` |
| Vertical-specific system deps | Declared by vertical, installed in container | `tesseract-ocr` (insurance)                               |
| Vertical npm deps             | Vertical's `package.json`                    | `sharp`, `pdfjs-dist`                                     |
| Domain tools/workflows        | Vertical repo                                | `policy-cache-manager.js`, `workflows/`                   |
| Harness infrastructure        | This repo                                    | `src/`, `container/`, skills                              |

**Rules:**

- **NEVER install system packages on the host** (no `sudo apt install`) — system deps go in Dockerfiles. npm deps go in the relevant `package.json` and are installed via `npm install`
- **Dockerfile cache policy:** Layers are ordered least-frequently-changed → most-frequently-changed. When adding a new dependency, **ADD a new `RUN` layer** at the latest valid position — do NOT modify existing heavy layers (that invalidates all downstream cache and costs minutes in CI). See the cache strategy comments in `container/Dockerfile` for the layer map.
- **Domain-specific code goes in the vertical repo**, not here
- **Verticals are mounted into containers** at `/workspace/extra/{name}/`
- **Work agents** get read-only tools, read-write data. **Dev agents** modify code in worktrees.

## Vertical Configuration Contract

Verticals provide domain-specific configuration via files in their `config/` directory, mounted into containers at `/workspace/extra/{name}/config/`. The harness reads these files and acts on them. This keeps deployment-specific config portable with the repo — no host-level reconfiguration when moving between machines.

| Config file              | Purpose                                                                    | Docs                                          |
| ------------------------ | -------------------------------------------------------------------------- | --------------------------------------------- |
| `config/escalation.yaml` | Escalation policy: admins, gap types, priority signals, notification rules | See `escalation.example.yaml` in any vertical |
| `config/materials.json`  | Material definitions, pricing                                              | Vertical-specific                             |

The pattern: **harness provides mechanism, vertical provides policy**. The harness knows HOW to create cases, compute priority, and send notifications. The vertical knows WHO the admins are, WHAT gaps matter, and WHEN to notify.

## IP Protection (future)

- Vertical repos: private (domain knowledge, customer data)
- Harness differentiators: move to private skills when needed
- Base NanoClaw: stays open-source (the framework)
