---
title: Secret Mutation Approval Model
category: Architecture
tags: [architecture, approvals, secrets, governance, surfaces]
importance: 9
author: Ecosystem Architect
last_updated: 2026-03-25
---

# Secret Mutation Approval Model

## Thesis

Secret mutation is not a raw settings edit.

In Kyberion, a secret change is a governed operational request that must be:

- proposed in context
- reviewed with explanation
- approved through a role-based workflow
- applied as an auditable mutation
- reversible where possible

The system should never require one specific surface to exist in order to authorize a sensitive change.

## Core Principle

Sensitive changes are surfaced where the human is, but governed where the system is controlled.

This means:

- Slack can notify and collect lightweight intent
- Terminal can offer precise operator approval
- Chronos can provide the richest review surface
- authenticator or TOTP can provide portable proof of approval

No single surface is the root of trust.

The root of trust is the approval workflow plus the approver's authentication proof.

## Separation of Concerns

### 1. Request

A secret change starts as a request object.

The request captures:

- which service is affected
- which key is changing
- which mutation is proposed
- who requested it
- why it is needed
- what impact is expected

The request is the durable unit, not the UI interaction.

### 2. Workflow

Approval is role-based, not headcount-based.

The system should model required approval roles such as:

- `sovereign`
- `operator`
- `security`
- `service_owner`

The workflow decides which roles are required for a request.

### 3. Authentication

Authentication proves that the approver is the intended approver.

Examples:

- active session in Chronos
- terminal session with local operator authority
- TOTP or authenticator proof
- passkey or other strong local confirmation

Authentication is not the workflow.
It only proves identity for a workflow step.

### 4. Apply

Once the workflow is satisfied, the actual mutation is executed through the governed secret plane.

The apply step must emit audit evidence and return a deterministic result.

## Surface Model

### Slack

Use for:

- notification
- lightweight summaries
- request awareness

Do not treat Slack as the only authoritative review surface.

Slack is best for:

- "a secret change is waiting"
- "this request affects Slack connectivity"
- "review in Chronos or approve in terminal with request id"

### Chronos

Chronos is the richest control surface for secret review.

It should show:

- pending secret changes
- role requirements
- impact and restart scope
- audit trail
- current approval state

Chronos is not mandatory for approval availability.
It is the best review surface, not the root of trust.

### Terminal

Terminal is the most precise operator surface.

It should support:

- listing pending requests
- viewing a request in detail
- approving or rejecting with strong auth proof

This is especially important when Chronos is unavailable.

## Initial Operating Mode

The schema supports multi-role workflows from day one.

However, the initial operating assumption is simple:

- one human exists
- that human is the `sovereign`
- all approvals can be satisfied by the `sovereign` role

So the first workflow profile is:

- `mode = all_required`
- `required_roles = ["sovereign"]`
- `stages = [{ stage_id: "primary_approval", required_roles: ["sovereign"] }]`

This keeps the model future-proof without forcing premature multi-party process overhead.

## Risk Model

Suggested policy direction:

- `low`
  - refresh or metadata sync
  - can be auto-approved by policy in the future
- `medium`
  - scoped credential repair
  - requires a human approval step
- `high`
  - token replacement, rotation, deletion
  - requires strong auth and explicit review
- `critical`
  - scope expansion, ownership transfer, destructive revocation
  - should require staged approval roles in the future

## Schema

Canonical schema:

- [`secret-mutation-approval.schema.json`](../../../schemas/secret-mutation-approval.schema.json)

This schema is the durable contract for:

- request creation
- workflow state
- approval evidence
- apply outcome

## Product Rule

The UI should never ask:

- "Do you want to update the Slack token?"

without also showing:

- what is changing
- why it is changing
- who requested it
- which role is required
- what restart or delivery impact is expected

That context is the real approval UX.
