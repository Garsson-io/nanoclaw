# Architecture Layers & File Naming

NanoClaw has a layered architecture. File names encode which layer they belong to. **Do not mix layers** — each file should belong to exactly one layer.

```
Container (agent-facing MCP tools)          Host (harness)
┌──────────────────────────┐    IPC     ┌──────────────────────────────┐
│ mcp-*  or ipc-mcp-*.ts   │ ───────▶  │ ipc.ts (dispatcher)          │
│ (tool definitions)       │  JSON files│ ipc-{domain}.ts (handlers)   │
└──────────────────────────┘            │          ↓                   │
                                        │ {domain}.ts (model + logic)  │
                                        │ {domain}-auth.ts (policy)    │
                                        │          ↓                   │
                                        │ {domain}-backend.ts (iface)  │
                                        │ {domain}-backend-{prov}.ts   │
                                        │          ↓                   │
                                        │ {provider}-api.ts (REST)     │
                                        └──────────────────────────────┘
```

| Layer                      | Naming pattern                          | Example                      | Responsibility                           |
| -------------------------- | --------------------------------------- | ---------------------------- | ---------------------------------------- |
| **MCP tools** (container)  | `mcp-*` or in `container/agent-runner/` | `ipc-mcp-stdio.ts`           | Agent-facing tool definitions            |
| **IPC dispatcher**         | `ipc.ts`                                | `src/ipc.ts`                 | File watcher, routing to domain handlers |
| **IPC domain handlers**    | `ipc-{domain}.ts`                       | `src/ipc-cases.ts`           | Domain-specific IPC business logic       |
| **Domain model**           | `{domain}.ts`                           | `src/cases.ts`               | Data types, DB ops, lifecycle logic      |
| **Domain policy**          | `{domain}-auth.ts`                      | `src/case-auth.ts`           | Authorization gates, policy decisions    |
| **Backend interface**      | `{domain}-backend.ts`                   | `src/case-backend.ts`        | Backend-agnostic adapter interface       |
| **Backend implementation** | `{domain}-backend-{provider}.ts`        | `src/case-backend-github.ts` | Provider-specific backend (CRM sync)     |
| **Provider API client**    | `{provider}-api.ts`                     | `src/github-api.ts`          | Low-level REST API client                |

## Layer Rules

- Backend files (`*-backend*.ts`) handle cloud sync. They never touch IPC or MCP.
- IPC handlers (`ipc-*.ts`) translate IPC requests into domain operations. They never call provider APIs directly — they go through the domain model or backend adapter.
- Domain model files (`cases.ts`, `case-auth.ts`) are the single source of truth for business logic. Both IPC handlers and backends depend on them.
- Provider API files (`github-api.ts`) are pure REST clients. They know nothing about cases, sync, or IPC.

## Cases and Kaizen — How They Relate

There are two case types: **work** (customer tasks) and **dev** (tooling improvements / kaizen). Both use the same case system, same MCP tools, same lifecycle.

**The kaizen loop:**

- Work agents encounter friction → file improvement requests → these become **dev cases** (backed by `Garsson-io/kaizen`)
- Dev agents also encounter friction → file improvement requests → also become **dev cases**
- When any case is marked done, the agent reflects on impediments → `case_suggest_dev` → new dev case suggested

**All case operations go through the case MCP tools** (`case_create`, `case_mark_done`, `case_suggest_dev`, etc.) for container agents, or via `npx tsx src/cli-kaizen.ts case-create` (or `node dist/cli-kaizen.js case-create` if built) for host-side CLI agents. Never use raw SQL or `gh` CLI for case operations. The backend adapter (`case-backend-github.ts`) handles GitHub sync transparently.

**Separate CRM backends:** customer cases → per-customer CRM repo, dev/kaizen cases → `Garsson-io/kaizen`. The domain model (`cases.ts`) and backend adapter abstract this — agents don't know or care which repo backs their case.

**Dev workflow skills** (`/pick-work` → `/accept-case` → `/implement-spec` → `/kaizen`) manage the kaizen lifecycle. Host-side skills use `cli-kaizen.ts` for backlog queries and case creation.

**Architecture docs:** See [`docs/kaizen-ipc-architecture.md`](kaizen-ipc-architecture.md) for the full architecture diagram and [`docs/kaizen-cases-unification-spec.md`](kaizen-cases-unification-spec.md) for the unification spec.
