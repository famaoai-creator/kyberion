---
title: Kyberion Surface UX Architecture
category: Architecture
tags: [architecture, ux, surface, mission, chronos, presence, intent]
importance: 10
author: Ecosystem Architect
last_updated: 2026-11-05
kind: evergreen
---

# Kyberion Surface UX Architecture

## 1. Product Thesis

Kyberion should feel simple even when the execution model is sophisticated.

The primary user-facing contract is:

```text
Intent -> Plan -> State -> Result
```

The primary internal contract is:

```text
Intent -> Resolution -> Task Session or Mission -> Actuators and ADF -> Evidence and Artifacts
```

The system succeeds when users can stay in the first model while operators and developers can still inspect the second.

The primary observability contract should mirror the same structure:

```text
Intent -> Slot -> Plan -> Execution -> Outcome
```

This surface architecture should also be read together with:

- `knowledge/product/architecture/ceo-ux.md`
- `knowledge/product/architecture/management-control-plane.md`
- `knowledge/product/architecture/surface-responsibility-model.md`

## 2. UX Principle

Surfaces should expose:

1. what the human asked for
2. what Kyberion understood
3. what Kyberion is doing now
4. what came out
5. what needs approval or intervention

Surfaces should not require users to reason first about:

- actuator names
- runtime supervisor details
- raw ADF JSON
- mission ledgers
- internal event streams

Those remain inspectable, but they are not the main UX.

## 3. The User-Facing Flow

### 3.1 Intent

The user expresses a request in natural language.

Examples:

- `このPDFをパワポにして`
- `日経新聞を開いて`
- `今週の進捗レポートを作って`
- `voice-hub の状態を見て`

### 3.2 Resolution

Kyberion decides what shape of work this is.

Possible outcomes:

- direct answer
- browser operation
- task session
- mission
- approval flow

### 3.3 Plan

The system presents a short plan in human terms.

Examples:

- `PDF を解析 -> レイアウトを復元 -> PPTX を生成`
- `検索 -> サイトを開く`
- `状態を取得 -> 要点を返す`

This is the right level of explanation for surfaces.

### 3.4 State

The surface shows progress in terms such as:

- running
- waiting for input
- waiting for approval
- completed
- failed

### 3.5 Result

Results should be returned as:

- direct answer
- artifact link or download
- short outcome summary
- next action

## 4. Missions vs Task Sessions

Kyberion should not flatten everything into one generic conversation loop.

### Task Session

Task sessions are for conversational, bounded, inspectable work.

Examples:

- create a PowerPoint
- create a report
- inspect a service
- interactive browser assistance
- capture and return an artifact

Task sessions are the right internal abstraction when the UX should feel immediate and conversational.

### Mission

Missions are for durable work that needs stronger control and auditability.

Examples:

- engineering implementation
- multi-step coordinated work
- cross-agent execution
- distillation and lifecycle checkpoints

Missions are the durable backend model, not the first thing users should need to learn.

## 5. Surface Roles

### Command Surface

Purpose:

- receive user intent
- clarify missing information
- present short plans

Examples:

- terminal chat
- Slack
- Presence Studio

### Control Surface

Purpose:

- show state
- reveal blockages
- expose intervention points

Examples:

- Chronos Mirror

### Work Surface

Purpose:

- render focused task detail
- show artifact and progress detail
- support specific inspection or control

Examples:

- task detail panels
- browser conversation detail
- artifact detail views

### Inspection Surface

Purpose:

- review outcomes later
- inspect evidence
- audit what happened

## 6. What Each Surface Should Emphasize

### Terminal

Emphasize:

- alignment
- fast iteration
- tests and diffs
- precise intervention

### Slack

Emphasize:

- natural remote requests
- approval points
- result delivery back to the same thread

### Chronos

Emphasize:

- state
- intervention
- inspectability
- project and mission control context

Chronos is the control tower, not the chat front-end.

### Presence Studio

Emphasize:

- smooth conversation
- what Kyberion understood
- what plan is being followed
- the current result or waiting point
- immediate artifact access and next action guidance

### CEO UX

Emphasize:

- requested outcome
- approvals waiting
- latest important results
- major exceptions

The CEO UX is a decision surface, not an operator console.

## 7. Observability Model

Kyberion should not expose raw backend internals first, but it must preserve them.

The recommended observability layers are:

1. `intent`
   - the original request
   - normalized resolution
   - confidence and surface context
2. `slot`
   - required fields
   - what is missing
   - what was filled by follow-up dialogue
