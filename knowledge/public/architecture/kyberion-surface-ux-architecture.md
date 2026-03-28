---
title: Kyberion Surface UX Architecture
category: Architecture
tags: [architecture, ux, surface, mission, chronos, presence, intent]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-29
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

Chronos is the control tower, not the chat front-end.

### Presence Studio

Emphasize:

- smooth conversation
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
