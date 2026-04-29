---
title: Model and Harness Adaptation Phase
category: Architecture
tags: [llm, model-upgrade, harness, cli, optimization, governance, planning]
importance: 9
author: Ecosystem Architect
last_updated: 2026-04-18
---

# Model and Harness Adaptation Phase

## Executive Verdict

Yes.

Kyberion should have an explicit phase for adapting itself when the underlying LLM changes and when the surrounding execution harness changes.
That means:

- the underlying model
- the CLI's built-in skills and plugins
- native sub-agent behavior
- browser and computer-use facilities
- runtime tool contracts exposed by the host environment

This phase should not be treated as ad hoc prompt tuning, and it should not be folded into normal mission execution.

It should be a governed platform-level cycle with a clear trigger, explicit evaluation artifacts, promotion gates, and rollback rules.

The reason is simple:

- model updates change instruction-following behavior
- model updates change contract fidelity and JSON stability
- model updates change risk posture around overreach, refusals, and tool eagerness
- model updates change latency and cost, which affects routing and UX assumptions
- model updates can invalidate parts of Kyberion's concept surface even when the code still "works"
- CLI harness updates change what should be implemented in Kyberion versus delegated to the host environment
- new native browser or computer-use features can make older Kyberion-local implementations conceptually obsolete
- skill, plugin, and agent-harness evolution can change the best boundary between reasoning, execution, and governance

If Kyberion does not treat model and harness change as a first-class adaptation event, the system will slowly accumulate:

- drift between concept and actual model behavior
- hidden regressions in contract generation
- route-specific prompt hacks
- growing inconsistency across surfaces
- duplicated capability stacks between Kyberion and the CLI host
- unclear ownership between native harness tools and Kyberion actuators

So the correct answer is:

- keep the core concept stable
- make model-specific and harness-specific optimization an explicit governed phase
- treat concept changes as evidence-driven architecture updates, not instinctive rewrites

## Design Principle

Kyberion should optimize to a changing model and harness in this order:

1. preserve the concept if the concept is still sound
2. adjust policy, prompts, and compiler boundaries before changing user-facing concepts
3. change concepts only when repeated evidence shows the current abstraction is no longer the best fit
4. prefer host-native capability when the host now provides a stronger primitive than Kyberion-local duplication

That means the goal is not "follow the newest model".
The goal is:

- preserve Kyberion's governance model
- exploit real model improvements
- exploit real CLI and harness improvements
- isolate model regressions early
- isolate harness regressions and overlap early
- evolve the concept map only where the model makes a better operating abstraction possible

## Cooperation Principle

Kyberion should not try to win by owning every low-level capability itself.

As the CLI host evolves, the likely best split is:

- host CLI and harness own:
  - native model access
  - low-level tool invocation
  - skills, plugins, and delegated agents
  - interactive browser and computer-use loops
  - terminal and session primitives
- Kyberion owns:
  - intent normalization
  - authority, approval, and policy
  - governed contracts
  - routing and escalation decisions
  - observability, evidence, and memory
  - promotion and rollback discipline

So the adaptation problem is not only:

- "which model should Kyberion use"

It is also:

- "which capabilities should Kyberion still implement directly"
- "which capabilities should be treated as governed host primitives"
- "how should Kyberion route between deterministic actuators and host-native interactive loops"

Detailed responsibility split and capability-boundary guidance are defined in:

- [CLI Harness Coordination Model](./cli-harness-coordination-model.md)
- [Wisdom Policy Adapter Guide](../governance/wisdom-policy-guide.md)

## Position In The Operating Model

This should be a platform lifecycle, not a normal mission lifecycle phase.

Recommended framing:

- normal mission lifecycle:
  - onboarding
  - recovery
  - alignment
  - execution
  - review
- platform adaptation lifecycle:
  - detect
  - profile
  - evaluate
  - adapt
  - shadow
  - promote or rollback

This separation matters because mission phases deliver work for a user request.
Model and harness adaptation changes Kyberion itself.

## Trigger Conditions

Start a Model and Harness Adaptation Phase when any of the following happens:

- the default model is upgraded
- a provider changes a flagship model's behavior materially
- cost or latency shifts enough to affect routing decisions
- contract validity drops after a dependency or model upgrade
- a new model exposes materially better capabilities for reasoning, tool use, or multilingual handling
- the host CLI adds or changes native browser, computer-use, plugin, skill, or agent orchestration features
- a host-side capability becomes good enough that Kyberion should stop duplicating it locally
- Kyberion-local actuators and host-native tools start to overlap ambiguously

Recommended severity classes:

- `patch`
  - same conceptual family, minor quality or harness shift
- `minor`
  - noticeable behavior change, likely prompt, routing, or adapter impact
- `major`
  - new model family or major harness capability shift, requires full adaptation cycle

When the change is reasoning-only, record the selected profile and adapter in [`wisdom-policy.json`](../governance/wisdom-policy.json) first, then add code only for genuinely new adapters.

## Goals

The phase should answer six questions:

