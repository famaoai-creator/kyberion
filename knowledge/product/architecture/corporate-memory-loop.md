---
title: Corporate Memory Loop
category: Architecture
tags: [architecture, memory, distillation, sop, patterns, learning]
importance: 9
author: Ecosystem Architect
last_updated: 2026-10-20
kind: evergreen
---

# Corporate Memory Loop

## 1. Purpose

An enterprise operating kernel must do more than execute work.
It must improve the organization's memory over time.

The corporate memory loop defines how completed work becomes reusable organizational capability.

## 2. Core Loop

```text
Execute
-> Capture
-> Assess
-> Distill
-> Promote
-> Reuse
```

This is the Accounting/Learning return path of the [Organization Work Loop](organization-work-loop.md), not an independent execution or approval system. Reuse returns to the next work item's Context and Resolution.

## 3. Stages

### 3.1 Execute

Work is performed through:

- task sessions
- missions
- controlled service interactions
- governed artifact production

### 3.2 Capture

The system should retain:

- produced artifacts
- evidence
- traceability references
- approvals
- source context
- execution summaries

This stage is about preserving enough material for later explanation and improvement.

### 3.3 Assess

Not every completed execution should become a candidate.

Before distillation, Kyberion should run a deterministic assessment that checks whether the output is actually reusable.

Examples:

- browser workflows need a trace, an interactive apply step, and a concrete target
- task sessions need a governed artifact and a reusable structure
- generic completions should remain as execution records only

Assessment is a gate, not a memory object.

### 3.4 Distill

The system should extract reusable understanding such as:

- what pattern worked
- what failed
- what caused delay
- what template should be reused
- what guardrail should be strengthened

Distillation should prefer structured records over raw log accumulation.

### 3.5 Promote

Useful learning should be promoted into governed memory forms such as:

- SOP entries
- role guides
- project patterns
- reusable plan templates
- standard intents
- evidence-backed operational hints

High-impact changes may require explicit human ratification.

### 3.6 Reuse

Future resolution and planning should draw on:

- proven patterns
- prior project outcomes
- specialist performance history
- learned clarification prompts
- known risk and approval boundaries

This is how Kyberion becomes more capable as an organization works through it.

## 4. Memory Objects

The corporate memory loop should operate over:

- `Artifacts`
- `Evidence`
- `Pattern records`
- `Knowledge cards`
- `Role guidance`
- `SOP candidates`
- `Approval precedents`

Not every completed task should become a permanent rule.
Promotion should remain selective and governed.

## 5. Relationship to Vault and Knowledge

The memory loop spans both general knowledge and governed sensitive memory.

### Public or general reusable memory

Suitable for:

- generic patterns
- operational templates
- non-sensitive reusable procedures

### Vault-backed or sensitive memory

Suitable for:

- approval evidence
- sensitive business precedent
- privileged service details
- high-trust organizational memory

Vault remains the trust boundary for sensitive learning.

## 6. Snapshot vs Durable Store

Kyberion also distinguishes between:

- the **current memory snapshot** used by a running session
- the **durable memory store** that receives updates for later reuse

Snapshot reads should remain stable during a run. Durable writes should be preserved immediately, but they should not force the current session to re-interpret itself mid-turn.

This separation is documented in [`memory-snapshot-protocol.md`](../orchestration/memory-snapshot-protocol.md) and is used by memory-backed resolution flows such as intent-contract learning.

## 7. Design Rules

### 7.1 Logs are not memory

Raw logs alone do not produce organizational learning.
They must be distilled into reusable forms.

### 7.2 Evidence before promotion

Reusable knowledge should be linked back to evidence.
Memory without accountability becomes folklore.

### 7.3 Candidate before promotion

The system should distinguish:

- execution record
- distill candidate
- promoted memory

Those are separate stages.
Promotion should not happen directly from a raw completion unless the governing policy explicitly allows it.

### 7.4 Reuse should improve resolution

The main value of memory is not archival.
It is better future work:

- faster resolution
- better plans
- better approvals
- fewer repeated mistakes

### 7.5 Human ratification for structural change

Changes to high-impact procedures or organizational rules should be reviewable and, where appropriate, approved before promotion.

### 7.6 Preserve scope, provenance and authority

Feedback binds to trusted work context, not scope claimed by a model or correction payload. Preserve tier, tenant, organization, project, mission/task and owner/audience restrictions where applicable, together with source feedback/correlation and evidence. An aggregated candidate may link several work items; it must not pretend they were one execution or combine different scopes.

A legacy unscoped candidate is not silently adopted into the current organization. If the publisher cannot preserve a narrower scope, keep the proposal review-only; never drop fields to make promotion succeed. The scoped SOP handoff preserves confidential tenant, organization and project scope through authenticated review, exact publication and scoped retrieval. Owner/audience/mission/task restrictions and other unsupported scope fields remain review-only. A success does not grant execution authority.

Approval precedents explain past decisions. They do not renew consent, grant permissions, change security policy or authorize new external effects. Delegation and repair retain the current authority floor after learning.

### 7.7 Prove consumption, not just storage

Distinguish candidate capture, assessment, review, promotion, exact publication verification, retrieval into a stable snapshot, application to a work item, and measured outcome. A queue state or promoted reference proves only that recorded stage. Aggregate usage cannot establish which scoped lesson improved which result.

Reuse the existing memory-promotion queue and snapshot protocol. Do not add a second inbox to hide unsupported transitions. Corrections that invalidate a lesson are new reviewable evidence; running sessions do not silently replace their pinned snapshot. Same-scope subsequent work retrieves an independently verified publication without repeating its completed review. Approval revocation and current reviewer authority remain checked; completed publication proof, not a status label, permits ordinary reuse after the original review window expires. Completion attribution uses the delivered immutable bytes even when the source file has since changed.

### 7.8 Supported review-to-use operator sequence

For a uniquely identified confidential scoped SOP candidate, use the existing
mission controller and keep the identical curation throughout:

1. Inspect with `memory-review <ID> --tenant-slug <TENANT>`.
2. Open the exact human card with `memory-approve <ID> --tenant-slug <TENANT> --curation-json <JSON> --request-approval`.
3. Decide in the authenticated shared approval surface. A typed human label is not proof.
4. Apply that review with the same curation and `--approval-ref terminal:<REQUEST_ID>` instead of `--request-approval`.
5. Publish with `memory-promote <ID> --tenant-slug <TENANT>`; preserve its exact organization/project scope from the candidate. Unsupported restrictions or ambiguous IDs stay held.
6. Later same-scope work retrieves the verified snapshot through normal task provisioning. It does not repeat completed review or acquire any new execution authority.

The curation/request/apply/publish steps are currently CLI-mediated; the shared UI
approves the presented content. This is not a new graphical editorial workflow.
The real-store acceptance test is `knowledge-learning-delivery.e2e.test.ts`;
its worker transport is mocked, so passing it is not live business execution.

## 8. Success Criteria

The corporate memory loop succeeds when:

- completed work improves future work
- recurring requests become easier to resolve
- repeated failures produce explicit guardrails
- successful patterns become reusable templates
- organizational knowledge outlives any single session or operator
