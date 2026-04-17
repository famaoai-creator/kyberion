---
title: Kyberion Abstraction and Security Improvement Plan
category: Architecture
tags: [architecture, security, abstraction, governance, plan]
importance: 10
author: Ecosystem Architect
last_updated: 2026-04-06
---

# Kyberion Abstraction and Security Improvement Plan

## Executive Verdict

Kyberion's direction is largely correct.

The core concept is coherent:

- humans speak in intent
- knowledge defines governed process and boundaries
- compilers turn semantic work into executable contracts
- executors persist evidence and replayable results

However, the current repository is still in a mixed state.

The main gap is not philosophy.
The main gap is that enforcement and abstraction are still split across:

- knowledge documents
- TypeScript branching logic
- route-specific classifiers
- actuator-local exceptions

So the current verdict is:

- concept: sound
- abstraction level: improving, but still partially mixed
- security posture: directionally strong, enforcement is inconsistent
- immediate need: targeted consolidation, not reinvention

## Implementation Status Update

The first consolidation pass is now in place.

Implemented in this cycle:

- `media-actuator` production entrypoints were moved off raw `node:fs` access and onto `secure-io` aligned primitives and governed temp paths
- approval derivation now flows from a single inference path into both `payload.approval_required` and persisted `control.requires_approval`
- `intent_resolution_packet` now exists as a first-class runtime contract with schema coverage and tests
- `task-session` classification now resolves intent first, then applies runtime-specific binding rules
- work design execution boundaries, runtime design, and specialist routing are now compiled from knowledge catalogs instead of intent-specific TypeScript branching
- `capture-photo` was promoted into the surface intent catalog so the resolver and knowledge layer no longer disagree on that path
- advanced analysis intents now resolve to knowledge-owned execution contract definitions instead of freeform analysis-only payloads
- coverage tests now verify those analysis execution contracts as part of repository drift detection
- browser-session and direct-reply routing now pass through the shared intent resolver before runtime-specific command or query shaping
- approval derivation policy is now knowledge-owned instead of being embedded only in task-session runtime code
- repo-wide raw `node:fs` imports are now checked by a boundary contract test with an explicit low-level allowlist

Current status by phase:

- Phase 1: materially implemented
- Phase 2: materially implemented
- Phase 3: materially implemented
- Phase 4: materially implemented
- Phase 5: materially implemented

## What Is Already Correct

### 1. Contract-first execution is the right model

The lifecycle described in [contract-lifecycle.md](/Users/famao/kyberion/knowledge/public/architecture/contract-lifecycle.md) is correct:

`conversation -> semantic brief -> draft contract -> preflight -> committed executable contract -> execution -> evidence`

This is the right answer to the earlier "raw ADF too early" failure mode.

### 2. Mission authority is properly separated

[mission-orchestration-control-plane.md](/Users/famao/kyberion/knowledge/public/architecture/mission-orchestration-control-plane.md) keeps mission state deterministic and outside ad hoc agent mutation.

That separation should be preserved.

### 3. Analysis and review are modeled as governed execution, not freeform chat

[analysis-execution-boundary.md](/Users/famao/kyberion/knowledge/public/architecture/analysis-execution-boundary.md) is conceptually strong.

It correctly separates:

- LLM phrasing
- knowledge-owned process
- compiler-owned binding
- executor-owned persistence

### 4. Harness evolution is now conceptually aligned

[benchmark-driven-harness-evolution.md](/Users/famao/kyberion/knowledge/public/architecture/benchmark-driven-harness-evolution.md) correctly adapts the useful part of `autoagent` into Kyberion's worldview.

The key point is correct:

- improvement loops should be governed experiments
- not informal prompt hacking or uncontrolled harness edits

## Confirmed Gaps

### Gap 1. Secure-IO enforcement is improving, but repository-wide policy enforcement is not yet complete

The repository rule says direct `node:fs` is prohibited in normal operation:

- [AGENTS.md](/Users/famao/kyberion/AGENTS.md)

This pass removed known production bypasses from `media-actuator` and added a boundary test:

