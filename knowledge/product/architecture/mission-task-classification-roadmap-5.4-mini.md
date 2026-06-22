---
title: Mission and Task Classification Improvement Roadmap for GPT-5.4 mini
category: Architecture
tags: [architecture, roadmap, mission, task, intent, classification, gpt-5.4-mini]
importance: 9
author: Ecosystem Architect
last_updated: 2026-06-22
---

# Mission and Task Classification Improvement Roadmap for GPT-5.4 mini

## 1. Purpose

This document converts the current mission/task classification gaps into bounded implementation tasks suitable for GPT-5.4 mini.

The roadmap does not replace [`docs/PRODUCTIZATION_ROADMAP.md`](../../../docs/PRODUCTIZATION_ROADMAP.md). It is an architecture-level implementation plan for making intent resolution answer these questions consistently:

1. Is the request a direct reply, a task session, a pipeline, or a mission?
2. Which of the nine canonical mission classes describes the work?
3. Which workflow, team template, review gates, evidence, and readiness checks follow from that decision?
4. When must an initially small task be promoted to a mission?

Execute one task at a time. Do not combine tasks into one patch. Run the focused verification after every task and stop when it fails.

### 1.1 GPT-5.4 mini execution contract

This roadmap is intentionally shaped so that GPT-5.4 mini can execute it without needing broad architectural improvisation.

- Keep one task per patch.
- Read the current contract, schema, and implementation before editing behavior.
- Prefer pure policy and contract changes before boundary enforcement.
- Do not add new mission classes, workflow families, or execution shapes unless a task explicitly requires it.
- If the correct decision depends on unresolved product judgment, record the question in the roadmap instead of guessing.
- Validate with the smallest focused test set first, then run `pnpm build`.
- Treat `task_session` and `pipeline` as different things: a pipeline is replayable; a task session is resumable; a mission is governed ownership.

### 1.2 Roadmap at a glance

| Phase | Goal | GPT-5.4 mini output shape | Exit signal |
|---|---|---|---|
| Phase A | Align contracts and types | tests, enums, shared execution-shape helpers | One closed vocabulary across TypeScript, schemas, and catalog rules |
| Phase B | Make escalation deterministic | pure policy resolver, advisory work-design, orchestration boundary wiring | Small tasks stay lightweight; qualifying work is promoted consistently |
| Phase C | Cover the full ontology | workflow/team/review catalog coverage, scenario regression fixtures | Every class and execution shape resolves to a valid governed route |
| Phase D | Decide class-count and operator UX | ADR, UX copy, reference-drift checks | The model can explain work boundaries without taxonomy jargon |

## 2. Current-State Review

The architecture already contains the main concepts, but they are not aligned end to end.

| Layer | Current state | Gap |
|---|---|---|
| Canonical classes | The intent catalog and JSON Schemas define nine mission classes | `MissionClass` in TypeScript defines only six |
| Execution shape | The ontology distinguishes `direct_reply`, `task_session`, `mission`, `project_bootstrap`, `browser_session`, `pipeline`, and `actuator_action` | Core workflow APIs generally accept only four shapes |
| Classification policy | Rules already emit `decision_support`, `customer_engagement`, and `platform_onboarding` | Runtime typing and default template mapping do not cover them explicitly |
| Team selection | Nine team templates exist | Several mission classes collapse to `development`, obscuring intent |
| Workflow selection | Class-specific templates exist for decision support, customer engagement, and platform onboarding | No single contract proves that every class and execution shape resolves to a valid workflow |
| Review gates | Class-specific gates exist for decision support, customer engagement, platform onboarding, and release work | Coverage is not enforced for every canonical class |
| Task vs mission | The ontology assigns a static execution shape per intent | Request scope, stakeholder count, approvals, repetition, and artifact count do not deterministically promote a task to a mission |
| Knowledge lifecycle | The ontology category exists | There is no dedicated mission class; work falls into `research_and_absorption` or `decision_support` |

This is primarily a contract-alignment problem, not a request to add more top-level classes immediately.

