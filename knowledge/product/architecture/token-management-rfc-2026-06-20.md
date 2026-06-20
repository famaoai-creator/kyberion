---
title: Token Management and Reasoning-Level Routing RFC
category: Architecture
tags: [architecture, rfc, token, reasoning, cache, reflex]
importance: 9
author: Ecosystem Architect
last_updated: 2026-06-20
---

# Token Management and Reasoning-Level Routing RFC

## 1. Status

- Status: Proposed
- Date: 2026-06-20
- Scope: internal routing, intent compilation, memory promotion, and execution telemetry
- Review disposition: implement in bounded stages; do not activate model switching, cache reuse, or automatic reflex promotion in the first change
- Implementation task guide: [`token-management-rfc-implementation-tasks-5.4-mini.md`](./token-management-rfc-implementation-tasks-5.4-mini.md)

## 2. Background

Kyberion already separates several important concerns:

- goal-level intent compilation through `compileUserIntentFlow()`
- learned contract selection through `intent-contract-learning`
- snapshot vs durable memory storage
- execution shape routing through policies and validators

The current system is therefore not missing a broad abstraction layer. It is missing an explicit policy for:

- how much reasoning to spend
- when to skip LLM calls
- when to reuse prior results
- when a successful pattern should become reusable memory

The proposal is to make that policy first-class.

## 3. Problem Statement

Today, the intent pipeline can still behave as if every request deserves roughly the same reasoning budget.
That creates three problems:

1. token cost is not controlled explicitly
2. latency savings are accidental rather than policy-driven
3. reuse and promotion are not separated cleanly enough from execution

The likely failure mode is premature optimization in the wrong place:

- a cache is added before the request class is well understood
- a reflex is promoted before the boundary conditions are stable
- an execution shortcut is treated as a product guarantee

## 4. Goals

This RFC targets the following outcomes:

1. reduce token use for repeated or low-risk intents
2. preserve explainability for why a path was chosen
3. keep LLM reasoning available for novel or ambiguous requests
4. reuse existing memory and governance boundaries instead of inventing parallel ones
5. keep public extension surfaces unchanged until a mechanism is proven

## 5. Non-Goals

This RFC does not attempt to:

- replace the existing intent compiler
- expose a new stable public contract immediately
- auto-promote every successful execution into a reflex
- optimize for token cost at the expense of correctness
- collapse all reasoning into deterministic rules

## 6. Proposed Design

### 6.1 Reasoning Levels

Introduce an internal reasoning policy with four levels:

- `COGNITIVE_EXPLORATORY`
- `COGNITIVE_STANDARD`
- `REACTION_FAST`
- `REFLEX_DETERMINISTIC`

These are not model names. They are routing classes.

The intent compiler should choose one level using request features such as:

- request ambiguity
- structural complexity
- tier or sensitivity
- presence of known patterns
- prior contract memory
- risk or approval requirement
- whether the request is goal-level or step-level

The output should include the chosen level and the reasons for it.

### 6.2 Policy-Driven Routing

The reasoning level should map to a policy, not hard-coded model selection.

Example behavior:

- `COGNITIVE_EXPLORATORY`: use richer compilation and broader candidate generation
- `COGNITIVE_STANDARD`: use normal LLM compilation with governance checks
- `REACTION_FAST`: use a small model or constrained route when the request is well bounded
- `REFLEX_DETERMINISTIC`: bypass LLM compilation entirely when the intent is already canonical

This keeps the routing decision explicit and measurable.

### 6.3 Intent Contract Cache

Add a cache only after the reasoning level is known.

Cache the normalized intermediate result, not raw model output.

Recommended cache key inputs:

- normalized intent text
- locale
- tier
- surface or channel
- service bindings
- runtime context fingerprint
- policy version
- schema version
- model/provider version
- reasoning level

Recommended cache behavior:

- safe to reuse only when the key is identical
- invalidated by any policy or schema drift
- bypassed for exploratory or approval-sensitive cases
- instrumented so hit rate and stale-hit risk are visible

This cache should be treated as an optimization for the deterministic or low-risk lane only.

### 6.4 Reflex Promotion

Reflex promotion should be a separate stage, not a side effect.

Flow:

```text
execute
-> assess
-> distill candidate
-> governed review
-> promote
-> reuse
```

Eligible outputs should be promoted only when:

- the pattern is reusable
- the output is governed and traceable
- the pattern is stable across repeated use
- the memory tier is appropriate

For implementation, promoted reflexes should land in a governed procedure location such as:

- `knowledge/public/procedures/reflexes/`

or an equivalent tier-appropriate path chosen by policy.

### 6.5 Consciousness Fallback

Fallback should remain available when:

- the cache misses
- the reflex is stale
- a low-cost route fails validation
- policy or environment drift makes the fast lane unsafe

Fallback behavior:

1. upgrade to a higher reasoning level
2. recompile the request
3. refresh the cache only if the new result passes validation
4. record the failure reason for later policy refinement

Fallback is a safety mechanism, not the primary design.

## 7. Alignment With Existing Architecture

This RFC is compatible with the current architecture because it reuses existing boundaries:

- `compileUserIntentFlow()` already separates compilation from execution
- `intent-contract-learning` already stores snapshot and durable state
- the corporate memory loop already distinguishes capture, assess, distill, promote, and reuse
- the extension policy already treats internal mechanisms as internal

That means the proposal should be implemented inside internal routing and learning paths first, without changing stable public surfaces.

## 8. Implementation Phases

### Phase 1: Observability

Add internal trace fields for:

- reasoning level
- candidate source
- cache hit or miss
- fallback reason
- model/provider used

No behavioral change yet.

### Phase 2: Reasoning-Level Routing

Add the policy decision that selects a reasoning level before compilation.

Keep the output advisory at first if needed.

### Phase 3: Deterministic Cache

Enable cache reuse only for low-risk and fully normalized cases.

Gate it behind strict invalidation and telemetry.

### Phase 4: Reflex Promotion

Add governed promotion for stable reusable patterns.

Keep human review in the loop for high-impact or cross-tier candidates.

## 9. Success Metrics

The proposal should be considered successful if:

- repeated low-risk intents show lower token usage
- latency drops without a rise in incorrect routing
- reasoning-level decisions are explainable in traces
- cache hit rate is meaningful but not coupled to correctness regressions
- promoted reflexes remain reusable and governable

## 10. Risks

### 10.1 Premature Caching

If the cache key is too broad, stale intent decisions may be reused.

Mitigation:

- include policy/schema/model fingerprints
- keep the cache internal
- require validation before reuse

### 10.2 Reflex Drift

If reflex promotion is too eager, the system can fossilize a brittle pattern.

Mitigation:

- require assess and governed review
- limit promotion to stable patterns
- keep fallback available

### 10.3 Hidden Behavioral Change

If reasoning-level routing is introduced without traceability, the system will be harder to debug.

Mitigation:

- emit the level and the rule path
- require trace and receipt visibility

## 11. Decision

Recommended order of implementation:

1. reasoning-level classification and telemetry
2. deterministic cache for normalized results
3. governed reflex promotion

This order is intentional.
It gives Kyberion the ability to measure where tokens are spent before it tries to eliminate them.

## 12. Open Questions

1. Which request features are sufficient for the first-pass reasoning-level classifier?
2. Which contexts are safe to include in the cache key without overfitting?
3. What promotion threshold is appropriate for reflex creation?
4. Should reflex promotion land under public procedures, or under a tier-specific governed memory path first?
