# Competitor Analysis: Customer-Facing Agent Platforms with Case Isolation

Status: **Draft** | Date: 2026-03-18

Related: [Case Isolation Spec](case-isolation-spec.md) | [kaizen#65](https://github.com/Garsson-io/kaizen/issues/65)

---

## Context

NanoClaw is evolving into a customer-facing agent platform where each work item (case) runs in an isolated container with per-customer data scoping. This document surveys existing solutions — in the Claw ecosystem, open-source, and commercial — to understand what exists, what gaps remain, and what's genuinely novel about our approach.

---

## 1. The Claw Ecosystem

### 1.1 OpenClaw

The dominant open-source AI agent platform (~7,000 GitHub stars). Multi-channel (Slack, Discord, Telegram, WhatsApp, webchat). Single-operator model — the official docs explicitly state it is "not designed as a hostile multi-tenant security boundary for multiple adversarial users sharing one agent/gateway."

| Aspect | OpenClaw | NanoClaw (ours) |
|--------|----------|-----------------|
| Isolation model | Application-level (permission checks, allowlists) | OS-level (containers per case) |
| Multi-tenant | Not designed for it | Customer-facing with per-case isolation |
| Case/work-item abstraction | None | Full lifecycle (SUGGESTED → PRUNED) |
| Customer data scoping | None | CRM MCP with per-customer access control |
| Agent roles | Single role (one agent does everything) | Three roles (router, work, dev) with distinct trust boundaries |
| Codebase size | ~500K lines, 70+ dependencies | ~4K lines, minimal dependencies |

**Relevant development:** OpenClaw issue #17299 proposes an "Agents Plane" for native multi-tenant agent provisioning and isolation. Not yet implemented — indicates the community recognizes the gap.

### 1.2 Lobu

Multi-tenant wrapper for OpenClaw. The closest competitor in the Claw ecosystem.

| Aspect | Lobu | NanoClaw (ours) |
|--------|------|-----------------|
| Isolation level | Per-channel/DM | Per-case (work item) |
| Programmatic agent creation | REST API | MCP tools + IPC |
| Customer identity | Implicit (channel user) | Explicit customer model with 2FA identity merging |
| CRM integration | None | CRM MCP server with per-customer scoping |
| Case lifecycle | None | Full lifecycle with kaizen feedback |
| Agent roles | Single role per channel | Router / work / dev with different access |

**Key gap:** Lobu isolates per channel, not per work item. If a customer has two concurrent issues, they share the same channel isolation boundary. Our model gives each case its own container and data scope.

### 1.3 ClawSwarm

Multi-agent system by The Swarm Corporation. Compiles to Rust, built on the Swarms framework. Unified messaging across Telegram, Discord, WhatsApp.

| Aspect | ClawSwarm | NanoClaw (ours) |
|--------|-----------|-----------------|
| Multi-agent model | Hierarchical (director → specialists) | Swarm with named identities (router → case workers) |
| Focus | Agent collaboration on shared tasks | Customer isolation across separate tasks |
| Data isolation | Not a design goal | Core design goal |
| Customer-facing | No | Yes |

**Relevance:** ClawSwarm's hierarchical delegation pattern is interesting but solves a different problem (agent collaboration vs customer isolation).

### 1.4 Praktor

Claude Code orchestrator with Telegram I/O, Docker isolation, swarm patterns, Mission Control UI. Secrets encrypted at rest (AES-256-GCM).

| Aspect | Praktor | NanoClaw (ours) |
|--------|---------|-----------------|
| Target use | Dev orchestration | Customer-facing + dev |
| Container isolation | Yes | Yes |
| Customer data scoping | None | CRM MCP with per-customer access control |
| Case management | None | Full lifecycle |
| Secrets management | AES-256-GCM encrypted | Credential proxy (no secrets in containers) |

**Worth studying:** Mission Control UI and secrets management approach.

### 1.5 Ecosystem Summary

```
                        Customer-Facing Capability
                        Low ◄─────────────────► High

    Per-Case     │                              ★ NanoClaw (planned)
    Isolation    │
                 │
    Per-Channel  │              Lobu
    Isolation    │
                 │
    Per-Operator │  OpenClaw    ClawSwarm
    Isolation    │  Praktor
                 │
    None         │  ClawBot
                 │
```

No existing Claw ecosystem project combines customer-facing deployment with case-level isolation.

---

## 2. Commercial Platforms

### 2.1 Sierra AI

The most relevant commercial competitor. Purpose-built for customer-facing AI agents.

| Aspect | Sierra AI | NanoClaw (ours) |
|--------|-----------|-----------------|
| Agent Data Platform | Unified customer data across sessions, channels, systems | CRM MCP with per-customer scoping |
| Customer identity | Cross-channel identity resolution | 2FA-based identity merging |
| Memory/personalization | Built-in per-customer memory | Per-case session persistence |
| Deployment | Proprietary SaaS | Self-hosted, open-source |
| Isolation model | Application-level (proprietary) | OS-level containers |
| Customization | Configuration within their platform | Full code control (fork + modify) |
| Pricing | Enterprise contracts | Self-hosted (API costs only) |

**Key insight:** Sierra's Agent Data Platform is the gold standard for customer data unification. Their approach of giving agents memory and personalization across sessions is worth studying for our CRM design. But it's a closed platform — no self-hosting, no code access, no container-level isolation guarantees.

### 2.2 Salesforce Agentforce

AI agents built on Salesforce's CRM data layer. Atlas Reasoning Engine for autonomous reasoning.

| Aspect | Agentforce | NanoClaw (ours) |
|--------|------------|-----------------|
| Data model | Salesforce CRM (structured + unstructured) | Custom CRM via MCP |
| Tenant isolation | Inherited from Salesforce platform | Container + CRM MCP scoping |
| Agent autonomy | Policy-constrained actions | Role-based tool restriction |
| Ecosystem | 450+ integrations via Salesforce | MCP tools (extensible) |
| Lock-in | Full Salesforce ecosystem | None (open-source, self-hosted) |

**Key insight:** Agentforce shows that CRM-native AI agents work well — the data layer is already tenant-isolated. Our challenge is building equivalent tenant isolation without an existing enterprise CRM platform underneath.

### 2.3 ServiceNow AI Agents

Multiple specialized agents working together (orchestrator pattern). AI Control Tower for oversight. 450+ integrations.

| Aspect | ServiceNow | NanoClaw (ours) |
|--------|------------|-----------------|
| Agent pattern | Orchestrator + specialists | Router + case workers |
| Data isolation | Inherited from ServiceNow platform | Container + CRM MCP |
| Oversight | AI Control Tower | Kaizen feedback loop + admin approval for dev cases |
| Target market | Enterprise IT service management | Small business / vertical-specific |

### 2.4 Intercom Fin / Zendesk AI / Ada / Forethought

Conversational AI for customer support. Ticket/conversation-scoped.

| Aspect | These platforms | NanoClaw (ours) |
|--------|----------------|-----------------|
| Isolation model | Application-level (DB row filtering) | OS-level (containers) |
| Per-case isolation | No — shared model context across conversations | Yes — separate container, session, filesystem |
| Agent autonomy | Answer questions, escalate to humans | Full case execution (research, file processing, API calls) |
| Customization | Configuration UI | Full code control |
| Data access | Read from knowledge base + CRM | Read/write CRM, scratch files, internet |

**Key gap in all of these:** Isolation is application-level, not OS-level. The AI model may see multiple customers' data within a single inference context. These platforms rely on prompt engineering and DB filtering to prevent leakage — not on making the data physically unavailable to the model.

### 2.5 Commercial Summary

```
                         Isolation Strength
                         App-Level ◄───────► OS-Level

    Full Customer    │  Sierra, Agentforce        ★ NanoClaw (planned)
    Platform         │  ServiceNow
                     │
    Conversational   │  Intercom, Zendesk
    Support          │  Ada, Forethought
                     │
    Dev/Internal     │                            Praktor
    Only             │
```

Commercial platforms have strong customer data platforms but rely on application-level isolation. NanoClaw is the only project combining OS-level isolation with customer-facing case management.

---

## 3. Infrastructure & Sandbox Projects

### 3.1 Kubernetes Agent Sandbox (kubernetes-sigs)

Google-backed CRD for Kubernetes. Manages isolated, stateful, singleton workloads for AI agent runtimes. Supports gVisor and Kata Containers for kernel-level isolation.

**Relevance:** If NanoClaw ever needs to scale beyond single-host Docker, this is the Kubernetes-native standard for agent isolation. Not a competitor — a potential infrastructure layer.

### 3.2 AWS Multi-Tenant Agent Architecture Guide

Amazon's prescriptive guidance on tenant isolation for agentic AI. Covers: agent-per-tenant vs shared-agent models, data isolation patterns, credential management, guardrails.

**Relevance:** The most thorough architectural reference for multi-tenant agent design. Their "agent-per-tenant with shared infrastructure" pattern is closest to our model. Worth reading for the CRM MCP server design.

### 3.3 Kortix/Suna

Open-source agent platform with isolated Docker execution per agent instance. Browser automation, code interpreter, file system access.

**Relevance:** Similar container isolation approach but no customer-facing features, no case management, no CRM integration.

---

## 4. What's Genuinely Novel

Based on this survey, the following aspects of NanoClaw's planned architecture have no direct equivalent:

| Capability | Who else does it? | Our approach |
|-----------|-------------------|--------------|
| **Case-level OS isolation** (container per work item, not per channel/tenant) | Nobody | Each case gets its own container with only that case's data mounted |
| **Three agent roles with distinct trust boundaries** | ServiceNow has multiple agent types, but with app-level isolation | Router (intake only), work (per-case CRM), dev (code only). OS-level enforcement per role. |
| **Bot identity as routing mechanism** | Nobody — all competitors use LLM classifiers or manual routing | Which Telegram bot you message = which case. Mechanistic, zero-cost, zero-hallucination routing. |
| **Customer CRM binding at container boundary** | Sierra does this at app level | CRM MCP server rejects queries for wrong customer. OS-level + data-level + capability-level enforcement. |
| **Kaizen feedback loop in case lifecycle** | Nobody | Case completion triggers reflection → suggested dev improvements → better tooling → better case outcomes |
| **Harness/vertical architecture** | Nobody in the Claw ecosystem | Public harness + private vertical repos mounted into containers. Domain code separated from infrastructure. |

The individual techniques aren't new (containers, CRM scoping, named bots). The combination and the depth of isolation enforcement is what's novel.

---

## 5. What We Should Learn From

| Source | What to study | Applies to |
|--------|---------------|-----------|
| **Sierra AI — Agent Data Platform** | How they unify customer data across sessions and channels. Their memory/personalization model. | CRM MCP server design |
| **Lobu — REST API for agent provisioning** | Programmatic agent creation and per-channel isolation patterns | Bot-case assignment, agent lifecycle management |
| **AWS multi-tenant agent guide** | Agent-per-tenant vs shared-agent tradeoffs, credential management, guardrails | Overall architecture validation |
| **Kubernetes Agent Sandbox** | CRD patterns for stateful agent workloads, gVisor/Kata isolation | Future scaling beyond single-host Docker |
| **Praktor — Mission Control UI** | Operator visibility into agent swarm state | Future monitoring/management UI |
| **Salesforce Agentforce — Atlas Engine** | Policy-constrained agent autonomy, how they limit what agents can do | MCP tool restriction by role |

---

## 6. Competitive Position

### Beyond NanoClaw

This analysis makes clear that what we're building is no longer a NanoClaw customization — it's a new product. NanoClaw is a personal assistant framework: one user, stateless containers, no customer concept, no case isolation. What we're building — customer-facing agents with case-level OS isolation, CRM-scoped data access, role-based trust boundaries, and named agent swarms — doesn't exist in the Claw ecosystem or anywhere else in open source.

The codebase we're developing (internally: **Garsson Harness**) uses NanoClaw as its upstream foundation (channels, container runtime, message loop) but the value is in the layers above: case isolation, CRM integration, agent roles, bot identity routing, vertical architecture. These are proprietary differentiators, not upstream contributions.

This has implications for project strategy:
- **NanoClaw remains upstream** for infrastructure (channels, container runtime, basic agent lifecycle)
- **Garsson Harness is the product** — case isolation, CRM, agent swarm, vertical deployment
- **Future direction**: As the gap widens, maintaining upstream compatibility becomes a cost rather than a benefit. A clean break (rename, closed-source) is likely.

### Strengths

- **Deepest isolation**: Only platform combining OS-level (container) + data-level (CRM MCP) + capability-level (MCP tools) + branch-level (worktree) isolation
- **Self-hosted**: Full code control, API-cost-only pricing, no vendor lock-in
- **Small codebase**: Auditable, modifiable, understandable (~4K lines vs OpenClaw's ~500K)
- **Novel routing**: Bot identity as routing eliminates LLM classifier costs and hallucination risks
- **Vertical architecture**: Harness/vertical separation enables industry-specific deployment without forking infrastructure

### Weaknesses

- **CRM doesn't exist yet**: The CRM MCP server is the critical path component and hasn't been built
- **Single-host**: No clustering or horizontal scaling story yet
- **Small team**: Limited bandwidth for both product development and upstream maintenance
- **Unproven at scale**: No production deployment with real customers yet

### Opportunities

- **First mover in OS-level case isolation**: No open-source or commercial competitor offers container-per-case isolation with CRM scoping
- **Vertical-specific deployment**: Industry-specific agents (insurance, printing, etc.) as separate verticals on a shared harness
- **Closed-source product**: The proprietary layers (case isolation, CRM, agent swarm) are the core value — they don't need to be open-source

### Threats

- **OpenClaw Agents Plane**: If OpenClaw ships native multi-tenant support, their ecosystem advantage (7K+ stars, 70+ integrations) could commoditize the infrastructure layer
- **Lobu expansion**: If Lobu adds case-level isolation, they'd compete directly with a larger community
- **Commercial platforms moving downmarket**: Sierra, Agentforce becoming accessible to small businesses would pressure the self-hosted value proposition
- **Upstream divergence cost**: Maintaining NanoClaw compatibility while building proprietary layers creates ongoing merge overhead