## 3. Target Decision Model

Classification must be two-dimensional. `execution_shape` answers how much governance the work needs; `mission_class` answers what kind of work it is. A task is not a smaller mission class.

### 3.1 Execution boundary

| Result | Use when | Required state | Example |
|---|---|---|---|
| `direct_reply` | No external mutation, no durable continuation, and no approval record is needed | Response only; optional trace | Read today's agenda; explain a concept |
| `actuator_action` / `browser_session` | One bounded tool interaction can complete the request | Execution receipt and applicable consent | Capture one screenshot; inspect one page |
| `task_session` | Bounded multi-step work needs resumable local state, but not mission-wide governance | Task session, receipt, focused verification | Draft a review; prepare schedule options |
| `pipeline` | The same governed sequence should be replayed or produces multiple coordinated artifacts | Validated ADF, evidence bundle | Import a PPTX theme; contract review pipeline |
| `mission` | Governance, coordination, durable ownership, or auditability is load-bearing | Mission record, owner, workflow, gates, evidence | Customer requirements engagement; production release |
| `project_bootstrap` | The request creates a durable project context containing multiple missions | Project record and initial mission plan | Start a governed customer implementation |

### 3.2 Mission promotion rule

Promote work to `mission` when either condition is true:

- Any mandatory trigger is present: external/regulatory evidence, high-stakes action, mission handoff, production release, customer signoff, security-sensitive cross-system change, or the Kyberion dog-food rule.
- At least two accumulation triggers are present: five or more artifacts, likely replay/variant exploration, the same pattern expected five or more times, multiple legitimate viewpoints, multiple stakeholders, approval-required action, cross-system mutation, or work expected to survive the current session.

Do not demote a catalog intent whose minimum execution shape is already `mission`. Promotion is monotonic:

```text
direct_reply -> actuator_action/browser_session -> task_session -> pipeline -> mission -> project_bootstrap
```

`pipeline` and `mission` are not interchangeable. A pipeline describes repeatable execution; a mission describes governed ownership. A mission may execute one or more pipelines.

### 3.3 Canonical class matrix

| Mission class | Typical bounded task | Promote to mission when | Default team direction | Review emphasis |
|---|---|---|---|---|
| `code_change` | One localized implementation and focused test | Cross-package change, release impact, or multiple competing designs | `development` | Contract and QA |
| `product_delivery` | Product brief or one delivery artifact | End-to-end shipment or several delivery tracks | `product_development` | Architecture, QA, artifact bundle |
| `operations_and_release` | Read-only status check or bounded operation | Production mutation, release, long-running operation, or handoff | `operations` | Release and security readiness |
| `customer_engagement` | Prepare options or a follow-up draft | Multiple parties, external commitment, requirements capture, or signoff | `surface_concierge` | Requirements completeness and customer signoff |
| `decision_support` | Explain options or review plain text | Stakeholder alignment, dissent resolution, negotiation, or consequential decision | explicit decision-support template or governed fallback | Alignment, dissent, rehearsal |
| `content_and_media` | Produce one bounded asset | Theme extraction, multi-format generation, brand fidelity, or reusable media pipeline | explicit content/media template or governed fallback | Artifact fidelity and rights |
| `platform_onboarding` | Inspect readiness or prepare setup steps | Secrets, organization policy, integration registration, or cross-system activation | `operations` initially; dedicated template only if evidence warrants | Architecture and security readiness |
| `environment_and_recovery` | Diagnose one local failure | Recovery changes state, resumes durable work, or coordinates several services | `incident` | Recovery evidence and safety |
| `research_and_absorption` | Answer a bounded repository question | Cross-source synthesis, durable knowledge promotion, or multi-view research | `system_query` or `development` by delivery shape | Source quality and tier hygiene |

## 4. Global Constraints for GPT-5.4 mini

Apply these constraints to every implementation task:

- Follow `AGENTS.md`; use `@agent/core/secure-io` for runtime file I/O and never add `node:fs` imports.
- Preserve unrelated worktree changes.
- Treat `knowledge/product/architecture/kyberion-intent-catalog.md` as the canonical human-readable class list.
- Treat governance JSON plus JSON Schema as the machine-readable contract.
- Do not introduce a tenth mission class before Task 9's decision gate.
- Do not infer mission creation from a mission class alone. Use the execution-shape decision.
- Keep policy decisions deterministic. Do not call a live model in unit tests.
- Fail closed when a governance policy or referenced template is invalid.
- Do not add a new actuator for classification work.
- Use one patch per task, with only the files listed in that task unless a repository registration check requires one adjacent catalog update.
- After focused tests pass, run `pnpm build`. Run the full `pnpm run validate` only at the release gate.

## 5. Phase A: Contract Alignment

### Task 1: Add a classification parity contract test

**Objective:** Make drift between the canonical class list, schemas, policy, workflow catalog, review registry, team mapping, and TypeScript visible before changing behavior.

**Files in scope:**

- Add `libs/core/mission-classification-contract.test.ts`
- Modify no production code

**Required assertions:**

- The canonical set contains exactly the current nine classes.
- Both classification schemas expose the same nine values.
- Every `mission_class` emitted by the policy belongs to that set.
- Every class referenced by workflow and review policies belongs to that set.
- Every class can be passed to the TypeScript classification APIs.
- Every mapped team template exists in `knowledge/product/orchestration/mission-team-templates.json`.

**Verification:**

```bash
pnpm exec vitest run libs/core/mission-classification-contract.test.ts
```

**Completion condition:** The test fails only on confirmed current drift and documents each mismatched layer in its assertion message.

### Task 2: Align the TypeScript mission-class contract

**Prerequisite:** Task 1 exists and exposes the current mismatch.

**Objective:** Extend `MissionClass` to all nine canonical values and make template mapping exhaustive.

**Files in scope:**

- Modify `libs/core/mission-classification.ts`
- Modify `libs/core/mission-classification.test.ts`
- Modify `libs/core/mission-classification-contract.test.ts`

**Required behavior:**

- Add `decision_support`, `customer_engagement`, and `platform_onboarding` to `MissionClass`.
- Replace the default fall-through in `mapMissionClassToMissionTypeTemplate()` with an exhaustive mapping record or exhaustive switch.
- Use existing templates initially:
  - `decision_support -> development`
  - `customer_engagement -> surface_concierge`
  - `platform_onboarding -> operations`
  - `content_and_media -> development`
  - `code_change -> development`
- Throw or fail compilation when a future class has no mapping.

**Verification:**

```bash
pnpm exec vitest run libs/core/mission-classification.test.ts libs/core/mission-classification-contract.test.ts
pnpm --filter @agent/core typecheck
pnpm build
```

**Completion condition:** All nine classes compile, classify, and map to an existing team template without a silent fallback.

### Task 3: Normalize execution-shape types

**Objective:** Define one shared execution-shape type and distinguish ontology routing shapes from mission workflow shapes without unsafe string widening.

**Files in scope:**

- Add `libs/core/execution-shape.ts`
- Add `libs/core/execution-shape.test.ts`
- Modify `libs/core/intent-contract.ts`
- Modify `libs/core/work-design.ts`
- Modify `libs/core/mission-workflow-catalog.ts`
- Modify composer input types that currently repeat the four-value union

**Required contract:**

```ts
export type ExecutionShape =
  | 'direct_reply'
  | 'actuator_action'
  | 'browser_session'
  | 'task_session'
  | 'pipeline'
  | 'mission'
  | 'project_bootstrap';
```

Provide a pure normalization function and a workflow projection function. The projection must preserve `pipeline`; it must not silently convert it to `task_session`.

**Verification:**

```bash
pnpm exec vitest run libs/core/execution-shape.test.ts libs/core/intent-contract.test.ts libs/core/work-design.test.ts libs/core/mission-workflow-catalog.test.ts
pnpm --filter @agent/core typecheck
pnpm build
```