- [libs/actuators/media-actuator/src/index.ts](/Users/famao/kyberion/libs/actuators/media-actuator/src/index.ts)
- [libs/actuators/media-actuator/src/artisan/extraction-engine.ts](/Users/famao/kyberion/libs/actuators/media-actuator/src/artisan/extraction-engine.ts)
- [libs/actuators/media-actuator/src/security-boundary.test.ts](/Users/famao/kyberion/libs/actuators/media-actuator/src/security-boundary.test.ts)

The remaining gap is repository-wide enforcement.

Kyberion still needs:

- an explicit sanctioned low-level boundary for native engines
- a repo-wide contract test or scanner, not just actuator-local coverage
- a policy that distinguishes allowed engine internals from forbidden actuator drift

### Gap 2. Intent routing is now catalog-first across task-session, browser-session, and direct-reply surfaces

The intended design is documented here:

- [intent-classifier-routing.md](/Users/famao/kyberion/knowledge/public/architecture/intent-classifier-routing.md)

This pass introduced:

- [knowledge/public/schemas/intent-resolution-packet.schema.json](/Users/famao/kyberion/knowledge/public/schemas/intent-resolution-packet.schema.json)
- [libs/core/intent-resolution.ts](/Users/famao/kyberion/libs/core/intent-resolution.ts)
- [libs/core/task-session.ts](/Users/famao/kyberion/libs/core/task-session.ts)

That now covers:

- `task_session`
- `project_bootstrap`
- `browser_session`
- `direct_reply`

The remaining extension is optional, not blocking:

- an LLM rerank stage could be added later, but the shared packet contract and routing spine are now in place

### Gap 3. Knowledge-owned work design is mostly in place, but not all policy has been externalized

`work-design.ts` already reads knowledge catalogs, which is the right direction:

