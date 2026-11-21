---
title: AI-Era Requirements Governance Playbook (Opt-In Constraints & Tailoring)
category: Orchestration
tags:
  [
    orchestration,
    requirements,
    alignment,
    hearing,
    uncertainty,
    assurance,
    change-management,
    compliance,
    tailoring,
    opt-in,
  ]
importance: 8
author: Ecosystem Architect
last_updated: 2026-11-21
role_affinity:
  [
    product_manager,
    solution_architect,
    ecosystem_architect,
    pmo_governance,
    qa_lead,
    legal_strategist,
    mission_controller,
  ]
phase_affinity: [alignment, execution, review]
---

# AI-Era Requirements Governance Playbook (Opt-In Constraints & Tailoring)

How Kyberion incorporates practical requirements-management disciplines for AI systems **without slowing down exploratory or lightweight work**. Every practice in this playbook builds on Kyberion's existing [Organization Work Loop](../architecture/organization-work-loop.md) and keeps all newly added checks **advisory by default** unless a tenant, organization, project, workflow policy, or charter explicitly opts into strict enforcement.

## 1. Opt-In Constraint & Tailoring Model

Do not bolt heavyweight specification gates onto every request.

| Posture                | When it applies                                                                                                          | Enforcement behavior                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Advisory (default)** | Standard `direct_reply`, `task_session`, `pipeline`, exploratory discovery, and normal missions                          | Prompts and checklists surface missing framing, uncertainty, or change-reason notes without blocking execution                                                  |
| **Opt-in enforced**    | Explicitly enabled by tenant scope policy, organization/project settings, workflow gate, or regulated validation charter | Blocking preflight/review check requires the declared fields (e.g., uncertainty matrix, assurance summary, 3-layer legal mapping) before execution or promotion |

- **Non-interference**: Opt-in rules in this playbook never supersede [`work-scope-policy.json`](../governance/work-scope-policy.json) shape selection or relax existing hard floors (such as `on_degraded: fail` in pipelines or [Accountability Charter](../governance/ai-use-charter-operations.md) boundaries).
- **Single Ledger as SSoT (no double maintenance)**: Treat live governed records (Decision Ledger, `WorkItem`, `mission-state.json`, `audit-chain`, and versioned `knowledge/` files) as canonical sources. Written requirement documents or summaries should be rendered as views over those records rather than maintained as duplicate copies.

## 2. Three-Layer Framing, Simplifying Given Conditions, and Weak Signals

Before writing contracts or prompting an agent to build automation:

1. **Separate three layers of intent**:
   - **Needs**: Raw stakeholder wishes, pain points, and contextual background captured in hearings or discovery.
   - **Stakeholder Requirements**: Clarified business/operational expectations and constraints agreed with the requestor.
   - **System Requirements / Victory Conditions**: Verifiable technical/behavioral acceptance criteria attached to an Outcome or mission contract.
2. **Simplify given conditions before AI-enabling**: Question legacy approval steps, handoffs, and procedural habits first. Never automate a wasteful process as-is when simplifying the condition solves the root issue.
3. **Preserve 1% weak signals alongside majority patterns**: When summarizing customer interviews, hearing metrics, or incidents, do not collapse rare, high-impact exceptions or minority dissatisfaction into majority averages. Record high-severity outliers explicitly alongside count summaries so critical failure modes reach Alignment.

Canonical touchpoints:

- Alignment framing checklist: [alignment.md](../governance/phases/alignment.md)
- Elicitation & intake triage: [question-resolution-playbook.md](./question-resolution-playbook.md)
- Structured customer elicitation: [hearing-model.md](../architecture/hearing-model.md)

## 3. AI Uncertainty & Out-of-Distribution (OOD) Pre-Specification

When a workflow delegates judgment or perception to probabilistic AI models, design the failure and uncertainty behavior up front rather than treating "no exception thrown" as success:

| Uncertainty condition                         | Required behavior options (pick explicitly when opted in)                                                      | Kyberion control surface                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Low confidence**                            | Retry with narrower structured schema, degrade safely with explicit status flag, or escalate to human approval | `llm-invocation-rubric.md` (`options` + fallback / `on_degraded`)          |
| **Out-of-distribution (OOD) / shifted input** | Reject unknown inputs, emit diagnostic warning, and bypass autonomous commit                                   | Preflight schema validation + fail-closed gate                             |
| **Insufficient or conflicting evidence**      | Surface missing facts as `needs_input` / `customer_decisions` instead of synthesizing ungrounded claims        | [question-resolution-playbook.md](./question-resolution-playbook.md)       |
| **High-risk / irreversible domain**           | Hold external side effect and route to named accountable human                                                 | [ai-use-charter-operations.md](../governance/ai-use-charter-operations.md) |