**Completion condition:** Core APIs share one closed execution-shape vocabulary and existing routes retain their behavior.

## 6. Phase B: Deterministic Task-to-Mission Escalation

### Task 4: Add a policy-backed work-scope decision

**Objective:** Decide the minimum execution shape and explain why, without creating a mission or executing tools.

**Files in scope:**

- Add `libs/core/work-scope-decision.ts`
- Add `libs/core/work-scope-decision.test.ts`
- Add `knowledge/product/governance/work-scope-policy.json`
- Add `knowledge/product/schemas/work-scope-policy.schema.json`

**Required input signals:**

- Catalog minimum execution shape
- Artifact estimate
- External or regulatory audience
- Replay or variant likelihood
- Repetition estimate
- Multiple legitimate viewpoints
- Stakeholder count
- Approval requirement
- Cross-system mutation
- Expected continuation beyond the current session
- High-stakes or dog-food evidence flag

**Required output:**

```ts
export interface WorkScopeDecision {
  execution_shape: ExecutionShape;
  minimum_catalog_shape: ExecutionShape;
  promotion_required: boolean;
  mandatory_triggers: string[];
  accumulation_triggers: string[];
  matched_rule_ids: string[];
  policy_version: string;
}
```

The resolver must be pure when policy data is injected. Policy loading and schema validation must be separate.

**Required tests:**

- Reading an agenda remains `direct_reply`.
- Preparing schedule options is `task_session`.
- Scheduling across multiple stakeholders with approval becomes `mission`.
- A replayable PPTX theme import remains `pipeline` unless mission triggers are present.
- Customer signoff is a mandatory mission trigger.
- Two accumulation triggers promote to `mission`.
- One accumulation trigger alone does not promote.
- A catalog minimum of `mission` is never demoted.
- Invalid policy is rejected.

**Verification:**

```bash
pnpm exec vitest run libs/core/work-scope-decision.test.ts
pnpm run check:contract-schemas
pnpm run check:governance-rules
pnpm build
```

**Completion condition:** The task/mission boundary is deterministic, policy-backed, and explainable without side effects.

### Task 5: Integrate scope decisions into work design in advisory mode

**Prerequisite:** Task 4 is complete.

**Objective:** Attach the scope decision to work design while preserving existing execution behavior.

**Files in scope:**

- Modify `libs/core/work-design.ts`
- Modify `libs/core/work-design.test.ts`
- Modify the relevant work-design result schema if the result is schema-bound

**Required behavior:**

- Compute `work_scope_decision` after intent resolution.
- Preserve the currently selected execution shape in runtime routing.
- Emit both `selected_execution_shape` and `recommended_execution_shape` when they differ.
- Add a machine-readable mismatch reason.
- Do not create or start a mission in this task.

**Verification:**

```bash
pnpm exec vitest run libs/core/work-design.test.ts libs/core/intent-contract.test.ts
pnpm build
```

**Completion condition:** Real work-design output exposes classification drift without changing user-visible execution.

### Task 6: Enforce promotion at the orchestration boundary

**Prerequisite:** Advisory output has been observed against representative tests and no unexpected mass promotion remains.

**Objective:** Route work through mission creation only when the scope policy requires it.

**Files in scope:**

- Modify `libs/core/surface-runtime-orchestrator.ts`
- Modify `libs/core/surface-runtime-orchestrator.fastpath.test.ts`
- Modify `scripts/mission_controller.ts` only if an existing create/start API cannot accept the resolved contract

**Required behavior:**

- `direct_reply`, bounded actions, and `task_session` keep their existing fast paths.
- `pipeline` remains pipeline execution unless promoted.
- A promotion-required decision returns a governed mission handoff/create request.
- Do not silently start approval-required or high-stakes missions without the existing approval path.
- Persist the policy version and matched trigger IDs in mission evidence or the execution receipt.

**Verification:**

