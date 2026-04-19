---
title: Studio Agent Orchestration Absorption Plan
category: Architecture
tags: [agents, orchestration, workflow, governance, planning]
importance: 8
author: Ecosystem Architect
last_updated: 2026-04-19
---

# Studio Agent Orchestration Absorption Plan

## Executive Verdict

Yes.

`Claude-Code-Game-Studios` contains concepts worth absorbing into Kyberion, but not as a game-studio clone.
The reusable value is its operating pattern:

- classify project shape before assigning work
- define a small agent hierarchy with explicit delegation rights
- model multi-agent collaboration as named workflow patterns
- route complex work through reusable review gates
- enforce domain boundaries with path and hook policies

Kyberion should absorb those ideas as a general `mission orchestration layer`.

The correct target is:

- not `game studio simulation`
- not `many agents for their own sake`
- but `goal-shaped multi-agent coordination with explicit governance`

## Implementation Status (2026-04-19)

Implemented foundation:

- mission classification and stage detection (`mission-classification-policy`)
- role registry with delegation contracts (`authority-role-index`, `team-role-index`)
- mission workflow catalog and review gate registry
- path-scope preflight enforcement for delegated tasks
- scenario-pack evaluator for orchestration regressions
- request-driven team composition brief (`composeMissionTeamBrief`) to convert user goals into:
  - mission classification
  - workflow design
  - review design
  - team plan
  - missing input diagnostics

Remaining optimization tasks:

- bind `composeMissionTeamBrief` to all surfaces (Slack, Chronos, CLI chat) as a first-pass intake response
- persist team-composition briefs as mission evidence artifacts for audit and replay
- add approval checkpoints for high-stakes auto-team-expansion before runtime prewarm

## Source Reviewed

Analyzed from the cloned repository `active/shared/tmp/Claude-Code-Game-Studios` on 2026-04-19.

Primary source files reviewed:

- `README.md`
- `.claude/docs/agent-coordination-map.md`
- `.claude/docs/coordination-rules.md`
- `.claude/docs/workflow-catalog.yaml`
- `.claude/docs/agent-roster.md`
- `.claude/docs/director-gates.md`
- `.claude/docs/hooks-reference.md`
- `.claude/docs/rules-reference.md`
- `docs/COLLABORATIVE-DESIGN-PRINCIPLE.md`

## What Is Worth Absorbing

## 1. Project Classification Before Execution

The source project does not treat all work as the same.
It classifies work by lifecycle stage and uses artifact checks to determine what should happen next.

Reusable idea:

- maintain a `project or mission stage detector`
- decide the next best workflow from observable artifacts, not only from chat context
- make readiness explicit instead of relying on implicit operator memory

Kyberion absorption:

- classify missions by `mission class`, `delivery mode`, `risk`, and `current stage`
- use artifacts, contracts, and evidence receipts to detect stage transitions

## 2. Agent Hierarchy With Explicit Delegation

The strongest pattern in the source project is not the large number of agents.
It is the fact that delegation rights are explicit.

Reusable idea:

- leadership layer sets direction and resolves cross-domain conflicts
- domain leads own planning and decomposition inside a domain
- specialists execute bounded work
- escalation always follows a defined parent path

Kyberion absorption:

- define a compact three-layer model:
  - `mission owner`
  - `domain lead`
  - `specialist executor`
- every spawned agent must declare:
  - owned scope
  - allowed delegation targets
  - escalation parent
  - writable domains

## 3. Workflow Catalog As A First-Class Artifact

The source project uses a workflow catalog that maps lifecycle phases to concrete steps, commands, and artifacts.

Reusable idea:

- workflows should be machine-readable
- stage progression should reference required and optional artifacts
- the system should know what "next" means for a project shape

Kyberion absorption:

- create a `mission workflow catalog`
- map `intent archetype -> mission class -> workflow template`
- let the planner choose from named workflows instead of improvising every time

## 4. Review Gates As Reusable Governance Units

The director-gate model is strong because it decouples review logic from individual workflows.

Reusable idea:

- keep reusable gate definitions outside one-off skills
- allow different review intensity modes
- standardize verdicts such as `ready`, `concerns`, `blocked`

Kyberion absorption:

- create reusable `governance gates` for architecture, policy, quality, security, and release
- let workflows invoke gates by identifier
- record gate results in execution receipts and mission state

## 5. Domain Boundaries And Change Propagation

The source project explicitly forbids unilateral cross-domain changes and defines how design changes propagate.

Reusable idea:

- agents should not mutate outside their domain without explicit delegation
- cross-domain changes need a coordinator
- conflict resolution should be structural, not conversational

Kyberion absorption:

- keep `one owner per mission`
- introduce `change propagation contracts` for cross-domain impact
- require dependent workstreams to acknowledge upstream changes before execution proceeds

## 6. Hooks And Path-Scoped Rules

The hook and rule model is valuable because it makes governance operational rather than aspirational.