- **Default**: Advisory checklist during pipeline/mission design ([llm-invocation-rubric.md](../governance/llm-invocation-rubric.md)).
- **Opt-in strict**: High-stakes or external-facing workflows may declare an explicit uncertainty behavior matrix as a pre-execution gate requirement.

## 4. Continuous Assurance Case & Re-Evaluation Triggers

For high-trust deployments or third-party validation, structure assurance arguments explicitly so trust does not rely on ad-hoc prose:

- **Four-part Assurance Case structure** (extend [independent-validation-evidence-package.md](../governance/independent-validation-evidence-package.md)):
  - **Claim**: Specific safety, reliability, privacy, or compliance assertion being made.
  - **Argument**: Rationale linking system design, guardrails, and operational assumptions to the claim.
  - **Evidence**: Objective artefacts (`audit-chain`, test/simulation receipts, finite-state checks, review attestations).
  - **Assumptions & validity boundaries**: Conditions under which the claim holds (input domain, volume, model version, human oversight).

- **Standard re-evaluation triggers** (extend [continuous-operations-loop.md](../architecture/continuous-operations-loop.md)):
  1. Model accuracy / Key Result drift across consecutive observations
  2. Input distribution shift or rising OOD / unmapped-input rates
  3. Escalation, complaint, or rework rate exceeding threshold
  4. External regulation, contract, or internal policy revision
  5. Underlying model, prompt template, or core knowledge update
  6. External API, vendor dependency, or SLA change
  7. Audit finding or major operational incident

Re-evaluation triggers are **opt-in automation rules**: tenants enable specific triggers in their organization/continuous-operations config while keeping existing cancellation and lease invariants intact.

## 5. Change-Level Routing & Change Reason Taxonomy

Not every change belongs at the same escalation depth. Classify change requests and retrospective lessons along two orthogonal axes:

- **Routing level**:
  - `L1_goal_purpose` — Changes to business goal, mission scope, or success criteria → halt and return to Alignment / human approval.
  - `L2_requirement_process` — Changes to stakeholder expectations, workflow sequence, or policy bounds → update Decision Ledger and propagate via impact bands ([coherence-driven-change-propagation.md](../architecture/coherence-driven-change-propagation.md)).
  - `L3_implementation_model` — Prompt, code, adapter, or model swap with unchanged requirements → bounded remediation task + regression tests.
- **Root-cause reason taxonomy** (optional tag in Review/Distillation):
  - `environment_change` — External markets, regulations, APIs, or data distributions shifted.
  - `operational_learning` — Validated insights from production metrics or user feedback.
  - `initial_requirement_defect` — Ambiguity, missing edge case, or flawed assumption from initial Alignment/Hearing; route learnings back to strengthen Alignment checklists and hearing templates ([review.md](../governance/phases/review.md)).

## 6. External Requirement 3-Layer Translation & AI-Readable Rule Criteria

When translating laws, contracts, or industry standards into operational behavior:

1. **External Source layer**: Reference the authoritative norm, clause identifier, and effective date — never paste raw statutory prose directly into worker execution prompts.
2. **Organization / Tenant Policy layer**: Translate obligations, prohibitions, exception boundaries, and accountable human roles into tenant-scoped policy.
3. **Verifiable Gate / Acceptance layer**: Express machine-checkable preconditions, schema constraints, charter limits, or test assertions with bidirectional links back to layers 1 and 2.

To stay usable by AI agents without hallucination or drift, internal rules should satisfy five clarity criteria: a single canonical source, consistent glossary terms, explicit cross-links, explicit exception conditions, and explicit applicability boundaries. Role procedure: [legal_strategist/PROCEDURE.md](../roles/legal_strategist/PROCEDURE.md).

## 7. Organizational Maturity Tailoring (Lv.1–Lv.5)

Enable opt-in constraints incrementally based on tenant maturity; as a practical baseline, keep requirements-governance overhead lean (roughly **2–5%** of project effort unless regulatory mandate dictates otherwise).

