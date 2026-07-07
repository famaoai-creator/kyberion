---
title: Surface Responsibility Model
category: Architecture
tags: [architecture, surface, presence, chronos, ceo, responsibilities]
importance: 9
author: Ecosystem Architect
last_updated: 2026-03-29
---

# Surface Responsibility Model

## 1. Purpose

Kyberion should expose different surfaces for different human roles without duplicating authority or confusing responsibilities.

This document defines the expected role of the main human-facing surfaces:

- `Presence Studio`
- `Chronos`
- `CEO UX`

## 2. Core Rule

Each surface should optimize for one primary question.

- `Presence Studio`
  - what is Kyberion helping me with right now
- `Chronos`
  - what is the system doing and where should I intervene
- `CEO UX`
  - what matters, what needs approval, and what came out

If a surface starts trying to answer all three equally, the UX becomes noisy and conceptually weak.

## 3. Surface Roles

### 3.1 Presence Studio

Presence Studio is the conversational concierge surface.

Its job is to:

- receive live human intent
- smooth slot filling and follow-up dialogue
- show short plans
- expose active work detail
- expose browser help and current task results
- return artifacts and immediate next steps

Presence Studio should feel like the front desk of the operating system.

It should not become:

- the mission authority
- the main risk console
- the primary enterprise audit view

### 3.2 Chronos

Chronos is the management control plane.

Its job is to:

- show projects, missions, task sessions, and mission seeds
- show approvals, bindings, and artifacts
- show execution state and blockers
- expose deterministic interventions
- provide accountability drill-down

Chronos should feel like the control tower.

It should not become:

- the default conversational front-end
- the only artifact viewer
- a replacement for mission authority

### 3.3 CEO UX — Concierge (秘書室)

The CEO UX is the leadership decision surface. It is implemented as the
**concierge** app (`presence/displays/concierge`, port 3050) — the CEO's
executive secretary.

Its job is to:

- receive high-level intent (Intent Inbox)
- show waiting approvals (Approval Queue)
- show current company-level outcomes (Outcome Feed)
- surface major exceptions (Exception Feed)

The concierge should feel like a strategic dashboard and approval inbox run
by a competent secretary: polite Japanese microcopy, a daily briefing, and
nothing that requires knowledge of the execution machinery.

It should not expose low-level execution machinery by default.

### 3.3b Operator Surface (監査モニタ)

The operator surface (`presence/displays/operator-surface`, port 3331) is the
**read-only audit monitor**: missions, audit chain, health, inbox inspection.
It answers "what happened, with evidence" for operators, compliance, and
anyone who must verify without the ability to mutate. Its no-write contract is
enforced by tests; the single exception is inbox read/accept marking.

### 3.3c Computer Surface (作業の手元ミラー)

The computer surface (`presence/displays/computer-surface`, port 3040) is the
**hands mirror**: a passive live view of what Kyberion's browser/terminal
executors are doing right now (A2UI state sink). It never initiates work;
control lives in Chronos and Presence Studio.

### 3.4 Thread-First Messaging

Messaging surfaces should treat the current turn as incoming thread context, not as a user-owned request by default.

The speaker and the reply authority are separate:

- `speaker`
  - who sent the current message
- `reply authority`
  - which Kyberion surface or agent is allowed to answer on this channel
- `mission owner`
  - the durable owner of work, only when the thread escalates

Slack may branch into approval or mission proposal flows.
Discord, Telegram, and iMessage should default to thread reply semantics.

For internal labels, prefer:

- `Current incoming message`
- `Current thread message`

Avoid `Current user message` when the message may have come from someone other than the operator.

## 4. Responsibility Table

| Responsibility                  | Presence Studio (相棒) | Chronos (管制塔) | Concierge (CEO秘書)     | Operator Surface (監査モニタ) | Computer Surface (手元ミラー) |
| ------------------------------- | ---------------------- | ---------------- | ----------------------- | ----------------------------- | ----------------------------- |
| Natural language request intake | Primary                | Secondary        | Secondary               | No                            | No                            |
| Slot filling and clarifications | Primary                | Rare             | Rare                    | No                            | No                            |
| Short plan display              | Primary                | Secondary        | Summary only            | Read-only                     | No                            |
| Current work detail             | Primary                | Secondary        | Minimal                 | Read-only                     | Live mirror                   |
| Project overview                | Secondary              | Primary          | Summary only            | Read-only                     | No                            |
| Mission seed management         | Secondary              | Primary          | No                      | No                            | No                            |
| Approval queue                  | Secondary              | Primary          | Primary                 | No                            | No                            |
| Risk and runtime inspection     | No                     | Primary          | Summary only            | Read-only                     | Live mirror                   |
| Artifact delivery               | Primary                | Secondary        | Verdict (受領/差し戻し) | Read-only                     | No                            |
| Audit and evidence drill-down   | No                     | Primary          | Linked only             | Primary                       | No                            |

## 5. Authority Boundaries

Surfaces should not directly own durable execution authority.

They must route control through backend authorities such as:

- `mission_controller`
- `agent-runtime-supervisor`
- `surface_runtime`

Surface code may:

- collect intent
- render state
- request deterministic actions

Surface code should not:

- mutate mission lifecycle directly
- invent separate approval models
- bypass policy or runtime authority

## 6. User Journey Alignment

The three-surface model should map cleanly to the enterprise loop:

```text
Intent
-> Presence Studio or CEO UX
-> Resolve and plan
-> Chronos for operational control and accountability
-> Result back to Presence Studio or CEO UX
-> Learn through memory systems
```

This preserves a simple human experience while keeping execution inspectable and governed.

## 7. Design Test

When introducing a new feature, ask:

1. Is this primarily conversational, operational, or executive?
2. Which surface should own the default experience?
3. Which surface should only link to or summarize it?
4. Does the action still flow through backend authority?

If those answers are unclear, the feature likely needs stronger surface separation.
