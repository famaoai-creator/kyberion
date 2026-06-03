---
title: Capability Bundle Progressive Disclosure
category: Orchestration
tags: [orchestration, capability-bundle, progressive-disclosure, registry]
importance: 8
author: Ecosystem Architect
last_updated: 2026-05-03
---

# Capability Bundle Progressive Disclosure

## 1. Purpose

Kyberion should not dump full capability metadata into every prompt or
surface by default.

Capability bundles are discovery objects. Operators and models should see:

1. a short summary first
2. full registry detail only when needed

This mirrors Hermes-style progressive disclosure while staying aligned
with Kyberion's actuator/pipeline model.

## 2. Display Rule

For normal intent resolution and surface guidance:

- show bundle id
- show bundle status
- show the high-level capability area
- show the most relevant actuators or harness references

For deeper inspection:

- expand into the full registry entry
- include references, source bundle paths, and the full intent list

## 3. Kyberion Application

The primary places that should use summary-first rendering are:

- intent compiler prompts
- operator UX guidance
- task-session and mission summaries
- surface discovery panels

The detailed registry view remains available for audits and debugging,
but it should not be the default surface for every turn.

## 4. Rule

If a user or system only needs to choose a capability, show the short
bundle summary.

If they need to inspect provenance, policy, or implementation detail,
expand the bundle registry entry explicitly.

