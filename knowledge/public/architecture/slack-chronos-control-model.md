---
title: Slack and Chronos Control Model
category: Architecture
tags: [architecture, slack, chronos, control-plane, observability]
importance: 9
author: Ecosystem Architect
last_updated: 2026-03-15
---

# Slack and Chronos Control Model

This document defines how Slack ingress, agent notification, Chronos Mirror v2, and channel feedback should be organized after the mission/control and runtime changes introduced in 2026-03-15.

The goal is to separate four concerns that had started to blur together:

1. channel ingestion
2. mission or agent routing
3. interactive control surfaces
4. channel feedback delivery

After the service-binding cleanup, a fifth concern is explicit:

5. authenticated service binding

## 1. Core rule

Slack is a channel, not a mission owner.

Chronos Mirror v2 is a control surface, not the authoritative mission controller.

The authoritative ownership model remains:

- one mission owner agent
- zero or more worker agents
- explicit task contracts and scoped leases

This document should be read together with:

- `knowledge/public/architecture/channel-port-surface-model.md`

## 2. Three-plane model

### 2.1 Ingress plane

Ingress captures raw external stimuli and normalizes them into append-only artifacts.

Current canonical ingress journal:

- `presence/bridge/runtime/stimuli.jsonl`

Required observability mirror:

- `active/shared/observability/channels/<channel>/events.jsonl`

Ingress responsibilities:

- normalize external events into a stable envelope
- preserve source context such as channel, thread, sender, and timestamps
- avoid routing or mission decisions
- never write directly into mission state without a claim or lease

Slack bridge belongs here first. Its current behavior as a sensor is correct.
Its authentication should come from service binding, not route-local secret lookup patterns spread across gateways.

### 2.2 Control plane

The control plane decides which agent or mission should handle a stimulus.

Global coordination surface:

- `active/shared/coordination/channels/`
- `active/shared/coordination/chronos/`

Mission-local coordination surface:

- `active/missions/<tier>/<mission_id>/coordination/`

Control-plane responsibilities:

- create or locate a mission binding for an external request
- assign owner and worker responsibilities
- record task contracts, handoffs, and claims
- keep channel-specific receipts and delivery state

Slack must not directly invoke arbitrary execution logic from the bridge. It should hand off through coordination artifacts.

### 2.3 Feedback plane

Feedback returns an approved result to the originating channel.

Preferred response sources:

- `active/shared/runtime/terminal/<session_id>/out/latest_response.json`
- mission-local handoff artifacts under `coordination/handoffs/`
- channel outbox artifacts under `active/shared/coordination/channels/<channel>/outbox/`

Legacy compatibility path:

- `active/shared/last_response.json`

`active/shared/last_response.json` is no longer the conceptual source of truth. It remains only as a compatibility artifact for older terminal or skill paths.

Feedback responsibilities:

- deliver only approved, contextualized responses
- preserve channel reply context such as Slack thread information
- emit delivery receipts and failures into observability

### 2.4 Service-binding plane

Service binding resolves authenticated access to external services without turning gateways into ad hoc credential loaders.

Current implementation anchor:

- `libs/core/service-binding.ts`

Service-binding responsibilities:

- resolve service-scoped credentials through governed secret access
- express whether access is token-based or session-based
- keep ingress gateways thin
- support delivery actuators and service-aware access paths with a shared binding contract

## 3. Slack model

Slack should be modeled as:

- sensor on ingress
- channel endpoint on egress
- never the durable execution authority
- serviced by `slack-surface-agent` for channel-local conversational quality

### 3.1 Slack ingress

Slack ingress writes:

- normalized stimulus to `presence/bridge/runtime/stimuli.jsonl`
- channel event record to `active/shared/observability/channels/slack/events.jsonl`

Slack ingress may also create coordination hints under:

- `active/shared/coordination/channels/slack/inbox/`

Those hints are advisory and must not replace the canonical stimulus journal.

### 3.2 Slack egress

Slack egress should consume approved channel feedback envelopes from:

- `active/shared/coordination/channels/slack/outbox/`

Delivery receipts should be appended to:

- `active/shared/observability/channels/slack/deliveries.jsonl`

If a Slack exchange is mission-bound, the outbox artifact should reference:

- `mission_id`
- `task_id`
- `source_stimulus_id`
- `owner_agent_id`

This is what makes the response explainable later.

Slack egress should be treated as channel delivery, not as local system execution.

## 4. Chronos Mirror v2 model

Chronos Mirror v2 should be modeled as an interactive control plane and display surface.

It is responsible for:

- authenticated user interaction
- session-oriented routing into the agent/runtime layer
- rendering structured responses and delegations
- exposing observability summaries

It is not responsible for:

- becoming the mission owner by default
- silently mutating mission authority
- acting as the durable store for coordination state
- replacing the Chronos Surface Agent with route-local singleton state

### 4.1 Chronos ownership

Chronos may keep a cached runtime handle per application process for efficiency, but the authoritative state must live outside `globalThis`.

Authoritative artifacts belong in:

- `active/shared/coordination/chronos/sessions/`
- `active/shared/observability/chronos/requests.jsonl`
- `active/shared/observability/chronos/delegations.jsonl`

Chronos gateway authentication is route-local, but any downstream external service access should still flow through service binding.

### 4.2 Chronos and A2A

When Chronos delegates work:

- the delegation should be recorded as a task or handoff artifact
- worker outputs should be attached back to the same correlation id
- the UI route may summarize results, but it should not be the only record of the delegation

## 5. Security model

Security boundaries should follow the same three planes.

### 5.1 Sensor and gateway roles

Recommended roles:

- `slack_bridge`
- `chronos_gateway`
- `infrastructure_sentinel`
- `mission_controller`
- `nerve-agent` for deeper reasoning and mission-routing support

### 5.2 Write scopes

`slack_bridge`

- `presence/bridge/runtime/`
- `active/shared/coordination/channels/slack/`
- `active/shared/observability/channels/slack/`

`chronos_gateway`

- `active/shared/coordination/chronos/`
- `active/shared/observability/chronos/`
- `active/shared/runtime/terminal/`

`mission_controller`

- mission directories
- mission-local coordination
- shared coordination and mission-control observability

`infrastructure_sentinel`

- shared runtime
- shared observability
- shared channel coordination
- presence runtime bridges

### 5.3 Gateway, binding, and actuator split

The intended mapping is:

- `slack-bridge`
  - Slack ingress gateway
- `chronos-mirror-v2`
  - Chronos control gateway
- `slack-surface-agent`
  - Slack conversation handler
- `presence-actuator`
  - channel delivery actuator
- `service-actuator`
  - authenticated service binding and service-aware access
- `system-actuator`
  - local ephemeral OS execution

Slack streaming ingress should not live in `service-actuator`.
It belongs to the Slack gateway.

Long-running gateways and control surfaces should be declared in
`knowledge/public/governance/active-surfaces.json` and managed through
`scripts/surface_runtime.ts`, not started ad hoc from unrelated CLIs.

## 6. Observability contract

Every important operation should emit an explainable event.

Minimum fields:

- `ts`
- `event_id`
- `correlation_id`
- `mission_id`
- `task_id`
- `agent_id`
- `channel`
- `decision`
- `why`
- `policy_used`
- `resource_id`

Minimum streams:

- `active/shared/observability/channels/slack/events.jsonl`
- `active/shared/observability/channels/slack/deliveries.jsonl`
- `active/shared/observability/chronos/requests.jsonl`
- `active/shared/observability/chronos/delegations.jsonl`
- mission-local `coordination/events/*.jsonl`

## 7. Transition rule

The current implementation still contains legacy paths such as:

- `active/shared/last_response.json`
- route-local orchestration inside Chronos API handlers

These are transitional compatibility points.

New work should prefer:

- session-scoped runtime outboxes
- mission-local coordination artifacts
- channel-specific outbox and receipt directories
- observability-first decision logs
