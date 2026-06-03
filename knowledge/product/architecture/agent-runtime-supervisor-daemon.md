---
title: Agent Runtime Supervisor Daemon
category: Architecture
tags: [architecture, runtime, supervisor, uds, daemon, surface]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-24
---

# Agent Runtime Supervisor Daemon

## 1. Goal

Move agent runtime ownership out of individual surfaces and into one local-only control plane so runtime reuse, health, and lifecycle policy stay consistent across the ecosystem.

## 2. Problem

Before this split, each surface or gateway that needed an agent could call `ensureAgentRuntime()` in-process.

That was sufficient for a single daemon, but it created three problems:

- runtime ownership logic was duplicated across surfaces
- the same agent could be spawned independently by different daemons
- observability and idle policy were fragmented by process boundary

## 3. Target Model

The runtime control path is now:

1. surface or gateway receives external input
2. surface asks the `agent-runtime-supervisor` daemon to `ensure` a runtime
3. supervisor reuses an existing runtime if healthy, otherwise it spawns one
4. surface sends prompts through the supervisor instead of directly spawning provider children

## 4. Boundaries

### 4.1 Surface Responsibilities

Surfaces and gateways own:

- ingress and egress
- user/session context
- local UX state
- requests for runtime leases

They do not directly decide provider child lifecycle.

### 4.2 Supervisor Responsibilities

The supervisor daemon owns:

- spawn
- reuse
- ask
- touch
- shutdown
- runtime metadata projection
- runtime observability

### 4.3 Provider Responsibilities

Provider children still speak ACP or provider-specific protocols. They remain child processes of the supervisor daemon, not of the calling surface.

## 5. Transport

Communication is local-only over a Unix domain socket.

- socket path: `active/shared/runtime/agent-supervisor/agent-runtime-supervisor.sock`

This keeps the control plane off public ports and matches the intended local-only deployment model.

## 6. API Surface

The initial request types are:

- `health`
- `ensure`
- `ask`
- `status`
- `list`
- `touch`
- `shutdown`

Requests and responses are newline-delimited JSON messages over the Unix socket.

## 7. Ensure Contract

`ensure` takes:

- `agentId`
- `provider`
- `modelId`
- `systemPrompt`
- `capabilities`
- `cwd`
- `parentAgentId`
- `missionId`
- `trustRequired`
- `requestedBy`
- `runtimeMetadata`
- `runtimeOwnerId`
- `runtimeOwnerType`

The response projects supervisor state into a compact runtime snapshot:

- `agent_id`
- `provider`
- `model_id`
- `status`
- `session_id`
- `pid`
- `owner_id`
- `owner_type`
- `metadata`

## 8. Current Integration

`channel-surface` now tries the supervisor daemon first when resolving a surface agent.

- if the daemon is available, it returns a supervisor-backed `AgentHandle`
- if the daemon is unavailable, it falls back to the legacy in-process spawn path

This preserves compatibility during migration.

## 9. Migration Plan

### Phase 1

Ship the daemon and client.

- keep legacy in-process fallback
- route `voice-hub` and `channel-surface` through the client

### Phase 2

Move other surfaces and gateways to the same client.

- slack bridge
- chronos
- browser-driven surfaces
- future realtime voice runtimes

### Phase 3

Tighten policy and observability.

- central idle reaping policy
- runtime lease accounting
- restart policy per provider
- structured supervisor metrics and health endpoints

### Phase 4

Remove direct spawn from surface code except for explicit bootstrap or emergency fallback paths.

## 10. Why This Matters

This split keeps the conceptual model clean:

- surfaces are I/O
- the supervisor is runtime control
- providers are execution substrates

That makes future integrations easier, especially when multiple surfaces need to share the same local agent runtime without duplicating lifecycle logic.