```bash
pnpm exec vitest run libs/core/surface-runtime-orchestrator.fastpath.test.ts libs/core/work-design.test.ts
pnpm run test:core
pnpm build
```

**Completion condition:** Small tasks stay lightweight, while qualifying work cannot bypass mission governance.

## 7. Phase C: Class-Specific Execution Quality

### Task 7: Complete class-to-workflow/team/review coverage

**Objective:** Guarantee a valid execution design for every combination used by the intent ontology.

**Files in scope:**

- Modify `knowledge/product/governance/mission-workflow-catalog.json`
- Modify `knowledge/product/governance/mission-review-gate-registry.json`
- Modify `knowledge/product/orchestration/mission-team-templates.json` only if a dedicated template is justified by missing roles
- Modify the related schemas only when adding a field or enum value
- Modify contract tests from Task 1
- Modify `libs/core/mission-workflow-catalog.test.ts`
- Modify `libs/core/mission-review-gates.test.ts`

**Required behavior:**

- Every ontology entry resolves to an existing workflow and team template.
- Class-specific templates precede broad fallback templates.
- `decision_support`, `customer_engagement`, and `platform_onboarding` retain their existing specialized workflows and gates.
- Add dedicated team templates only if the current role set cannot satisfy the class. Avoid templates that differ only by name.
- No intent resolves to an unknown gate, workflow, or team template.

**Verification:**

```bash
pnpm exec vitest run libs/core/mission-classification-contract.test.ts libs/core/mission-workflow-catalog.test.ts libs/core/mission-review-gates.test.ts
pnpm run check:intent-domain-coverage
pnpm run check:catalogs
pnpm run check:governance-rules
pnpm build
```

**Completion condition:** The ontology can be traversed from intent to class, execution shape, workflow, team, and review design with no unresolved reference.

### Task 8: Add representative end-to-end classification scenarios

**Objective:** Test user language and expected governance outcomes, not only isolated resolver functions.

**Files in scope:**

- Add `knowledge/product/governance/mission-task-classification-scenarios.json`
- Add `knowledge/product/schemas/mission-task-classification-scenarios.schema.json`
- Add `libs/core/mission-task-classification-scenarios.test.ts`
- Modify Japanese contextual intent fixtures only when a scenario exposes an actual resolution gap

**Minimum scenario set:**

- Read today's schedule
- Coordinate one internal appointment
- Coordinate several external stakeholders
- Review plain approval text
- Review a contract file
- Import and register a PPTX theme
- Make one localized code fix
- Deliver a cross-package product feature
- Diagnose a local runtime problem
- Recover and resume a suspended mission
- Query existing knowledge
- Organize and promote reusable knowledge
- Prepare a decision memo
- Run customer requirements elicitation
- Configure an organization integration

Each scenario must declare expected intent, execution shape, mission class, risk profile, workflow, required gates, and whether promotion is expected.

**Verification:**

```bash
pnpm exec vitest run libs/core/mission-task-classification-scenarios.test.ts libs/core/contextual-intent-corpus.test.ts
pnpm run check:intent-domain-coverage
pnpm build
```

**Completion condition:** The table-level design is executable as deterministic regression tests in both Japanese and English examples.

## 8. Phase D: Taxonomy Decision and Operator UX

### Task 9: Decide whether `knowledge_lifecycle` becomes a tenth class

**Objective:** Make the class-count decision from evidence after Tasks 1-8, not from naming preference.

**Files in scope:**

- Add an ADR under `knowledge/product/architecture/decisions/`
- Modify no runtime code in this task

**Decision criteria:**

- At least five distinct knowledge lifecycle intents require a workflow or review design that materially differs from `research_and_absorption` and `decision_support`.
- The distinction changes ownership, evidence, tier controls, or gates; a label-only difference is insufficient.
- Representative scenarios show repeated misclassification or unsafe fallback under the nine-class model.

**Default decision:** Keep nine classes and use `category=knowledge_lifecycle` unless all criteria are met.

**Questions for a higher-capability model or architecture review:**

