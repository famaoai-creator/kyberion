---
title: Delegated Task Observability
category: Orchestration
tags: [orchestration, delegation, observability, subagent]
importance: 8
author: Ecosystem Architect
last_updated: 2026-11-05
---

# Delegated Task Observability

Hermes-style subagent delegation is useful only if it is visible.

Kyberion therefore treats delegated work as a traced event stream:

- when a delegated task starts, record a start event
- when it completes, record the completion result
- when it fails, record the failure reason

## 1. Why

Delegation can otherwise become invisible, especially when a backend
spawns an autonomous sub-agent and returns only a textual report.

Observability gives Kyberion:

- accountability
- replayability
- debugging context
- evidence for later learning

## 2. Record Shape

A delegated task trace should capture:

- `trace_id`
- owner
- instruction
- optional context or context reference
- backend name
- status transition
- completion summary or error

## 3. Storage

Delegation traces are append-only JSONL records, and each delegation also
has a resumable record (`records/<id>.json`, plus `records/child-inbox/` for
continuable children). Both live in the delegation's own partition of the
registered runtime ledger root `active/shared/runtime/delegation-records/`:

- untenanted delegations: `system/delegations.jsonl`, `system/records/`;
- tenant delegations: `confidential/<tenant>/delegations.jsonl`,
  `confidential/<tenant>/records/` — read and written only as the
  tenant-bound `delegation_record_store` role, so a process bound to one
  tenant never sees another tenant's instructions or results. Tenant
  offboarding exports and removes the partition.

The record carries `tenant_slug`; a resume, an activation settlement and a
cold-resume worker (spawned with `KYBERION_TENANT`) stay in that partition.
The pre-partition shared copies (`active/shared/observability/delegations.jsonl`
and `active/shared/observability/delegations/`) are read-only legacy: a record
there is served only to the tenant its mission (or stamp) belongs to — or to
an unbound process — and moves into its partition on its next write; tenant
offboarding prunes the tenant's rows and records from them. See
[runtime-storage-layout](../architecture/runtime-storage-layout.md#delegation-trace-and-records).

Background delegations also enqueue a completion notification
(`libs/core/mission/delegation-notifications.ts`) into the same partition
(`system/notifications.jsonl` or `confidential/<tenant>/notifications.jsonl`).
A tenant-bound process claims only its own tenant's notifications; the
unbound mission worker drains every partition plus the read-only legacy queue
`active/shared/runtime/delegations/notifications.jsonl`, whose rows are
attributed (stamp, record partition, mission) and, once claimed, copied into
their partition so they are delivered at most once. Tenant offboarding
removes the partition queue and prunes the tenant's legacy rows.

The traces stay observability evidence, not durable mission state.

## 4. Usage Rule

Use delegated-task traces for:

- repair agents
- autonomous subagent invocation
- other short-lived reasoning offloads that need evidence

Do not use them as a replacement for mission evidence or permanent memory.