- [libs/core/work-design.ts](/Users/famao/kyberion/libs/core/work-design.ts#L153)

This pass moved those semantics into knowledge catalogs:

- [knowledge/public/governance/execution-boundary-profiles.json](/Users/famao/kyberion/knowledge/public/governance/execution-boundary-profiles.json)
- [knowledge/public/governance/runtime-design-profiles.json](/Users/famao/kyberion/knowledge/public/governance/runtime-design-profiles.json)
- [knowledge/public/governance/work-policy.json](/Users/famaoai/k/d/kyberion/knowledge/public/governance/work-policy.json)
- [libs/core/work-design.ts](/Users/famao/kyberion/libs/core/work-design.ts)

The remaining gap is narrower:

- outcome normalization is not fully complete across all media and reply types
- some specialized execution surfaces still have local affordance shaping after shared resolution, which is acceptable as long as intent selection remains centralized

### Gap 4. The repository still reports partial normalization across surface families

The current coverage matrix now accurately narrows the catalog-first gap:

- [knowledge/public/governance/intent-coverage-matrix.json](/Users/famao/kyberion/knowledge/public/governance/intent-coverage-matrix.json)

Current declared gaps include:

- browser and direct reply flows are not yet normalized behind the shared resolver
- outcome normalization is incomplete
- routing taxonomy outside work design is still partly hand-maintained

### Gap 5. Approval semantics are now centralized and knowledge-owned

This pass closed the immediate runtime drift in:

- [libs/core/task-session.ts](/Users/famao/kyberion/libs/core/task-session.ts)
- [libs/core/task-session.test.ts](/Users/famao/kyberion/libs/core/task-session.test.ts)

Approval policy now lives in:

- [knowledge/public/governance/approval-policy.json](/Users/famao/kyberion/knowledge/public/governance/approval-policy.json)
- [libs/core/approval-policy.ts](/Users/famao/kyberion/libs/core/approval-policy.ts)

The remaining work here is additive, not corrective:

- expand policy coverage beyond service mutations as new approval-requiring intents are introduced

## Improvement Plan

## Phase 1. Security Boundary Cleanup

### Goal

Make filesystem, secret, and approval boundaries enforceable in code, not only in documentation.

### Work

1. Introduce an explicit `low_level_io_boundary` policy for native renderers and extraction engines.
2. Remove direct `node:fs` usage from actuators unless it passes through an approved primitive layer.
3. Add a repository contract test:
   - production code may not import `node:fs` except from an allowlisted low-level boundary package
4. Centralize approval derivation so `payload.approval_required` and `control.requires_approval` cannot diverge.

### Done Means

- production actuator code no longer imports raw `node:fs` directly unless it lives inside an explicit reviewed boundary
- approval-required tasks persist approval state from a single source of truth
- CI fails on unauthorized raw fs imports

## Phase 2. Catalog-First Intent Resolution

### Goal

Make `standard-intents.json` the real runtime source of truth for surface work.

### Work

1. Introduce a first-class `intent_resolution_packet` contract.
2. Refactor route-specific classifiers so they emit candidates instead of final decisions.
3. Add an LLM rerank stage with:
   - active surface context
   - current browser/task session context
   - heuristic candidates
   - policy constraints
4. Persist routing traces:
   - utterance
   - candidates
   - rerank result
   - policy result
   - chosen work shape

### Done Means

- browser, direct reply, and task-session routing all pass through the same resolution packet
- LLM rerank is optional but supported
- route-specific regexes become candidate generators, not the canonical resolver

## Phase 3. Knowledge-Owned Work Design

### Goal

Move intent semantics out of TypeScript branching and into knowledge-owned contracts.

### Work

1. Split `work-design.ts` into:
   - generic loader/compiler logic
   - no per-intent hardcoded business semantics
2. Add knowledge catalogs for:
   - execution boundary profiles
   - runtime design profiles
   - specialist fallback rules
   - approval derivation policy
3. Make `buildOrganizationWorkLoopSummary()` compile from those catalogs instead of intent-specific `if` chains.

### Done Means

- adding a new intent rarely requires editing `work-design.ts`
- execution boundary, runtime design, and specialist routing are reviewable as data
- TypeScript becomes compiler logic, not policy storage

## Phase 4. First-Class Experiment and Analysis Contracts

### Goal

Make advanced flows executable as governed contracts instead of "analysis-shaped placeholders".

### Work

1. Introduce executable contracts for:
   - incident-informed review
   - cross-project remediation
   - benchmark-driven harness evolution
2. Add first-class runtime support for:
   - benchmark runner
   - experiment ledger
   - findings contract
   - follow-up seed fan-out
3. Treat keep or discard, review findings, and remediation plans as structured runtime artifacts rather than just prose outputs.

### Done Means

- `partial` entries in the coverage matrix shrink meaningfully
- analysis work is replayable end-to-end
- harness evolution is benchmark-driven in runtime, not only in docs

## Phase 5. Coverage and Drift Automation

### Goal

Prevent the architecture from drifting again after cleanup.

### Work

1. Generate parts of `intent-coverage-matrix.json` from runtime contracts where possible.
2. Add contract tests for every surface intent:
   - sample utterance
   - chosen resolution shape
   - outcome ids
   - approval expectation
3. Add architecture drift tests:
   - knowledge contract exists
   - runtime compiler consumes it
   - unsupported hardcoded fallbacks are flagged

### Done Means

- the coverage matrix is mostly derived, not manually curated
- a new intent cannot be added incompletely without failing CI
- architectural promises stay synchronized with implementation

## Recommended Order

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 5
5. Phase 4

Rationale:

- security and enforcement drift should be fixed before more capability is added
- catalog-first routing is the highest leverage abstraction fix
- analysis and experiment execution should be promoted only after the base resolver and policy layers are stable

## Non-Goals

This plan does not recommend:

- replacing ADF
- collapsing Kyberion into a single-file harness
- removing mission control or actuator boundaries
- making everything LLM-first

Those would weaken the strongest parts of the current design.

## Final Position

Kyberion should continue moving toward this model:

`intent -> knowledge-owned process -> compiler-owned contract -> executor-owned evidence`

The concept is right.

The next step is not rethinking the concept.
The next step is enforcing it consistently across runtime, routing, approval, and low-level I/O boundaries.
