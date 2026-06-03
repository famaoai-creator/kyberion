---
title: Management Control Plane
category: Architecture
tags: [architecture, chronos, control-plane, observability, accountability]
importance: 9
author: Ecosystem Architect
last_updated: 2026-03-29
---

# Management Control Plane

## 1. Purpose

The management control plane is the operational visibility and intervention layer for organizational work.

If the CEO UX answers:

- what outcome matters
- what approvals are waiting

then the management control plane answers:

- why work is in its current state
- what is blocked
- what the system is doing
- where intervention is needed

Chronos should evolve into this role.

## 2. Responsibilities

The management control plane should provide:

- project visibility
- mission visibility
- mission seed visibility
- task and artifact lineage
- service binding visibility
- evidence drill-down
- runtime and queue health
- operator interventions

It is the home of accountability and governance-aware operations.

## 3. Primary Views

### 3.1 Projects

Shows:

- active projects
- owning context
- next work
- current mission/task footprint
- service relationship footprint

### 3.2 Missions

Shows:

- active durable work
- state
- owner/runtime relationship
- blockers
- evidence and outputs

### 3.3 Mission Seeds

Shows:

- candidate durable work
- source task or bootstrap work
- proposed specialist
- mission type hint
- promotion status

### 3.4 Approvals

Shows:

- pending approvals
- delayed approvals
- decision owner
- consequence of waiting

### 3.5 Artifacts

Shows:

- recent outputs
- project/mission/task ownership
- storage class
- delivery status
- external references

### 3.6 Service Bindings

Shows:

- governed external contracts
- target systems
- allowed actions
- approval posture
- health or readiness

### 3.7 Runtime and Risk

Shows:

- surface health
- queue backlog
- failed deliveries
- policy violations
- external dependency failures

## 4. Intervention Model

The control plane should support deterministic interventions such as:

- promote mission seed
- retry delivery
- inspect evidence
- request clarification
- escalate to approval
- restart bounded runtime where policy permits

These interventions should remain governed and observable.

## 5. Design Rules

### 5.1 Accountability-first

Every important state transition should be explainable through:

- source work
- evidence
- artifact lineage
- policy state
- execution state

### 5.2 Project-aware by default

Operators should be able to understand work through project context first, not only through isolated mission identifiers.

### 5.3 Human-readable first

The control plane may expose more detail than the CEO UX, but it should still prefer:

- intent
- plan
- state
- result

before raw internals.

### 5.4 Escalation path

Deep runtime details should remain available, but through drill-down rather than as the default surface.

## 6. Relationship to Existing Components

In the current system:

- `Presence Studio`
  - immediate conversational surface
- `Chronos`
  - emerging management control plane
- mission ledger and runtime observability
  - evidence substrate

The goal is not to replace these components, but to align them into a coherent operator model.

## 7. Success Criteria

The management control plane succeeds when an operator can:

- explain what the system is doing
- see what is blocked
- know where authority is required
- inspect what evidence supports an outcome
- intervene without dropping to raw implementation detail first