1. What became better?
2. What became worse?
3. Which parts of Kyberion can stay unchanged?
4. Which prompts, contracts, or policies need retuning?
5. Which capabilities should move between Kyberion-local execution and host-native harness execution?
6. Does the concept map itself need any correction?

## Required Outputs

Each cycle should produce governed artifacts:

- `model_profile`
  - structured description of the new model's strengths, weaknesses, costs, latency, and contract behavior
- `harness_profile`
  - structured description of relevant host capabilities, native tools, constraints, and risk posture
- `capability_drift_report`
  - delta from the previous approved model and harness baseline
- `adaptation_plan`
  - the exact changes Kyberion will test
- `shadow_evaluation_report`
  - side-by-side benchmark results before promotion
- `promotion_decision`
  - approved, deferred, or rolled back with rationale
- `integration_decision`
  - whether a capability should stay local, move to host-native execution, or remain dual-path
- `reasoning_policy_profile`
  - the selected wisdom policy profile and adapter used for reasoning tasks

## Proposed Lifecycle

## Phase 1. Detect And Freeze

### Purpose

Create a stable baseline before changing anything.

### Work

- register the new candidate model
- register the relevant candidate harness version or capability set
- freeze the current production baseline
- collect benchmark, latency, cost, and contract-validity baselines
- collect current host-versus-local capability ownership baselines
- classify the upgrade as `patch`, `minor`, or `major`

### Output

- baseline metrics snapshot
- initial drift hypothesis

## Phase 2. Capability Profiling

### Purpose

Understand how the new model and host harness behave in Kyberion's actual control surfaces.

### Evaluation Areas

- intent normalization
- clarification quality
- JSON and schema fidelity
- ADF contract stability
- authority and approval obedience
- multilingual normalization
- tool-use overreach or underreach
- summarization quality for operator packets
- browser and computer-use interaction quality
- plugin and skill invocation quality
- sub-agent coordination quality

### Output

- `model_profile`
- `harness_profile`
- `capability_drift_report`

## Phase 3. Architecture Impact Review

### Purpose

Decide whether the stack only needs prompt and policy retuning, whether adapter boundaries should change, or whether the Kyberion concept surface itself should change.

### Review Questions

- does the model obey stronger structured output contracts than before?
- can more reasoning be safely moved into compiler steps?
- should some human-facing abstractions be simplified because the model now handles normalization better?
- did any previously safe assumptions become unsafe?
- should browser or computer-use execution move from Kyberion-local actuators to host-native harness loops?
- should a capability remain dual-path because deterministic replay and interactive exploration are both needed?

### Decision Buckets

- `no concept change`
  - prompts, thresholds, and routing only
- `concept refinement`
  - preserve the architecture, adjust naming or boundaries
- `concept correction`
  - change a real abstraction because the old one no longer fits
- `boundary reassignment`
  - keep the concept, but move capability ownership between Kyberion and the host harness

## Phase 4. Targeted Adaptation

### Purpose

Implement the minimum set of changes needed to exploit the new model and harness without destabilizing the system.

### Preferred Change Order

1. model and harness registry updates
2. capability routing and adapter config
3. prompt templates and compiler instructions
4. policy thresholds and evaluation gates
5. surface wording and operator packet behavior
6. concept-map or lifecycle changes

### Anti-Pattern

Do not rewrite the concept map first.
Most upgrades should be absorbed by policy, routing, adapter, and compiler layers, not by inventing new top-level concepts.

## Phase 5. Shadow Evaluation

### Purpose

Compare the adapted stack against the production stack before switching.

### Required Shadow Checks

- golden intent scenarios
- malformed or ambiguous requests
- approval-requiring requests
- multilingual requests
- browser and file workflow scenarios
- direct-reply and task-session comparisons
- host-native browser or computer-use comparisons
- Kyberion-local versus host-native path comparisons where dual execution paths exist

### Promotion Gates

The candidate should not be promoted unless it meets or exceeds the current baseline on:

- contract validity
- policy obedience
- clarification precision
- execution-preview usefulness
- major task success rate
- capability handoff correctness

Cost and latency may regress only if the gain is explicitly justified.

## Phase 6. Promote Or Roll Back

### Purpose

Make the model change operational only after the platform evidence is complete.

### Rules

- promotion requires an explicit decision artifact
- rollback path must already exist before promotion
- concept changes should be documented separately from parameter tuning

## Implementation Strategy

The safest implementation is to add a small number of governed building blocks instead of scattering model-specific or harness-specific logic through the codebase.

## 1. Model Registry

Add a governed registry for approved and candidate models.

Suggested artifact:

- `knowledge/public/governance/model-registry.json`

Suggested fields:

- `model_id`
- `provider`
- `family`
- `status`
- `role_fit`
- `cost_band`
- `latency_band`
- `structured_output_confidence`
- `tool_use_confidence`
- `multilingual_confidence`
- `notes`

## 2. Adaptation Policy

Add a policy file that defines when a full adaptation cycle is required and what gates must pass.

Suggested artifact:

- `knowledge/public/governance/model-adaptation-policy.json`

Suggested policy sections:

- trigger thresholds
- required benchmark suites
- promotion gates
- rollback conditions
- severity classification rules

