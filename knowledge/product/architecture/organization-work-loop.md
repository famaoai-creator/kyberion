---
title: Organization Work Loop
category: Architecture
tags: [architecture, organization, intent, outcome, execution, evidence, learning]
importance: 10
author: Ecosystem Architect
last_updated: 2026-10-20
kind: evergreen
---

# Organization Work Loop

## 1. Purpose

Kyberion should be understood as an engine for the organization work loop.

Its thesis is:

> Kyberion turns organizational intent into governed execution, evidence, and reusable memory.

This is the parent model above conversational UX, missions, actuators, approvals, artifacts, and memory promotion.

## 2. Core Loop

The full work loop is:

```text
Intent
-> Context
-> Resolution
-> Outcome Design
-> Runtime Design
-> Teaming
-> Authority
-> Execution
-> Accounting
-> Learning
```

This is the generalized model for how organizations convert goals into governed work.
It is a conceptual ordering, not a linear script: scope, authority and outcome checks recur at every consequential transition. Teaming proposes a capable executor; it never grants permission.

### 2.1 One model, several projections

| Projection                                                            | Meaning within the same work loop                                       | Canonical owner                  |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------- |
| User: Intent → Plan → Result                                          | Ask, answer necessary questions, inspect results and request changes    | docs/USER_EXPERIENCE_CONTRACT.md |
| Intent: receive → clarify → retain → execute → verify → learn         | Preserve intent and evidence throughout; retention is continuous        | docs/INTENT_LOOP_CONCEPT.md      |
| Enterprise: Intent → Resolve → Approve → Execute → Account → Learn    | Company-scale control; Approve means evaluate authority, not always ask | enterprise-operating-kernel.md   |
| Agent lifecycle: onboarding/recovery → alignment → execution → review | Session entry and governed mission lifecycle                            | AGENTS.md and phase protocols    |
| Memory: Execute → Capture → Assess → Distill → Promote → Reuse        | Accounting/Learning returns to the next Context and Resolution          | corporate-memory-loop.md         |

These are not competing state machines. Existing WorkItems, mission state, approval-store, execution receipts and memory-promotion records retain their ownership. Link them rather than adding another loop ledger. Historical comparisons in older concept documents are not current readiness evidence.

### 2.2 Shared judgment envelope, distinct decisions

Retain original intent, success criterion, work identity/revision, canonical context, evidence, policy/approval references, proposed effect, accountable owner and verification requirement. Reuse existing typed contracts; this is not a new all-purpose decision store.

Common decision axes:

1. **Meaning and scope:** Is the outcome clear, and does tenant → organization → project → mission → task context survive? Tier is separate.
2. **Authority:** Is this exact effect permitted now by policy and still-valid approval?
3. **Capability and delegation:** Which eligible executor can produce the result within the same or narrower authority, budget and data boundary?
4. **Risk and uncertainty:** Is evidence or outcome-changing clarification missing, or must an authorized human decide? Confidence and trust scores are evidence, never grants.
5. **Verification and continuity:** What proves the effect occurred, and what can safely resume?
6. **Learning applicability:** Is a lesson supported, reviewed as required, and usable in this scope and snapshot?

Clarification supplies intent; approval permits an effect; delegation assigns responsibility; verification accepts evidence; promotion makes reviewed knowledge eligible for retrieval. Do not collapse these into one approve/reject flag. Models recommend; deterministic contracts and authority boundaries enforce. Another model or learned shortcut cannot override denied permission.

Decision sophistication can evolve behind its existing seam. Consumers depend on validated outputs and these invariants, not on a provider or score formula.

## 3. Layer Model

### User Layer

This is the human-facing interaction model:

- `Intent`
- `Plan`
- `Result`

This layer should stay simple.
Humans should not need to manage internal execution primitives directly.

### Control Layer

This is the organizational control model:

- `Context`
- `Resolution`
- `Team`
- `Authority`

This layer determines project context, execution shape, ownership, approvals, and policy scope.

### System Layer

This is the operating model implemented by Kyberion:

- `Execution`
- `Evidence`
- `Memory`

This layer handles task sessions, missions, artifacts, deliveries, audit traces, distillation, and reuse.

## 4. Loop Stages

### 4.1 Intent

What the organization wants to achieve.

Examples:

- `Build a banking app`
- `Create a test plan`
- `Prepare this month's operational report`

### 4.2 Context

The governing situation around the request:

- project
- tier
- service bindings
- constraints
- existing knowledge
- previously learned patterns

### 4.3 Resolution

The structured decision about the shape of work.

Typical outcomes:

- direct answer
- task session
- mission
- project bootstrap

### 4.4 Outcome Design

The explicit design of what success should return.

Examples:

- artifact
- report
- approval-ready plan
- service change
- delivery record

### 4.5 Runtime Design

This stage defines the light-weight execution primitives beneath the governed contract:

- owner model
- worker assignment policy
- coordination bus
- transient working memory

This is where Kyberion may borrow runtime mechanics from simpler multi-agent frameworks without giving up planning or governance authority.

### 4.6 Teaming

Who should handle the work:

- specialist
- specialist team
- external service
- human approver

### 4.7 Authority

What can proceed autonomously and what must be approved.

This stage binds:

- policy
- approvals
- role boundaries
- risk controls

### 4.8 Execution

The actual work:

- task sessions
- missions
- actuators
- external deliveries

### 4.9 Accounting

The traceable record of what happened:

- artifacts
- evidence
- audit trail
- ledger records
- delivery state

### 4.10 Learning

The promotion of completed work into reusable organizational memory:

- patterns
- SOPs
- templates
- hints

This is how Kyberion becomes more capable over time.

