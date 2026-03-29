---
title: Hardening Backlog
category: Architecture
tags: [hardening, backlog, governance, usability]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-29
---

# Hardening Backlog

## Goal

Preserve Kyberion's governance strictness while making execution easier to operate.

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
