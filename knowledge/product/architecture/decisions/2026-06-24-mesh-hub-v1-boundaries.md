---
title: Constrain Mesh Hub v1 to a Same-Tenant Single-Writer Control Plane
category: Architecture
tags: [adr, mesh-hub, peer, messaging, routing, tenancy, security]
importance: 10
author: Ecosystem Architect
last_updated: 2026-06-24
---

# Constrain Mesh Hub v1 to a Same-Tenant Single-Writer Control Plane

## Status

Accepted

## Context

The Mesh Hub implementation instructions identify six decisions that must be resolved before the dependent implementation tasks begin. Leaving them implicit would let workers infer incompatible service, trust, routing, and approval behavior.

Existing `peer-messaging` provides local/LAN signed HTTP delivery but has static peer catalog entries and synchronous handling. Existing A2A, WorkItem, and mission-control layers have distinct ownership and must not be bypassed.

## Decision

### 1. Hub placement

v1 is an in-process local control-plane module with one Mesh Hub writer per runtime root. It exposes library APIs and optional local inspection commands; it is not a separately network-exposed service.

### 2. Same-tenant enrollment source

The operator-managed peer catalog is the bootstrap enrollment source in v1. A peer registration becomes eligible only when it also has a valid runtime presence record. The catalog cannot override a runtime revocation or tenant mismatch.

### 3. Routable capability vocabulary

v1 accepts only explicit, policy allowlisted collaboration request kinds:

- `review.request`
- `workitem.claim`
- `workitem.handoff`
- `workitem.status_update`
- `capability.query`
- `notification.publish`

Arbitrary actuator operations, shell commands, browser actions, secret access, and mission lifecycle actions are local-only and cannot be addressed through Mesh Hub routing.

### 4. Data-tier delivery

All routed payloads use an artifact reference plus metadata, integrity hash, and declared classification. `confidential` content may be referenced only within the same tenant and is not copied into Hub journals, route explanations, topic payloads, or dead letters. `personal` content is not routable in v1. Topic publications are restricted to `public` metadata and same-tenant `confidential` artifact references where policy explicitly permits them.

### 5. Routing load signal

v1 routes on deterministic eligibility only: enrollment, tenant, presence freshness, advertised capability, request kind, and policy. It does not use CPU, queue depth, token use, model availability, or inferred quality as scheduling signals. If several eligible peers remain, the router returns `requires_operator_selection` unless a caller selects an explicit peer.

### 6. Recipient acceptance and approval

Hub delivery is transport acceptance only. A recipient may convert a request into a WorkItem proposal or an A2A task proposal after local schema, tenant, and policy validation. It must require explicit recipient acceptance for `review.request`, `workitem.handoff`, and every request that could cause external side effects. No Hub message may create, start, resume, alter, or approve a mission.

## Rationale

This scope lets v1 prove discovery, routing, durable delivery, and auditability without inventing federation, distributed scheduling, cross-tenant trust, or a second mission-control path. It also makes routing deterministic and testable by `gpt-5.4-mini` without live model or infrastructure dependencies.

## Consequences

- A future dedicated Hub service requires a new ADR covering authentication, high availability, and storage transactions.
- A future cross-tenant mesh requires peer enrollment, key rotation, revocation propagation, and explicit data-sharing contracts.
- Existing `peer-messaging` remains backward compatible; v1 integrates through a new adapter.
- The Mesh Hub policy must encode the routable request-kind allowlist and topic data-tier rules.

## Alternatives Considered

### Expose the Hub as a network service in v1

Rejected. It would introduce external authentication, lifecycle, and availability requirements before the local routing and queue semantics are proven.

### Use dynamic performance metrics for automatic peer selection

Rejected. The metrics are not yet governed, comparable, or stable enough to become a scheduler. Explicit selection is safer than hidden load balancing.

### Allow peer messages to create missions directly

Rejected. It violates the mission-controller single-authority rule and creates a remote privilege-escalation path.

## Validation and Supersession

- Task 1 must encode the request-kind and data-tier restrictions in schema/policy validation.
- Tasks 2-4 must prove tenant, presence, and explicit-peer selection behavior with deterministic tests.
- Task 5 must prove that a delivered request cannot mutate mission lifecycle state.
- Supersede this ADR before implementing federation, a network-exposed Hub, automatic scheduling, or cross-tenant delivery.