1. Is mission class the correct axis for knowledge lifecycle governance, or should category plus review gates carry the distinction?
2. Does `customer_engagement` currently mix concierge transactions and durable customer delivery too broadly?
3. Should `environment_and_recovery` include diagnosis, or should read-only diagnosis remain under system observability with a task shape?
4. Are `pipeline` and `mission` represented as orthogonal properties in enough places, or does the current single `execution_shape` field force a false choice?
5. Which class boundaries remain unstable when tested against 100-500 real operator utterances?

**Verification:**

```bash
pnpm run check:doc-examples
pnpm run check:reference-drift
```

**Completion condition:** The ADR records evidence, alternatives, and a clear keep-nine or add-one decision.

### Task 10: Make the decision explainable to operators

**Objective:** Tell the user what Kyberion will do without exposing internal taxonomy jargon by default.

**Files in scope:**

- Modify `docs/OPERATOR_UX_GUIDE.md`
- Modify `libs/core/surface-ux-contract.ts`
- Modify `libs/core/surface-ux-contract.test.ts`
- Modify one operator-facing surface test selected from the actual integration path

**Required user-facing behavior:**

- Use plain language such as “短い作業として進めます” or “承認と記録が必要なためミッションとして進めます”.
- State the concrete trigger when promoted: multiple stakeholders, external commitment, approval, durable continuation, or governed evidence.
- Do not show raw names such as `mission_class` or `execution_shape` unless the operator requests diagnostics.
- For schedule coordination, distinguish preparing options from contacting participants or changing calendars.
- For reviews, distinguish extraction, review purpose, reviewer role/tenant context, and approval evidence.

**Verification:**

```bash
pnpm exec vitest run libs/core/surface-ux-contract.test.ts
pnpm run check:doc-examples
pnpm build
```

**Completion condition:** Users can predict whether Kyberion is answering, performing a bounded task, or opening governed work before side effects occur.

## 9. Release Gate

Run this only after Tasks 1-10 are complete:

```bash
pnpm run validate
pnpm run test:core
```

Then run the representative scenarios through the real operator entry point in dry-run or preview mode. Confirm:

- no small direct request creates a mission;
- no mandatory mission trigger stays in an ungoverned task session;
- every promoted mission has one owner, a valid workflow, valid team template, required review gates, and evidence requirements;
- policy and scenario files pass schema validation;
- no unrelated intent route changes unexpectedly.

## 10. Recommended Pull Request Sequence

| PR | Tasks | Behavior change | Rollback scope |
|---|---|---|---|
| PR 1 | 1-2 | Type/contract alignment only | Mission classification core |
| PR 2 | 3 | Shared execution-shape vocabulary | Core type normalization |
| PR 3 | 4 | New pure advisory policy | New policy and resolver |
| PR 4 | 5 | Advisory output only | Work-design integration |
| PR 5 | 6 | Task-to-mission routing enforcement | Orchestrator boundary |
| PR 6 | 7-8 | Coverage and regression scenarios | Governance catalogs/tests |
| PR 7 | 9-10 | ADR and operator UX | Documentation/UX contract |

Do not merge PR 5 until PR 4 has been observed against the scenario set and promotion rates have been reviewed. PR 5 is the first change that can materially alter runtime routing.

## 11. Success Metrics

The improvement is complete when all of the following are true:

- Canonical mission-class drift count is zero across TypeScript, schemas, policy, workflows, review gates, and tests.
- Unknown workflow/team/gate references are zero for all ontology entries.
- Representative classification scenarios pass deterministically.
- False mission promotion is below 5% in the maintained scenario corpus.
- Mandatory-trigger mission bypass is zero.
- Every classification result explains its class, shape, policy version, and matched rules in diagnostic output.
- Operator-facing output communicates the work boundary without requiring taxonomy knowledge.

## 12. GPT-5.4 mini Implementation Map

This section turns the classification model into a build order that GPT-5.4 mini can execute safely. The intent is not to invent new concepts; it is to make the current taxonomy operable with small, deterministic patches.

