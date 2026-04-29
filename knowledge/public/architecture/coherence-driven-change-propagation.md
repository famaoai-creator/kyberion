---
title: Coherence-Driven Change Propagation
category: Architecture
tags: [change-propagation, coherence, impact-analysis, sdlc]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-29
---

# Coherence-Driven Change Propagation

## Purpose

Kyberion should not treat change requests as isolated prompts.

For software development work, a change must be interpreted as:

`intent -> affected scope -> governed process -> evidence -> follow-up execution`

This document adapts the main CoDD idea into Kyberion:

- changes should propagate through governed artifacts
- impact should be classified before execution
- follow-up work should be split into bounded missions

## Imported Concepts

### 1. Coherence Over One-Off Generation

Kyberion should preserve consistency across:

- requirements
- design
- implementation
- verification
- operations

This fits the existing `Project -> Track -> Mission -> Gate` model.

### 2. Impact Bands

Borrowed concept:

- `green`
  directly bound scope, can be promoted into bounded execution quickly
- `amber`
  likely relevant, must be reviewed before fan-out
- `gray`
  informative only

Kyberion now uses these bands in analysis briefs for:

- incident-informed review
- cross-project remediation

### 3. Propagation Rather Than Manual Re-Discovery

When a requirement, incident lesson, or fix changes, the system should identify:

- which project or track is affected
- which governed references support the claim
- which follow-up missions are needed

## Kyberion Mapping

| CoDD idea | Kyberion mapping |
|---|---|
| requirements/design/code/test coherence | `work_loop.process_design` + `Track` gate model |
| impact analysis | analysis brief with `impact_bands` |
| propagation | mission seed fan-out |
| wave / V-model sequencing | SDLC gate readiness + next required artifacts |

## Current Runtime Shape

Today, Kyberion supports this flow:

1. Normalize a change-oriented intent such as:
   - `incident-informed-review`
   - `cross-project-remediation`
2. Infer project, track, and review target when possible.
3. Gather governed references:
   - incident knowledge
   - promoted reusable refs
   - project/track context
4. Build an analysis brief with:
   - process design
   - reference snippets
   - impact bands
5. Fan out follow-up seeds:
   - review
   - remediation
   - verification

The responsibility boundary for this flow is:

- LLM
  - drafts findings language and summaries
- knowledge
  - defines process and routing
- compiler
  - binds review targets, impact bands, and execution contracts
- executor
  - persists analysis artifacts and follow-up seeds

Reference:

- [analysis-execution-boundary.md](./analysis-execution-boundary.md)

## Remaining Work

- bind `pull_request:*`, `artifact:*`, and `file:*` targets to actual repository execution paths
- derive follow-up seeds from structured findings instead of generic fan-out
- add project-local dependency maps for spec/design/code/test propagation
- expose impact bands in Chronos, Presence, and CLI

## Principle

Kyberion should not guess blindly when requirements change.

It should:

- identify the governed scope
- classify the impact
- propose bounded follow-up execution

That is the Kyberion form of coherence-driven development.
