---
title: Hardening Backlog
category: Architecture
tags: [hardening, backlog, governance, usability]
importance: 8
author: Ecosystem Architect
last_updated: 2026-04-18
---

# Hardening Backlog

## Goal

Preserve Kyberion's governance strictness while making execution easier to operate.

## Priority 0

### Concept Compression

- publish one canonical operating path: `intent -> contract -> governed execution -> evidence`
- reduce overlapping artifact names and keep only a small stable contract family
- define which decisions belong to LLM, contract compiler, actuator, and host harness with no shared ambiguity

### Instruction Precision

- require a compact execution receipt for every request: interpreted goal, expected deliverable, missing inputs, approval gates
- strengthen normalization for terse operator commands such as `commit & pr & merge`, `same as gemini`, and cross-machine sync requests
- add regression scenarios for multilingual shorthand, omitted subjects, and implied follow-up actions

### Provider Adapter Parity

- define one shared enhancer contract for Gemini, Codex, and future host adapters instead of provider-specific prompt shaping logic
- add parity tests so the same intent and approval expectations produce equivalent behavior across adapters
- keep provider-specific prompt augmentation isolated from Kyberion core concepts and execution contracts

### Capability Admission Discipline

- require every new skill, plugin, agent, browser path, or computer-use path to declare why it exists, when it is preferred, and what replaces it if removed
- reject host-native integrations that do not expose approval hooks, evidence shape, and fallback behavior
- measure complexity directly through clarification count, contract size, routing branch count, and concept count

### Security And Maintainability Review (2026-04-18)

- tighten permissive read-only auto-approval matching to avoid keyword false positives in tool titles
- enforce additive enhancer option merge so one enhancer cannot silently drop prior execution options
- avoid full prompt logging in adapter runtime logs; keep short summaries to reduce accidental sensitive context exposure
- keep deterministic wisdom context load order to reduce run-to-run drift and improve reproducibility

## Priority 1

### Intent Normalization

- strengthen multilingual trigger detection
- normalize Japanese request patterns into archetype-friendly hints
- expand synonym coverage for required inputs and artifact names

### Input Binding

- infer required inputs from context aliases
- expose `input_bindings` in execution briefs
- make clarification packets explain exactly what matched and what is still missing

### Path Contracts

- distinguish file-path inputs from directory-path inputs earlier
- validate artifact handoff shape before downstream execution
- fail fast with path-type-specific errors

## Priority 2

### Golden Scenario Packs

- define canonical valid scenarios
- define controlled invalid variants
- separate product weakness from malformed test setup

### Operator UX

- shorten clarification output
- show next required artifact, template, and skeleton consistently across surfaces and CLI
- reduce dependence on raw internal IDs

### Authority Diagnostics

- improve `POLICY_VIOLATION` explanation
- indicate required authority level and permitted path class

## Priority 3

### Cross-Actuator Delivery Contracts

- prefer artifact contracts over raw path passing
- add more typed handoff records between browser, modeling, media, and artifact flows

### Surface Consistency

- keep Presence, Chronos, and CLI on the same vocabulary
- avoid route-specific drift in control-plane behavior

## Priority 4

### Model And Harness Adaptation Governance

- define a governed adaptation cycle for LLM and host CLI harness upgrades
- add model registry, harness capability registry, adaptation policy, and promotion gates
- benchmark candidate models and host-native capabilities on contract validity, policy obedience, clarification quality, and local-versus-host routing quality
- require explicit architecture review before changing Kyberion concepts or capability ownership boundaries

Reference:

- [LLM Execution Boundary](/Users/famaoai/k/d/kyberion/knowledge/public/architecture/llm-execution-boundary.md)
- [Model and Harness Adaptation Phase](/Users/famaoai/k/d/kyberion/knowledge/public/architecture/model-adaptation-phase.md)
- [CLI Harness Coordination Model](/Users/famaoai/k/d/kyberion/knowledge/public/architecture/cli-harness-coordination-model.md)
