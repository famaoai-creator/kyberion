---
title: Surface Responsibility Model
category: Architecture
tags: [architecture, surface, presence, chronos, ceo, responsibilities]
importance: 9
author: Ecosystem Architect
last_updated: 2026-11-12
kind: evergreen
concepts: [surface, display, concierge, front-desk]
---

# Surface Responsibility Model

## 1. Purpose

Kyberion should expose different surfaces for different human roles without duplicating authority or confusing responsibilities.

This document defines the expected role of the main human-facing surfaces:

- `Presence Studio`
- `Chronos` — the operations role. Since 2026-11 it is the **operations console**, a section (`/ops`) inside the Concierge shell, not a separate app (§3.2)
- `CEO UX` — the decide-centric pages of the Concierge app (§3.3)

The three roles are unchanged. What changed is hosting: two of them now share one shell, so the split between them is a split between pages of one app and has to be kept deliberately (§3.3a).

## 2. Core Rule

Each surface should optimize for one primary question.

- `Presence Studio`
  - what is Kyberion helping me with right now
- `Chronos` (operations console)
  - what is the system doing and where should I intervene
- `CEO UX`
  - what matters, what needs approval, and what came out

If a surface starts trying to answer all three equally, the UX becomes noisy and conceptually weak.

## 3. Surface Roles

### 3.1 Presence Studio

Presence Studio is the conversational concierge surface ("concierge" here describes its manner; the Concierge app is §3.3).

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

### 3.2 Chronos — the operations console

Chronos is the management control plane. It is served by the Concierge app as
the operations console: pages under `/ops`, API under `/api/ops`
(`presence/displays/concierge/src/app/ops/`, `src/app/api/ops/`).
`presence/displays/chronos-mirror-v2` (port 3000) only redirects old URLs
there and authorizes nothing.

Its job is to:

- show projects, missions, task sessions, and mission seeds
- show approvals, bindings, and artifacts
- show execution state and blockers
- expose deterministic interventions
- provide accountability drill-down

The operations console should feel like the control tower.

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

The decide-centric pages (ホーム `/`, あなた待ち `/inbox`, 仕事 `/work`,
組織 `/org`, 資料 `/library`, 設定 `/settings`) should feel like a strategic
dashboard and approval inbox run by a competent secretary: polite Japanese
microcopy, a daily briefing, and nothing that requires knowledge of the
execution machinery.

These pages should not expose low-level execution machinery. The app as a
whole does host it, in one place: the operations console (§3.3a).

### 3.3a One shell, two responsibilities

The Concierge app hosts both the CEO UX and the operations console (§3.2).
Runtime and agent operations, surface control, diagnostics, traces, the live
terminal drawer, the Discussion / Dialogue Room and automation are reachable
at `/ops` in the same shell and rail as the decide-centric pages.

The responsibility split stays explicit:

- **Navigation.** 運用 (`/ops`) is one of the seven rail destinations and the
  only one that leads to execution machinery. The rail enables it for an
  `owner` only (`libs/core/surface/front-desk-nav.ts`, `min_role: 'owner'`; a
  viewer with no member binding counts as owner when its viewer role is
  `localadmin`). This is menu gating, not authorization.
- **Authorization.** Every `/api/ops` route except the unauthenticated
  liveness probe `/api/ops/healthz` resolves the Concierge viewer and answers
  401 without one. Read routes need a `readonly` viewer or higher.
  Interventions need a `localadmin` viewer plus the Concierge mutation gate
  (`presence/displays/concierge/src/lib/ops/ops-request-guard.ts`), with two
  exceptions that accept a `readonly` viewer: `POST /api/ops/knowledge-feedback`
  records a human feedback entry, and `POST /api/ops/plan-preview` computes a
  preview. Both still pass the same-origin check for cookie sessions and the
  tenant budget. The `/ops` page is a client page; everything it shows comes
  from those routes.
- **Content.** A decide-centric page may summarize or link to operational
  state; the controls and raw execution detail live under `/ops`. A feature
  that needs runtime, trace or terminal detail belongs in the console, not on
  ホーム or あなた待ち.
- **Retired console sections.** The console's former home, missions, work
  items, approvals, governance, organization, deliverables and knowledge
  sections were folded into the decide-centric pages and redirect there
  (`presence/displays/concierge/src/lib/ia-routes.ts`); `/ops` keeps
  operations, surface control, diagnostics and discussion.

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
control lives in the operations console and Presence Studio.

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

| Responsibility                  | Presence Studio (相棒) | Operations console (Concierge `/ops`, formerly Chronos) | Concierge decide pages (CEO秘書)       | Operator Surface (監査モニタ) | Computer Surface (手元ミラー) |
| ------------------------------- | ---------------------- | ------------------------------------------------------- | -------------------------------------- | ----------------------------- | ----------------------------- |
| Natural language request intake | Primary                | Secondary                                               | Secondary                              | No                            | No                            |
| Slot filling and clarifications | Primary                | Rare                                                    | Rare                                   | No                            | No                            |
| Short plan display              | Primary                | Secondary                                               | Summary only                           | Read-only                     | No                            |
| Current work detail             | Primary                | Secondary                                               | Minimal                                | Read-only                     | Live mirror                   |
| Project overview                | Secondary              | No (its section redirects to 組織)                      | Primary                                | Read-only                     | No                            |
| Mission seed management         | Secondary              | Primary                                                 | No                                     | No                            | No                            |
| Approval queue                  | Secondary              | No (its section redirects to あなた待ち)                | Primary                                | No                            | No                            |
| Risk and runtime inspection     | No                     | Primary                                                 | Summary only                           | Read-only                     | Live mirror                   |
| Artifact delivery               | Primary                | No (its section redirects to 資料)                      | Browse (資料); verdict (受領/差し戻し) | Read-only                     | No                            |
| Audit and evidence drill-down   | No                     | Primary                                                 | Linked only                            | Primary                       | No                            |

The two middle columns are served by the same app (§3.3a). The table states which pages own a responsibility, not which process; "redirects" marks a console section that was folded into a decide-centric page.

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
-> Operations console (Concierge /ops) for operational control and accountability
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