3. `plan`
   - standard intent or template chosen
   - human-readable short plan
   - fallback or generated planning decision
4. `execution`
   - task session, browser session, or mission state
   - approvals
   - actuator steps and evidence
5. `outcome`
   - answer or artifact
   - short summary
   - next action or intervention point

Surfaces should default to showing:

- intent
- current plan
- state
- result

Operators should be able to drill down into the deeper trace when needed.

See also: [Intent-First Observability Model](intent-observability-model.md)

- live intent handling
- task detail and artifacts
- browser and operator assistance

Presence Studio should feel like the front desk, not like a mission console full of internal IDs.

## 7. Architecture Consequence

The execution system should therefore be layered like this:

### Layer 1: Intent UX

Human request and short plan.

### Layer 2: Resolution

Classification and structured routing.

### Layer 3: Durable Work Shape

Direct answer, task session, or mission.

### Layer 4: Execution

Actuators, ADF, runtime supervisor, control plane.

### Layer 5: Evidence and Distillation

Artifacts, logs, review, reusable knowledge.

## 8. Design Rule

Kyberion should expose complexity only when complexity is the thing the operator needs.

Default:

- show intent
- show plan
- show state
- show result

Advanced inspection:

- show mission
- show task session internals
- show runtime state
- show actuator and ADF detail

That separation is what keeps the system understandable as capabilities grow.

## 9. Operator Shell Information Architecture (MSN-SHELL-IA-20261105)

The operator shell (Concierge) has **seven top-level destinations and no others**:

| Nav                    | Route       | Holds                                                                                                                     |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| ホーム / Home          | `/`         | Glanceable dashboard. One aggregation (`GET /api/v1/home`), so tiles never contradict each other. Every tile drills down. |
| あなた待ち / Needs you | `/inbox`    | The only place a pending approval, decision, review, knowledge candidate, stalled request or failure is decided           |
| 仕事 / Work            | `/work`     | Mission state board, work-item kanban, mission planning                                                                   |
| 組織 / Organization    | `/org`      | Objectives and KRs, interventions, projects, people & agents                                                              |
| 資料 / Library         | `/library`  | Deliverables, knowledge (learning panel, register), intake                                                                |
| 運用 / Operations      | `/ops`      | Agents live, surfaces, diagnostics, discussion (owner)                                                                    |
| 設定 / Settings        | `/settings` | Two-pane settings with an ordered setup checklist (`GET /api/v1/setup/checklist`), pinned at the rail bottom              |

Old routes (`/w`, `/w/<kind>`, `/ops?section=…`, `/ingest`, `/setup`) answer 308 to the new ones (`src/lib/ia-routes.ts`). `/w/<kind>/<id>` detail pages stay.

**Rules that keep it from scattering again:**

- **One place per list or decision.** Anywhere else shows a count and a link (`NeedsYouLink`), never a second copy of the list or its buttons. The operator audit that motivated this found the same approvals shown in 8+ places with five different counts (6 / 7 / 43 / 2 / 0) at the same moment.
- **One count definition.** `libs/core/surface/needs-you.ts` is the only definition, and its header and the inbox's 件数の数え方 state it. An item counts when it is pending, not expired, folded by decision group, and inside the viewer's server-side scope. The HTTP routes (`/api/v1/needs-you{,/summary}`), the rail badge, Home and MCP (`kyberion.needs-you.*`) all read it. Explicit narrowing keeps only items tagged with that scope on every adapter.
- **One write path per kind.** Approvals go through `/api/approvals/[id]` (passkey for A3), reviews and hand-offs through `/api/outcomes/[id]`, knowledge through `/api/memory-queue/[id]`, and stalled requests through `/api/hygiene/[id]`.
- **No dead ends.** Every "open" goes somewhere the item can be acted on. Opening the inbox from a page that only browses must not lead back to that page.
- **Page frame.** `PageHeader` plus `.kb-page[data-width=default|wide|form]` (1280 / 1440 / 720). Spacing uses only `--kb-ui-space-1..8`, gated by `test/css-spacing-literal-gate.test.ts`. There is one page-title scale and never a nested `.kb-app-shell__main`.
- **States.** Loading, empty and couldn't-load look different. "Couldn't load" is never shown as zero. Charts encode by position or length, carry text alternatives, and use red only for the needs-you overdue.
- **Reads don't drain reasoning budgets.** Ops GETs skip the tenant reasoning bucket (`lib/ops/ops-request-guard.ts`) and stay under the read ceiling.