## 5. Why This Model Matters

This model generalizes organizational work without flattening all work into the same execution path.

The same loop can govern:

- company formation
- product development
- compliance work
- finance operations
- customer reporting
- service operations

What changes is not the loop itself, but:

- context
- outcome
- authority
- execution shape

## 6. Relationship to Enterprise Operating Kernel

`Organization Work Loop` is the parent conceptual model.

`Enterprise Operating Kernel` is the enterprise framing that operationalizes this model with:

- leadership intent and approval
- control plane responsibilities
- accountability
- corporate memory

In short:

- `Organization Work Loop` explains the general organizational mechanism
- `Enterprise Operating Kernel` explains how Kyberion implements it at company scale

## 7. Design Test

A capability fits the work loop only if all of the following are true:

1. The desired outcome can be stated in human terms.
2. The system can resolve the correct work shape.
3. Authority and approvals can be enforced.
4. Evidence can be produced after execution.
5. Learning can feed back into future work.

If any of these fail, the capability is not yet part of the governed work loop.

## 8. Return paths and user interaction

- **Missing intent:** ask an outcome-changing question and keep work identity. An answer does not approve an unrelated effect.
- **Approval required:** use existing DecisionCard/approval-store; explain exact effect, evidence and silence semantics. Park that effect and continue independent authorized work.
- **Approved:** re-read current scope, policy and bound content, use an existing apply claim/receipt where supported, and verify the effect. Approval alone does not prove a continuation exists or ran.
- **Rejected, expired or revoked:** do not execute, reopen on every tick, or reinterpret silence. Changed requests are new revisions with applicable checks.
- **Unknown outcome:** reconcile the original attempt before retrying. Process death or lease expiry does not prove no effect occurred.
- **Verification failure:** classify evidence and repair only within authority and retry budget. Permission/authentication/governance failures are not repair mandates.
- **Correction:** link feedback to delivered work and scope, revise the result, and capture a separate candidate if useful. Capture is not approval/publication.
- **Next work:** retrieve a stable eligible snapshot, record the applied lesson and measure the outcome. Storage or promotion is not proof of use or improvement.

The user sees request → necessary clarification/decision → understandable progress → verified result → correction if needed, without repeating the request across internal handoffs.

## 9. Implementation boundaries and acceptance evidence

The loop is a design obligation, not a claim that all surfaces are wired end to end.
At the 2026-10-20 governed-continuation integration:

| Boundary             | Existing mechanism and limit                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope                | scope-context, entity-scope and typed WorkItems exist. Metadata is not authority; adapters must preserve runtime isolation.                                                                                      |
| Human intervention   | Explicit human-directed preparation binds the original WorkItem to a planned mission and shared alignment review. The watchdog resumes only its exact fresh approval claim; autonomous shadow remains unchanged. |
| Delegation           | Preflight/task contracts bound eligible workers. Organization-only surface A2A is not supported merely by attaching metadata when the receiver requires mission-bound security scope.                            |
| Judgment integration | Canonical sensitive failures must not enter autonomous repair; declared verdict schemas and meaningful predicates must be enforced before routing.                                                               |
| Feedback             | Canonical memory scope and correlation exist. Legacy unscoped records remain legacy, never silently adopted into a tenant.                                                                                       |
| Promotion            | Authenticated review publishes confidential tenant, organization or project SOPs at exact scoped paths. Unsupported owner/audience/mission/task restrictions remain review-only, never broadened.                |
| Learning evidence    | Canonical publication receipts bind both artifact hashes; delivered snapshots bind exact bytes to work. Delivery, cited use and verified outcome are separate evidence, not proof of measured improvement.       |

The acceptance suite must cover continuity across clarification, delegation, approval hold/resume, verified delivery, scoped feedback, review/promotion and next-work use. Each work item traverses only the applicable stages; simple work does not acquire unnecessary questions or approval gates. Cover duplicate inputs, denial/expiry, changed approved content, unknown outcomes and cross-scope contamination. Mocked tests, recorded closure and builds are separate evidence classes from authenticated live business execution.

### 9.1 Scoped SOP review in the existing surfaces

Chronos Knowledge is the preparation and publication surface: select an exact candidate, save its curated title/summary/content/evidence, request human review, then explicitly publish the approved SOP. The request opens the existing shared Approvals view, including mission-less and terminal decisions. Concierge links the same candidate to Chronos rather than introducing another editor or approval store.

The canonical request freezes the reviewed payload and destination. Every queue writer and publication retry must preserve that binding; a changed proposal needs a new candidate. Candidate keys are selectors, not authority. Server-resolved tenant, organization and project visibility is applied before candidate or approval details, counts, decisions and passkey operations. Owner/audience and unsupported scope restrictions remain review-only. Scoped details are not broadcast through shared notifications or the legacy knowledge-preview route.

A lost response is an unknown result, not permission to resend. Refresh the exact candidate/review first. Publication reconciles canonical artifact hashes and approval consumption before marking the queue promoted; a retry after final queue persistence fails must retain identical artifact bytes and receipt. The publisher's existing scoped service authority may read only the fixed proof artifacts after binding and current-approver checks, never an arbitrary viewer-supplied path. A verified receipt makes the SOP eligible for existing same-scope retrieval; it does not grant execution authority or relax the autonomous shadow mandate.

## 10. Companion Documents

- `knowledge/product/architecture/enterprise-operating-kernel.md`
- `knowledge/product/architecture/project-mission-artifact-service-model.md`
- `knowledge/product/architecture/management-control-plane.md`
- `knowledge/product/architecture/corporate-memory-loop.md`
- `knowledge/product/architecture/surface-responsibility-model.md`
