---
title: Outcome, Artifact, Evidence, Delivery and Result
tags: [adr, outcome, artifact, evidence, delivery, result]
last_updated: 2026-11-12
concepts: [organization-work-loop, outcome, artifact, evidence, delivery, result]
---

# Outcome Result model

## Decision

Accepted for the bounded additive implementation requested by the owner on 2026-11-12.
The canonical definitions live in the concept registry and
[Organization Work Loop §9.2](../organization-work-loop.md#92-outcome-artifact-evidence-delivery-and-result).

Outcome states the intended result and success criteria. Artifact is the output. Evidence
supports a claim. Delivery records transport to a named destination. Result is the account
presented to the user, including verification, delivery and remaining work. These are distinct
responsibilities; an artifact can also serve as evidence.

## Implementation boundary

Reuse OutcomeContract, TaskResultBlock and ArtifactRecord rather than add another work
ledger or receipt store. `projectOutcomeResult` is a pure projection over authorized input
records. Task Sessions save a regenerable snapshot at completion, rebuild it on repeated
save and remove it on reopen. The snapshot never determines scope or completion authority.

Worker-reported pass is named `reported_passed`, never independent verification. Explicit
failure is retained even when its evidence is blank. Output references and delivery success
do not upgrade verification. Missing delivery coverage remains explicit even when another
output has a successful send. Delivery does not mean human readership or acceptance.

## Compatibility and consequences

Legacy mission and Task Session completion gates remain unchanged. Their reference-presence
checks and goal-matching `delivered` arrays are not reinterpreted as verification or transport
receipts. Existing saved sessions remain valid without the new snapshot. Mission summary
and surface migrations can later reuse this projection; they are not declared migrated here.

Authority, WorkItem/Lease, intent-resolution and memory-model changes remain outside this
decision. Existing artifact review receipts keep immutable version verification and existing
review/acceptance gates keep their decision-making responsibility.