| Level                 | Profile                                         | Recommended Opt-In Configuration                                                                       |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Lv.1 Ad-hoc**       | Informal prompts & one-off tasks                | Keep all new checks **advisory**; rely on baseline Alignment clarity only                              |
| **Lv.2 Repeatable**   | Core workflows crystallized into pipelines      | Enable 3-layer Needs/Requirements/Victory separation on Solution Projects                              |
| **Lv.3 Defined**      | Standardized org roles & shared templates       | Opt into Decision Ledger SSoT views, Change Reason tags, and OOD/uncertainty tables                    |
| **Lv.4 Quantitative** | Metrics & KR tracking via Continuous Operations | Opt into automated re-evaluation triggers and Assurance Case summaries                                 |
| **Lv.5 Optimizing**   | Cross-tenant learning & strict assurance        | Enforce 3-layer legal traceability, full Assurance Cases, and automated defect feedback into Alignment |

## 8. Implemented Opt-In Runtime Switches

All enforcement upgrades keep legacy behavior unchanged unless explicitly opted in:

- **Alignment strict framing gate**:
  - Brief contract (`knowledge/product/schemas/mission-brief.schema.json`): `requirementsGovernance` (`strictFraming`, `changeLevelRouting`, `requireUncertaintyFallback`, `assumptions`, `maturityLevel`).
  - CLI / assessor flags: `mission_alignment_request.ts --strict-framing` and `mission_alignment_decision.ts --strict-framing` (or `requirementsGovernance.strictFraming: true` on the brief). Rejects requests missing `intent`, `victoryConditions`, `scope.in`, `scope.out`, `deliverables`, or `assumptions_or_risks`, and emits verdict `brief_incomplete` if checked at decision time.
- **Change-level review re-entry routing (L1 / L2 / L3)**:
  - Opt-in triggers (`libs/core/mission/mission-reentry-routing.ts`): `MissionState.context.requirements_change_level_routing: true` or `MissionBrief.requirementsGovernance.changeLevelRouting: true`.
  - Category mapping (`classifyReviewReentryChangeLevel` in `libs/core/workforce/review-reentry.ts`): `wrong_direction` → `L1_goal_purpose` (sets `status: 'paused'`, `alignment_reapproval_required: true`, and dispatches `product_strategist` re-alignment + `reviewer` without premature `implementer` work); `scope` → `L2_requirement_process` (`product_strategist` spec → dependent `implementer` → `reviewer`); `incorrect_content` / `quality` / `other` → `L3_implementation_model` (bounded `implementer` fix + regression tests → `reviewer`).
- **ADF uncertainty fallback guardrail**:
  - Policy (`knowledge/product/governance/adf-execution-policy.json`): `uncertainty.require_llm_decide_fallback` (default `false`) or per-call `AdfGuardrailOptions.strictUncertaintyContract: true` (`libs/core/pipeline/adf-guardrails.ts`), promoting `llm-decide-without-fallback` on generation-mode `llm_decide` without `on_degraded` from `warn` to blocking `error` so `runAdfLifecycle` triggers `autoRepair`.
- **Worker compact prompt principles**:
  - `CORE_WORKING_PRINCIPLES[0]` (always included in compact mode) instructs workers to stop guessing and escalate out-of-distribution/conflicting premises in `gaps`/`needs` or `customer_decisions`; `ROLE_WORKING_PRINCIPLES.product_strategist` (`planner` alias included) enforces Who/Objective/In-Out Scope/Success Criteria/Assumptions framing prior to task split.

## 9. External Reference & Related Kyberion Docs

- **External design reference**: Information-technology Promotion Agency, Japan (IPA), Digital & AI Systems Design Center (DADC), _AI-Era Requirements Management Handbook_ (Version 1.0.0, October 2026) — concepts synthesized into Kyberion's governance model with no verbatim text or table reproduction.
- **Related Kyberion docs**:
  - [Phase Protocol: Alignment](../governance/phases/alignment.md)
  - [Phase Protocol: Review & Distillation](../governance/phases/review.md)
  - [Question Resolution Playbook](./question-resolution-playbook.md)
  - [Hearing Model](../architecture/hearing-model.md)
  - [LLM Invocation Rubric](../governance/llm-invocation-rubric.md)
  - [AI Use Charter Operations](../governance/ai-use-charter-operations.md)
  - [Independent Validation Evidence Package](../governance/independent-validation-evidence-package.md)
  - [Continuous Operations Loop](../architecture/continuous-operations-loop.md)
  - [Coherence-Driven Change Propagation](../architecture/coherence-driven-change-propagation.md)
  - [Legal Strategist Procedure](../roles/legal_strategist/PROCEDURE.md)
  - [Organization Operations Runbook](../governance/organization-operations-runbook.md)
  - [Organization Discovery](./organization-discovery.md)
