---
title: Project Mission Artifact Service Model
category: Architecture
tags: [architecture, project, mission, artifact, service-binding, vault, outcome]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-29
---

# Project Mission Artifact Service Model

## 1. Purpose

Kyberion already has strong execution primitives:

- actuators
- ADF contracts
- task sessions
- missions
- vault

The next architectural step is to make the system explicitly:

- project-aware
- outcome-aware
- service-aware

This document defines the smallest coherent model that extends the current system without replacing its execution core.

## 2. Core Thesis

Kyberion should resolve user requests through these containers:

```text
Intent
-> Project Context
-> Outcome
-> Specialist Team
-> Task Session or Mission
-> Artifact / Delivery
-> Vault / Observability
```

The user should speak in outcomes.
The system should decide the execution shape.

## 3. First-Class Objects

### 3.1 Project

`Project` is the container of meaning.

It holds:

- long-lived purpose
- repositories
- major artifacts
- service bindings
- vault references
- active missions
- related task sessions

Examples:

- build a new web service
- operate a product launch
- maintain a client delivery program

### 3.2 Mission

`Mission` is the container of durable execution.

It is used when work must be:

- resumable
- auditable
- multi-step
- multi-agent
- checkpointed

Mission is not the first user-facing concept.
It is the durable backend control container.

### 3.3 Task Session

`Task Session` is the conversational work container.

It is used for:

- document generation
- service inspection
- bounded analysis
- browser assistance
- capture flows

Task sessions may remain standalone, or may belong to a project and later promote into durable mission work.

### 3.4 Artifact

`Artifact` is the concrete outcome.

Examples:

- `pptx`
- `docx`
- `xlsx`
- rendered summary
- browser result
- approval record
- delivery receipt

Every artifact should carry explicit ownership metadata.

### 3.5 Service Binding

`Service Binding` is the governed connection contract to the outside world.

Examples:

- GitHub repository access
- Slack delivery target
- Notion workspace access
- Google Drive folder access
- weather/search provider

Bindings are not secrets themselves.
They reference secrets and policies.

### 3.6 Vault

`Vault` is the trust boundary.

Vault stores:

- secrets
- strong-trust references
- approval evidence
- governed long-lived sensitive memory

Vault is not the default output folder for all artifacts.

## 4. Execution Shape Rules

### Use a Task Session when the request is:

- conversational
- bounded
- expected to return one answer or one artifact
- easy to clarify through slot filling

Examples:

- `このPDFをパワポにして`
- `試験計画書を作って`
- `voice-hub の状態を見て`

### Use a Mission when the request is:

- long-running
- repository-heavy
- cross-agent
- checkpoint-worthy
- safety or audit sensitive

Examples:

- `この機能を実装してPRまで`
- `サービス移行を進めて`
- `大きい障害対応を完了して`

### Use Project Bootstrap when the request implies long-lived context

Examples:

- `Webサービスを作って`
- `この事業の管理基盤を作って`

In these cases, Kyberion should first create or select a project context, then create missions and task sessions under it.

## 5. Artifact Ownership

Every artifact should include:

- `project_id`
- `mission_id` optional
- `task_session_id` optional
- `kind`
- `storage_class`
- `path` or `external_ref`

Recommended `storage_class` values:

- `repo`
- `artifact_store`
- `vault`
- `tmp`
- `external_ref`

This ensures storage, retention, and delivery policy remain coherent.

## 6. Service Binding Contract

A service binding should define:

- `binding_id`
- `service_type`
- `scope`
- `target`
- `allowed_actions`
- `secret_refs`
- `approval_policy`

This separates:

- execution capability
- service contract
- secret ownership

## 7. Specialist Teams

Users should generally speak to one front-facing assistant.
Internally, Kyberion may route work to specialists.

Suggested specialist roles:

- `surface-concierge`
- `browser-operator`
- `document-specialist`
- `service-operator`
- `knowledge-specialist`
- `mission-lead`

The user-facing UI should expose only:

- who is handling the request
- what short plan is being followed
- what result is expected

## 8. Relationship to Existing Architecture

This model does not replace:

- actuator-first execution
- ADF
- task sessions
- missions
- vault

It clarifies the higher-order meaning layer above them.

In short:

- `Project` adds long-lived context
- `Outcome` clarifies what the user expects back
- `Service Binding` clarifies external system contracts
- `Mission` remains the durable execution container
- `Task Session` remains the conversational work container

## 9. Observability

The user journey should remain:

```text
intent -> slot -> plan -> execution -> outcome
```

This model should be visible in:

- surfaces
- Chronos
- durable observability streams

The system should not require users to think in:

- actuator names
- raw ADF
- mission ledgers
- low-level runtime topology

But it must preserve those details for operator inspection.