Reusable idea:

- session hooks restore context and detect missing setup
- pre-tool hooks validate risky operations
- path-scoped rules enforce local standards without re-explaining them every time

Kyberion absorption:

- expand mission/session hooks around:
  - recovery
  - artifact validation
  - policy checks
  - audit logging
- compile path policies from knowledge-owned governance files into runtime enforcement

## 7. Collaborative, Not Fully Autonomous, Operating Posture

The source project is explicit that the user remains the final decision maker.

Reusable idea:

- separate recommendation from commitment
- require a visible draft before important writes or escalations
- keep approval state explicit

Kyberion absorption:

- preserve `intent -> draft contract -> preflight -> executable contract -> execution`
- strengthen operator-facing receipts so the user can see:
  - interpreted goal
  - selected workflow
  - blocked prerequisites
  - pending approvals

## 8. Specialist Overlays Instead Of Flat Agent Sprawl

The engine-specific specialists are useful conceptually because they act as overlays on top of a stable base hierarchy.

Reusable idea:

- keep a stable core roster
- add context-specific specialist overlays only when the project shape requires them

Kyberion absorption:

- define specialist overlays for:
  - `frontend experience`
  - `backend services`
  - `data and analytics`
  - `media and voice`
  - `browser and computer use`
  - `security and compliance`
  - `deployment and operations`

## What Should Not Be Absorbed Literally

- the large game-specific roster size
- game-production phase names such as `concept`, `pre-production`, `polish`
- engine-specific command vocabulary
- roles that only make sense for shipped games, such as live-ops or narrative leadership, as universal defaults

Kyberion should absorb the pattern, not the skin.

## Kyberion Reinterpretation

## 1. Canonical Project Classification

Kyberion should classify missions along four axes.

### Mission Class

- `product_delivery`
- `code_change`
- `research_and_absorption`
- `content_and_media`
- `operations_and_release`
- `environment_and_recovery`

### Delivery Shape

- `single_artifact`
- `multi_artifact_pipeline`
- `long_running_job`
- `interactive_exploration`
- `cross_system_change`

### Risk Profile

- `low`
- `review_required`
- `approval_required`
- `high_stakes`

### Stage

- `intake`
- `classification`
- `planning`
- `contract_authoring`
- `preflight`
- `execution`
- `verification`
- `delivery`
- `retrospective`

## 2. Canonical Agent Roles

Kyberion should keep the roster smaller and more general than the source project.

### Tier A: Mission Control

- `mission-owner`
  - owns end-to-end objective
  - chooses workflow
  - owns final integration
- `review-authority`
  - architecture, security, governance, release, or quality gate authority

### Tier B: Domain Leads

- `product-lead`
- `implementation-lead`
- `media-lead`
- `operations-lead`
- `research-lead`

These agents decompose work and coordinate specialists inside one domain.

### Tier C: Specialists

- `code-specialist`
- `ui-specialist`
- `content-specialist`
- `voice-specialist`
- `video-specialist`
- `browser-specialist`
- `computer-use-specialist`
- `security-specialist`
- `qa-specialist`
- `release-specialist`

### Tier D: Utility Workers

- `read-only analyzer`
- `schema validator`
- `artifact formatter`
- `diff reviewer`

These should be cheap, bounded, and disposable.

## 3. Delegation Rules To Implement

- mission owner delegates only bounded scopes
- domain leads may delegate within their domain
- specialists do not create cross-domain plans
- cross-domain conflicts escalate to mission owner
- governance conflicts escalate to review authority
- no agent writes outside its declared writable scope
- every delegated task must declare expected artifact output

## 4. Workflow Families To Implement

### A. Single-Track Execution

For small tasks with one output and no meaningful parallelism.

Example:

- one code fix
- one document update
- one schema addition

### B. Coordinated Multi-Track Execution

For work requiring multiple domains with a single integration owner.

Example:

- voice plus video delivery
- frontend plus backend feature
- research plus implementation plus verification

### C. Stage-Gated Delivery

For high-risk work where each stage requires validation before progression.

Example:

- architecture refactor
- release workflow
- security-sensitive change

### D. Exploratory To Deterministic Conversion

For work that begins with browsing, discovery, or experimentation and ends in repeatable contracts.

Example:

- browser exploration followed by governed artifact extraction
- research absorption followed by implementation plan generation

## 5. Gate Library To Implement

Kyberion should externalize gate definitions into a reusable library.

Initial gates:

- `ARCHITECTURE_READY`
- `SECURITY_READY`
- `CONTRACT_VALID`
- `QA_READY`
- `RELEASE_READY`
- `ABSORPTION_READY`

Standard verdicts:

- `ready`
- `concerns`
- `blocked`

Standard outputs:

- verdict
- blocking reasons
- revisions required
- evidence reviewed

## 6. Hook And Rule Model To Implement

### Hooks

- session start recovery check
- mission resume check
- pre-execution contract validation
- post-execution evidence capture
- pre-commit governance validation
- post-merge retrospective hint extraction

