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

### Mission Team Orchestration

- add mission classification so Kyberion can detect project shape and current stage from artifacts and contracts
- define a compact role registry with explicit delegation rights, writable scopes, and escalation parents
- publish a workflow catalog for multi-agent patterns instead of improvising cross-domain coordination on each run
- externalize reusable review gates and record their verdicts in mission state and execution receipts
- compile hook and path-scope governance into runtime enforcement for delegated work

### Capability Admission Discipline

- require every new skill, plugin, agent, browser path, or computer-use path to declare why it exists, when it is preferred, and what replaces it if removed
- reject host-native integrations that do not expose approval hooks, evidence shape, and fallback behavior
- measure complexity directly through clarification count, contract size, routing branch count, and concept count

### Security And Maintainability Review (2026-04-18)

- tighten permissive read-only auto-approval matching to avoid keyword false positives in tool titles
- enforce additive enhancer option merge so one enhancer cannot silently drop prior execution options
- avoid full prompt logging in adapter runtime logs; keep short summaries to reduce accidental sensitive context exposure
- keep deterministic wisdom context load order to reduce run-to-run drift and improve reproducibility

### Governed Voice Generation

- add a canonical `voice-generation-adf` instead of relying on ad hoc voice service parameters
- govern voice profiles, chunking defaults, and progress packet behavior through knowledge-owned policy
- keep voice generation as a contract-first actuator/runtime capability, not a studio-shaped product mode
- reuse serial queue, long-text chunking, and artifact lineage patterns for narrated delivery and voice ingress

### Personal Voice Narrated Movie Delivery

- add governed voice-profile registration so `use my voice` can fail clearly or execute honestly instead of silently falling back
- add strict clone-routing policy so personal-voice requests do not downgrade to generic system TTS without explicit approval
- add realtime voice conversation runtime so registered active profiles can be used in governed turn-based dialogue, not only narration
- compile narrated intro movies from design-system and brand inputs rather than hand-authored scene JSON
- replace short synchronous backend waits with an async render producer that can complete long movie jobs reliably
- add one canonical end-to-end scenario covering personal voice registration, narration, storyboard, composition, render, and delivery evidence

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

## Priority 3.5

### Decision-Support Integration

Hardening the decision-support layer (judgment, consensus, rehearsal) so it participates in the same governance infrastructure as other mission classes. Detail tasks and status live in [`docs/archive/CONCEPT_INTEGRATION_BACKLOG.md`](docs/archive/CONCEPT_INTEGRATION_BACKLOG.md) (archived) and [`docs/PRODUCTIZATION_ROADMAP.md`](docs/PRODUCTIZATION_ROADMAP.md) (current).

- Register `decision_support` mission class across classification, workflow catalog, review gates, team roles, scenario pack, and path scope (P1-1..P1-6)
- Generalize `nemawashi-protocol` into `stakeholder-consensus-protocol` with culture variants (P1-2b)
- Add intent-delta instrumentation and `INTENT_DRIFT` review gate so intent loop closure is measurable during execution (P1-7)
- Replace stub decision-ops with host-CLI-delegated reasoning implementations per the CLI harness coordination model (P2-1)
- Wire voice actuator into rehearsal and stakeholder 1-on-1 sessions (P2-2)
- Emit presence/voice hooks that curate the confidential relationship-graph (P2-3)
- Migrate heuristic-entry tier from personal to confidential to keep CEO succession viable (P2-4)
- Close the heuristic feedback loop by correlating captured intuitions with mission outcomes (P2-5)
- Wire `enforceApprovalGate` into risky-op call sites (P2-6)

Reference:

- [Decision-Support Design Rationale](/Users/famao/kyberion/knowledge/public/architecture/decision-support-design-rationale.md)
- [Intent Loop Concept](/Users/famao/kyberion/docs/INTENT_LOOP_CONCEPT.md)

## Priority 4

### Model And Harness Adaptation Governance

- define a governed adaptation cycle for LLM and host CLI harness upgrades
- add model registry, harness capability registry, adaptation policy, and promotion gates
- benchmark candidate models and host-native capabilities on contract validity, policy obedience, clarification quality, and local-versus-host routing quality
- require explicit architecture review before changing Kyberion concepts or capability ownership boundaries

Reference:

- [LLM Execution Boundary](/Users/famao/kyberion/knowledge/public/architecture/llm-execution-boundary.md)
- [Voice Generation Absorption Plan](/Users/famao/kyberion/knowledge/public/architecture/voice-generation-absorption-plan.md)
- [Personal Voice Narrated Video Delivery Plan](/Users/famao/kyberion/knowledge/public/architecture/personal-voice-narrated-video-delivery-plan.md)
- [Model and Harness Adaptation Phase](/Users/famao/kyberion/knowledge/public/architecture/model-adaptation-phase.md)
- [CLI Harness Coordination Model](/Users/famao/kyberion/knowledge/public/architecture/cli-harness-coordination-model.md)
- [Wisdom Policy Adapter Guide](/Users/famao/kyberion/knowledge/public/governance/wisdom-policy-guide.md)
- [Studio Agent Orchestration Absorption Plan](/Users/famao/kyberion/knowledge/public/architecture/studio-agent-orchestration-absorption-plan.md)
