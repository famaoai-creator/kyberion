---
title: Harness Adoption Plan 2026-05
category: Architecture
tags: [architecture, harness, control-plane, skills, kanban, multimodal, security]
importance: 8
author: Ecosystem Architect
last_updated: 2026-05-26
---

# Harness Adoption Plan 2026-05

## 1. Objective

Bring the useful parts of the current harness landscape into Kyberion without flattening Kyberion into a generic agent shell.

The goal is not to copy other products.
The goal is to absorb the parts that improve first-use success, multimodal reach, reusable skills, durable collaboration, and governance.

The supporting survey is documented in
[`../external-wisdom/harness-landscape-scan-2026-05.md`](../external-wisdom/harness-landscape-scan-2026-05.md).

## 2. Design stance

Kyberion should keep these layers distinct:

- `surface`
  - where the user enters
- `harness`
  - how a task executes
- `control plane`
  - how policy, budgets, approvals, and observability are enforced
- `mission`
  - the durable owner of work
- `board`
  - the durable collaboration substrate for multi-agent handoffs

That separation prevents Kyberion from becoming a single undifferentiated “agent app”.

## 3. Absorption phases

### Phase 1: Multimodal first run

Absorb the “I can use this immediately” pattern.

Implementation targets:

- voice entry through Presence Studio and voice-hub
- image and document generation as first-class actions
- browser attach and local desktop inspection as quick-start paths
- initial guidance that names the next action, not the internal runtime

### Phase 2: Shareable skills and plugins

Absorb reusable skills the way Codex, Claude Cowork, Hermes, and OpenClaw are doing it.

Implementation targets:

- make skill bundles shareable across surfaces
- keep skill install and skill activation approval-aware
- maintain a single source of truth for skill metadata
- let CLI, browser, and message surfaces reuse the same skill references

### Phase 3: Durable multi-agent collaboration

Absorb the kanban-style collaboration / work-board pattern rather than relying only on transient delegation.

Implementation targets:

- one durable board per project or collaboration stream
- named agents and explicit assignees
- persistent comments and event history
- retry/block/unblock semantics
- clean handoff from conversation to mission when work becomes durable

### Phase 4: Control plane hardening

Absorb the control-plane pattern from OpenHands and the enterprise controls from Claude Cowork.

Implementation targets:

- policy routing
- budgets and usage visibility
- approval scopes
- trace and audit trails
- runtime and provider observability

### Phase 5: Provider-native bridges

Absorb provider-native browser and desktop surfaces only through the bridge layer.

Implementation targets:

- keep provider-specific mechanics out of ADF
- register the surface in the capability registry
- map the surface through an adapter registry
- record receipts with `capability_id`, `adapter_id`, and `trace_id`

## 4. Current Kyberion mapping

| External pattern | Kyberion surface |
|---|---|
| Voice-first entry | `presence/displays/presence-studio/` + `satellites/voice-hub/` |
| Multimodal desktop | Presence Studio + browser bridge + media workflows |
| Shared skills | `knowledge/product/governance/harness-capability-registry.json` + capability bundles |
| Durable work board | mission/task-session plus a board-like collaboration layer |
| Control plane | mission governance + runtime observability + policy engine |
| Browser attach | browser actuator / browser-interactive bridge |

## 5. Security review using OWASP

The plan should be reviewed against the OWASP Top 10:2021 and OWASP API Security Top 10.

Priority checks:

- Broken Access Control
  - can a low-privilege surface read or mutate a high-privilege capability?
- Identification and Authentication Failures
  - are remote entrypoints and token-based paths enforced consistently?
- Injection
  - are prompts, browser content, uploaded files, and connector payloads validated?
- Security Misconfiguration
  - are loopback-only defaults, headers, and service URLs constrained?
- Vulnerable and Outdated Components
  - are skill, plugin, and browser dependencies tracked and audited?
- Software and Data Integrity Failures
  - are shared skills, plugins, and downloaded artifacts verified before use?
- Security Logging and Monitoring Failures
  - are approvals, denials, and high-risk actions observable?
- Server Side Request Forgery
  - are browser and connector fetches allowlisted and local-service scoped?

API-focused checks:

- Broken Object Level Authorization
- Broken Authentication
- Broken Function Level Authorization
- Unrestricted Resource Consumption
- Unsafe Consumption of APIs

## 6. Scenario tests to keep the plan real

The plan is only useful if it maps to repeatable tests.

Required scenario coverage:

- voice bootstrap and native listening
- browser bootstrap and browser action routing
- email triage draft and approved delivery
- skill discovery and skill sharing
- multi-agent task handoff and board persistence
- provider-native capability discovery and fallback behavior
- security gating for local-only and remote-auth paths

## 7. Exit criteria

This plan is complete when:

- the report is checked into `knowledge/public/external-wisdom/`
- the adoption plan is linked from the provider-native bridge documentation
- the capability registry and adapter registry reflect the new surface classes
- the scenario test suite proves the new docs and registry entries stay in sync
- the security review checklist is visible and exercised in validation

Until then, the plan should be treated as a living implementation contract, not a design note.
