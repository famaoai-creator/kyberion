---
title: Channel, Port, and Surface Agent Model
category: Architecture
tags: [architecture, channels, ports, surface-agents, slack, chronos]
importance: 9
author: Ecosystem Architect
last_updated: 2026-03-15
---

# Channel, Port, and Surface Agent Model

This document defines a general interaction model for external systems such as Slack, Chronos Mirror v2, voice hubs, and future channels.

It extends the mission/control model with a clear answer to four questions:

1. what kind of external interface is this
2. how do events move across it
3. which actor prepares or interprets those events
4. where does durable execution authority actually live

## 1. Top-level model

Kyberion should reason about external interaction as three layers:

1. `Surface`
2. `Nerve`
3. `Execution`

### 1.1 Surface

The human-facing or external-system-facing layer.

Examples:

- Slack
- Chronos Mirror v2
- voice hubs
- future email or webhook endpoints

### 1.2 Nerve

The routing and correlation layer.

It receives normalized events, decides where they should go, records explainable routing artifacts, and prepares delivery artifacts for feedback.

### 1.3 Execution

The durable authority layer.

This is where missions, task contracts, worker agents, runtime sessions, and actuators perform work.

Execution owns outcomes. Surface does not.

## 2. Channel

A **Channel** is an external interaction context such as Slack or Chronos.

A channel describes:

- who is on the other side
- what transport is available
- how replies are correlated
- whether interaction is synchronous, asynchronous, or streaming

Channels are conceptual. They do not imply write authority.

## 3. Port

A **Port** is the concrete ingress or egress interface of a channel.

A single channel may expose multiple ports.

Examples:

- Slack Socket Mode ingress port
- Slack outbox delivery port
- Chronos HTTP request port
- Chronos WebSocket stream port
- voice listener poll port

### 3.1 Port attributes

Each port should be described by:

- `port_id`
- `channel`
- `role`
- `directionality`
- `transport`
- `binding`
- `durability`
- `approval_mode`

### 3.2 Port role

Allowed roles:

- `sensor`
- `emitter`
- `gateway`
- `control-surface`
- `display`

### 3.3 Directionality

Allowed directionality:

- `receive-only`
- `send-only`
- `request-response`
- `streaming-duplex`

### 3.4 Transport

Allowed transport:

- `poll`
- `webhook`
- `socket`
- `push-api`
- `file-drop`
- `interactive-session`

### 3.5 Binding

What the port hands work to:

- `mission`
- `task`
- `runtime-session`
- `queue`
- `approval`

### 3.6 Durability

How strongly the interaction is persisted:

- `ephemeral`
- `journaled`
- `append-only`

## 4. Surface Agent

A **Surface Agent** is a lightweight channel-local agent that handles interaction quality, context shaping, and handoff preparation, but does not own durable mission authority.

This is the correct conceptual home for the earlier idea of a Slack-specific conversational agent.

### 4.1 Responsibilities

A Surface Agent may:

- acknowledge receipt
- compress channel context
- maintain conversational continuity
- ask clarification questions
- classify intent at a first pass
- create handoff artifacts for Nerve
- format mission or task results for channel delivery

### 4.2 Non-responsibilities

A Surface Agent must not:

- own mission state by default
- grant itself task authority
- bypass coordination contracts
- directly expand write scope across tiers

## 5. Surface Agent types

### 5.1 Slack Surface Agent

Slack should use a **Slack Surface Agent**.

Role:

- human conversation concierge

Behavior:

- reads thread and sender context
- returns immediate acknowledgements when needed
- asks for clarification when the request is ambiguous
- writes a normalized handoff into Nerve
- posts approved responses back into the same thread

It should be treated as:

- channel-local
- conversational
- not the mission owner

### 5.2 Chronos Surface Agent

Chronos Mirror v2 should use a **Chronos Surface Agent**.

Role:

- interactive control concierge

Behavior:

- handles authenticated control requests
- prepares structured prompts or delegations
- streams partial state to the UI when appropriate
- records durable routing and observability artifacts outside route-local memory

It is more control-oriented than Slack, but it still should not silently become the durable mission owner.

## 6. Recommended mapping

### 6.1 Slack

Channel:

- `slack`

Ports:

- ingress socket port
  - role: `sensor`
  - directionality: `receive-only`
  - transport: `socket`
  - binding: `queue`
  - durability: `append-only`
- egress delivery port
  - role: `emitter`
  - directionality: `send-only`
  - transport: `push-api`
  - binding: `task`
  - durability: `journaled`

Surface Agent:

- `slack-surface-agent`

### 6.2 Chronos Mirror v2

Channel:

- `chronos`

Ports:

- request port
  - role: `control-surface`
  - directionality: `request-response`
  - transport: `webhook`
  - binding: `mission`
  - durability: `journaled`
- stream port
  - role: `display`
  - directionality: `streaming-duplex`
  - transport: `socket`
  - binding: `runtime-session`
  - durability: `ephemeral`

Surface Agent:

- `chronos-surface-agent`

## 7. Artifact placement

### 7.1 Surface ingress

- canonical stimuli journal:
  - `presence/bridge/runtime/stimuli.jsonl`
- optional channel inbox mirrors:
  - `active/shared/coordination/channels/<channel>/inbox/`

### 7.2 Nerve coordination

- `active/shared/coordination/channels/<channel>/`
- mission-local `coordination/handoffs/`
- mission-local `coordination/tasks/`

### 7.3 Feedback and receipts

- `active/shared/coordination/channels/<channel>/outbox/`
- `active/shared/observability/channels/<channel>/events.jsonl`
- `active/shared/observability/channels/<channel>/deliveries.jsonl`

## 8. Why this model is useful

This model makes three important distinctions explicit:

1. a channel is not an actuator
2. a Surface Agent improves interaction quality without taking mission authority
3. transport semantics and authority semantics are different and must be modeled separately

That is what keeps Slack and Chronos easy to understand without weakening mission governance.