## 3. Harness Capability Registry

Add a governed registry for host-native capabilities that Kyberion may use through adapters.

Suggested artifact:

- `knowledge/public/governance/harness-capability-registry.json`

Suggested fields:

- `capability_id`
- `source`
- `kind`
- `interaction_mode`
- `risk_class`
- `replayability`
- `approval_hooks`
- `preferred_usage`
- `fallback_path`

## 4. Benchmark And Drift Harness

Create a benchmark layer focused on Kyberion-specific behavior rather than generic LLM quality.

Suggested scenario classes:

- intent contract generation
- work-loop generation
- clarification packet generation
- approval obedience
- direct-reply quality
- surface delegation quality
- tool abstention quality

Suggested outputs:

- contract validity rate
- schema error counts
- clarification over-ask and under-ask rates
- inappropriate execution eagerness
- operator packet compression quality
- host-native capability handoff accuracy
- local-versus-host execution deltas

## 5. Adaptation Plan Contract

Introduce a structured adaptation plan that records exactly what will change.

Suggested artifact:

- `knowledge/public/schemas/model-adaptation-plan.schema.json`
- `active/shared/evaluations/model-adaptation/<run-id>/plan.json`

Suggested sections:

- target model
- baseline model
- observed drift
- proposed changes
- affected surfaces
- affected compiler prompts
- affected policies
- affected harness adapters
- capability ownership changes
- acceptance criteria

## 6. Shadow Evaluation Runs

Persist each adaptation cycle as a governed run.

Suggested path:

- `active/shared/evaluations/model-adaptation/<run-id>/`

Suggested contents:

- `baseline-summary.json`
- `candidate-summary.json`
- `diff-report.json`
- `promotion-decision.json`
- `integration-decision.json`

## 7. Concept Review Gate

Do not let concept changes sneak in through prompt edits.

If the adaptation plan changes:

- user-facing concepts
- lifecycle structure
- authority boundaries
- LLM versus Actuator responsibilities
- host harness versus Kyberion responsibilities

then require an explicit architecture review and a linked concept update document.

## Task Plan

## Track A. Governance And Contracts

- define `model-registry.json`
- define `model-adaptation-policy.json`
- define `harness-capability-registry.json`
- define `model-adaptation-plan.schema.json`
- define `model-profile.schema.json`
- define `capability-drift-report.schema.json`
- define `harness-profile.schema.json`
- define `integration-decision.schema.json`

## Track B. Benchmark Infrastructure

- create a Kyberion model-and-harness benchmark suite
- split scenarios into golden, ambiguous, adversarial, and approval-sensitive sets
- add scoring for schema validity, clarification precision, and policy obedience
- add scoring for host-native handoff correctness and local-versus-host parity
- persist benchmark outputs into governed evaluation directories

## Track C. Runtime Integration

- make default model selection come from the model registry
- allow candidate models to run in shadow mode without becoming default
- record model identity in intent-compiler and surface-runtime traces
- record harness capability identity in traces when host-native tools are used
- expose model version in operator-visible diagnostics where useful

## Track D. Harness And Capability Routing

- add governed routing rules for local versus host-native execution
- define when browser and computer-use should prefer host-native interactive loops
- define when deterministic Kyberion actuators should remain preferred
- support dual-path execution where exploration and replayability both matter
- prevent hidden capability overlap between plugins, skills, agents, and actuators

## Track E. Prompt And Compiler Tuning

- separate stable prompts from model-family-specific overlays
- add model-family tuning slots for intent compiler, work-loop compiler, and operator packet generation
- keep prompt changes diffable and benchmarkable
- prohibit route-specific hidden prompt drift

## Track F. Concept And UX Review

- review whether the top-level Kyberion concepts still match actual model behavior
- review whether Kyberion's concepts still match the host CLI's native capability model
- update concept-map docs only when repeated benchmark evidence supports it
- document any concept correction separately from prompt tuning
- ensure user-facing simplification still holds after model change

## Track G. Release And Operations

- define promotion and rollback SOP for model and harness upgrades
- require explicit promotion decision artifacts
- add post-promotion monitoring for 7-day drift detection
- add automatic regression alerts for contract-validity drops
- add automatic alerts for host-native capability regressions that should fall back to Kyberion-local execution

## Done Means

This phase is implemented when:

- model and harness upgrades are registered instead of handled informally
- Kyberion can compare baseline and candidate models and harnesses on governed benchmark suites
- platform maintainers can tell whether a change needs prompt tuning, policy tuning, adapter tuning, or concept change
- concept changes require explicit architecture review
- promotion and rollback of model and harness changes are reproducible and auditable

## Recommended First Iteration

The first iteration should stay narrow.

Implement in this order:

1. model registry
2. harness capability registry
3. adaptation policy
4. benchmark suite for intent contract, work loop, approval obedience, and local-versus-host capability routing
5. shadow evaluation storage
6. promotion and integration decision artifacts

Only after that should Kyberion add automatic prompt overlays, capability auto-routing, or broader concept review automation.

That keeps the first version operationally useful without pretending the whole adaptation loop is already autonomous.