### 12.1 Class-to-implementation matrix

| Class | Typical user request | Current implementation gap | Smallest useful change | Verification artifact |
|---|---|---|---|---|
| `direct_reply` | Read agenda, answer a question, explain a concept | User-facing text still sometimes exposes internal taxonomy | Add plain-language explanation and keep the route read-only | Surface copy test + corpus check |
| `task_session` | Draft options, prep a review, organize a bounded task | Advisory scope decision is not always surfaced | Compute and expose `work_scope_decision` without changing execution | Work-design test + route test |
| `pipeline` | Import a PPTX theme, review a contract, run a repeatable extraction | Pipeline intent and mission intent can be conflated | Keep replayable flows explicit and prevent silent mission promotion | Pipeline scenario regression |
| `mission` | Coordinate stakeholders, customer discovery, release work | Promotion triggers are not always explainable | Persist mandatory and accumulation triggers in evidence | Orchestrator promotion test |
| `project_bootstrap` | Start a new product or long-lived initiative | Project-level initiation is under-documented | Separate project creation from mission execution and describe the handoff | Bootstrapping contract test |
| `customer_engagement` | Schedule coordination, requirements elicitation | External commitment rules need clearer operator text | Add reviewer/tenant/stakeholder phrasing to the UX contract | Customer-engagement scenario pack |
| `decision_support` | Decision memo, approval text, plain review | Decision alignment and dissent handling are hidden in the flow | Make alignment, dissent, and role context explicit in the review path | Decision-support scenario pack |
| `content_and_media` | PPTX theme import, web theme extraction, design build | Theme fidelity and media-type differences are not visible enough | Separate theme extraction, theme registration, and downstream reuse | Theme-pack schema and regression tests |
| `operations_and_release` | Diagnose a local runtime issue, inspect readiness | Read-only diagnosis and actual mutation are too close in UX | Keep diagnosis distinct from state-changing operations | Operations scenario regression |
| `platform_onboarding` | Configure an org integration, first-run setup | Setup flows need stronger prerequisites and safe fallback | Route missing prerequisites into setup rather than execution | Onboarding scenario pack |
| `environment_and_recovery` | Recover a suspended mission, resume work | Recovery and normal task flow can blur | Preserve recovery evidence, checkpoint state, and resume semantics | Recovery flow regression |
| `research_and_absorption` | Query knowledge, promote reusable knowledge | Knowledge query and durable knowledge promotion are mixed | Separate read-only query, distillation, and promotion to durable knowledge | Knowledge scenario regression |

### 12.2 Recommended build order for GPT-5.4 mini

1. Align contracts and enums.
2. Add pure policy and resolution helpers.
3. Add advisory output before any routing change.
4. Enforce promotion only at the orchestration boundary.
5. Cover workflow, team, and review registry completeness.
6. Add representative scenario fixtures in English and Japanese.
7. Only then decide whether a class count change is justified.

### 12.3 What GPT-5.4 mini should not do

- Do not add new mission classes to make a single scenario pass.
- Do not change execution routing before the advisory contract exists.
- Do not treat `pipeline` as a synonym for `task_session`.
- Do not collapse `customer_engagement` into generic support work.
- Do not convert a read-only review into a mutation flow just because the source looks formal.
- Do not hide promotion triggers behind prose-only explanations; keep them machine-readable too.

### 12.4 Minimum deliverables per patch

For each patch, GPT-5.4 mini should be able to produce one of the following:

- a schema or enum alignment
- a pure resolver or policy helper
- a focused regression test
- a catalog completeness fix
- a user-facing explanation update

If a patch needs more than one of those categories, split it before implementation.

### 12.5 Practical handoff rule

When a request is ambiguous, the implementation should first answer:

1. What is the execution shape?
2. What is the mission class?
3. What evidence or gate is required?
4. Is promotion mandatory, advisory, or not needed?

If those four questions cannot be answered from the current catalogs, the roadmap should be extended with a scenario or policy entry before any routing code changes.
