---
title: CLI Harness Coordination Model
category: Architecture
tags: [cli, harness, skills, plugins, agents, browser, computer-use, governance]
importance: 9
author: Ecosystem Architect
last_updated: 2026-04-18
---

# CLI Harness Coordination Model

## Executive Verdict

Yes.

Over time, browser interaction, computer use, delegated agents, and other execution primitives will increasingly be provided by the host CLI and its native harness.
Kyberion should plan for that directly.

The strongest long-term position is:

- do not compete with the host CLI on low-level capability primitives
- do not surrender Kyberion's governance, contract, approval, and memory model
- build a clean coordination layer between the two

The strategic mistake would be either of these extremes:

- Kyberion reimplements every primitive forever
- Kyberion gives the host CLI direct authority without governance contracts

The correct middle is:

- host-native capability
- Kyberion-governed orchestration

## Core Thesis

Kyberion should treat the host CLI as an evolving execution harness.

That harness may provide:

- model access
- skills
- plugins
- delegated agents
- browser control
- computer-use control
- terminal or environment tools

Kyberion should treat those as `governed capability surfaces`, not as informal conveniences.

That means every meaningful host-native capability should still be routed through:

- intent resolution
- authority checks
- approval policy
- execution contracts
- observability and evidence
- fallback rules

## Responsibility Split

## 1. Host CLI And Harness Responsibilities

The host CLI should own the fast-moving execution substrate:

- low-level model invocation
- skill and plugin execution
- built-in sub-agent orchestration
- native browser and computer-use loops
- session-level terminal primitives
- provider-specific runtime details

The host is the best place for these because it can evolve quickly with the provider.

## 2. Kyberion Responsibilities

Kyberion should own the stable operating model:

- intent normalization
- work-shape selection
- authority boundaries
- approval and risk rules
- governed contracts
- deterministic actuator orchestration
- evidence retention
- memory and distillation
- promotion and rollback rules

Kyberion is not the right place to chase every new primitive.
Kyberion is the right place to decide when and why a primitive should be used.

## 3. Shared Boundary

The shared boundary should be explicit.

Every host-native capability used by Kyberion should expose:

- capability identity
- risk classification
- invocation contract
- approval hooks
- observation shape
- result shape
- replayability classification
- fallback path

If any of those are missing, the integration is incomplete.

## Capability Classes

Kyberion should classify host-native capabilities into a small number of governed classes:

### 1. `reasoning`

Examples:

- model completion
- structured JSON generation
- comparison and summarization

### 2. `interactive_tooling`

Examples:

- browser navigation
- computer use
- terminal session assistance

### 3. `delegated_execution`

Examples:

- sub-agents
- worker agents
- plugin-backed task handlers

### 4. `deterministic_utility`

Examples:

- file conversion
- schema validation
- artifact rendering
- static analysis

These classes matter because each class has different governance and replay expectations.

## Browser And Computer Use Direction

Kyberion should assume that browser and computer-use features will increasingly exist natively in the host CLI.

That does not make Kyberion's own actuator layer obsolete.
It changes the routing rule.

Recommended split:

- use host-native browser or computer-use loops for:
  - exploratory tasks
  - ambiguous interaction loops
  - observation-heavy work
  - provider-optimized interactive control
- use Kyberion-local actuators for:
  - deterministic repeatable flows
  - governed pipelines
  - artifact-producing workflows
  - replay-sensitive and audit-heavy execution

This means the future is not one path replacing the other.
The future is dual-path routing with policy-based selection.

## Dual-Path Routing Rule

When both a host-native path and a Kyberion-local path exist, Kyberion should choose by work shape:

- `interactive exploration`
  - prefer host-native path
- `repeatable governed execution`
  - prefer Kyberion-local actuator path
- `mixed mode`
  - explore with host-native path, then convert the stable result into a Kyberion-governed contract for repeatable execution

That last mode is likely to be the most powerful pattern in practice.

## Required Contracts

Reasoning-specific routing should use the policy surface in [`wisdom-policy.json`](/Users/famao/kyberion/knowledge/public/governance/wisdom-policy.json).
That policy declares the profile, command, and adapter that should be used for mission distillation and similar structured reasoning tasks.

## 1. Harness Capability Registry

Suggested artifact:

- `knowledge/public/governance/harness-capability-registry.json`

Purpose:

- declare which host-native capabilities Kyberion is allowed to use
- describe their risk and replay profile
- define preferred and fallback routing

Suggested artifact:

- `knowledge/public/governance/harness-adapter-registry.json`

Purpose:

- map host-native or provider-runtime surfaces to Kyberion contracts
- capture adapter identity, surface kind, and fallback contract
- keep provider-specific runtime details outside ADF

## 2. Harness Adapter Profile

Suggested artifact:

- `knowledge/public/schemas/harness-adapter-profile.schema.json`

Purpose:

- describe the adapter between a host-native capability and Kyberion contracts

Suggested fields:

- `adapter_id`
- `provider`
- `surface_kind`
- `capability_id`
- `contract_kind`
- `observation_kind`
- `result_kind`
- `approval_behavior`
- `replayability`
- `fallback_contract`

The adapter registry should stay small and governed. It is not a second ADF.
It is the lookup table that tells Kyberion which native surface can safely
serve a given work shape.

## 3. Integration Decision

Suggested artifact:

- `knowledge/public/schemas/integration-decision.schema.json`

Purpose:

- record whether a capability should stay local, move host-native, or remain dual-path

Decision values:

- `local_only`
- `host_only`
- `dual_path`
- `defer`

## 4. Harness Evaluation Report

Suggested artifact:

- `active/shared/evaluations/model-adaptation/<run-id>/harness-evaluation-report.json`

Purpose:

- compare local and host-native paths on actual Kyberion tasks

## Routing Policy

Kyberion should add explicit routing policy for:

- local versus host-native browser execution
- local versus host-native computer-use execution
- plugin versus actuator execution
- agent-harness delegation versus mission-worker delegation

Those should not be hidden in prompts alone.
They should be policy-visible and benchmarkable.

## Observability Rules

When Kyberion uses a host-native capability, traces should still record:

- which capability ran
- which host version and model family were active
- whether the path was local or host-native
- whether approval was required
- whether fallback occurred
- what evidence was captured

If Kyberion cannot explain which path executed, it has lost operational clarity.

## Implementation Tracks

## Track A. Registry And Schemas

- define `harness-capability-registry.json`
- define `harness-adapter-profile.schema.json`
- define `integration-decision.schema.json`
- define capability classes and risk classes

## Track B. Adapter Layer

- build adapter interfaces for host-native browser and computer-use paths
- build adapter interfaces for host-native skills, plugins, and delegated agents
- normalize results into Kyberion contracts and evidence records
- preserve fallback into Kyberion-local actuator execution

## Track C. Routing

- create policy-visible local-versus-host routing rules
- add work-shape aware selection logic
- support dual-path routing where exploration and replayability both matter
- prevent silent overlap between native plugins and local actuators

## Track D. Evaluation

- benchmark local and host-native paths on the same scenarios
- score task success, approval obedience, evidence quality, and replayability
- detect regressions when a host-native path becomes worse than the local path
- feed results into promotion decisions

## Track E. Concept Review

- keep Kyberion concepts stable where possible
- revise concepts only when host-native evolution changes the real operating boundary
- document concept changes separately from adapter tuning

## Design Rule

Kyberion should increasingly become:

- less of a primitive collector
- more of a governed operating kernel over evolving host-native capabilities

That is the durable strategy.