### Path-Scoped Policies

- architecture docs
- schemas and contracts
- actuator runtime code
- mission state and evidence
- knowledge tier boundaries
- generated media artifacts

## Concrete Absorption Deliverables

## 1. Registry Artifacts

Create:

- `knowledge/public/governance/mission-classification-policy.json`
- `knowledge/public/governance/agent-role-registry.json`
- `knowledge/public/governance/workflow-catalog.json`
- `knowledge/public/governance/review-gate-registry.json`
- `knowledge/public/governance/path-scope-policy.json`

## 2. Schemas

Create:

- `knowledge/public/schemas/mission-classification.schema.json`
- `knowledge/public/schemas/agent-role-contract.schema.json`
- `knowledge/public/schemas/workflow-template.schema.json`
- `knowledge/public/schemas/review-gate-result.schema.json`
- `knowledge/public/schemas/change-propagation-contract.schema.json`

## 3. Runtime And Planner Surfaces

Implement:

- mission stage detector
- role-aware planner
- workflow selector
- gate executor
- change propagation tracker
- path-scope enforcement bridge

## Phased Implementation Plan

## Phase 1: Mission Classification And Stage Detection

Goal:

- let Kyberion infer what kind of project it is handling and what stage it is in

Tasks:

- define mission classes and stages
- implement artifact-based stage detection
- add classification receipt fields to operator-visible outputs
- add regression fixtures for terse Japanese operator requests and cross-system work

Exit criteria:

- planner can explain selected mission class and current stage
- stage detection is based on contracts and artifacts, not only prompt text

## Phase 2: Agent Role Registry And Delegation Contracts

Goal:

- make agent collaboration explicit and governable

Tasks:

- define a compact Kyberion role roster
- create delegation and escalation metadata per role
- add writable-scope declarations
- require every delegated task to declare owner, scope, and expected deliverable

Exit criteria:

- spawned agent tasks include role contract metadata
- cross-domain writes without ownership are blocked

## Phase 3: Workflow Catalog And Named Orchestration Patterns

Goal:

- replace improvised multi-agent behavior with named, reusable workflow templates

Tasks:

- author workflow templates for:
  - single-track execution
  - coordinated multi-track execution
  - stage-gated delivery
  - exploratory to deterministic conversion
- add workflow selection logic to the planner
- record workflow identity in execution receipts

Exit criteria:

- the planner can say which workflow it selected and why
- repeated tasks follow the same orchestration path

## Phase 4: Review Gates And Review Modes

Goal:

- decouple review logic from individual workflows

Tasks:

- implement reusable gates and verdict schema
- add review modes such as `lean`, `standard`, and `strict`
- connect gates to architecture, security, QA, and release workflows
- persist gate outcomes into mission state

Exit criteria:

- high-risk workflows can run with staged reviews
- gate outcomes are visible, auditable, and reusable

## Phase 5: Hook And Path-Policy Enforcement

Goal:

- operationalize governance so it runs automatically at the right moments

Tasks:

- bind session and mission hooks to recovery, preflight, and evidence steps
- compile path policies into runtime checks
- add change propagation rules for cross-domain edits
- log delegated-agent lifecycle events

Exit criteria:

- risky transitions trigger hooks automatically
- path and ownership violations are blocked before execution

## Phase 6: Golden Scenario Packs And Evaluation

Goal:

- prove that the orchestration model improves outcomes rather than adding ceremony

Tasks:

- build scenario packs for:
  - code change with review
  - research absorption to implementation plan
  - voice plus video coordinated delivery
  - release and merge workflow
- compare baseline versus orchestrated runs on:
  - clarification count
  - contract validity
  - policy violations
  - completion rate
  - operator correction rate

Exit criteria:

- orchestrated mode reduces rework or policy failures on multi-domain tasks
- complexity remains bounded for simple tasks

## Design Constraints

- simple tasks must still execute simply
- the workflow catalog must guide, not imprison, the operator
- role count must stay intentionally small
- governance artifacts must remain human-readable
- host CLI capabilities remain harnesses, not sovereign decision makers

## Recommended Initial Scope

Do not implement the full vision in one pass.
The first useful slice is:

1. mission classification
2. role registry
3. two workflow templates
4. one reusable review-gate contract
5. path ownership enforcement for delegated tasks

That is enough to improve multi-agent coordination without creating a bureaucratic shell.

## Success Metrics

- fewer ambiguous delegations
- fewer cross-domain write collisions
- fewer repeated clarification loops on known workflow shapes
- more consistent end-to-end execution receipts
- improved completion rate for multi-step, multi-domain requests

## Final Recommendation

Kyberion should absorb the source project's coordination logic as a generalized mission operating system:

- classify the work
- assign the right hierarchy
- run a named workflow
- gate the risky transitions
- preserve explicit ownership and evidence

That is the durable value.
The rest is theme.
