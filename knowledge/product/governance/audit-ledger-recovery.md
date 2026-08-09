---
title: Audit ledger recovery and canonical location
tags: [governance, audit, baseline, entity-governance]
last_updated: 2026-08-09
---

# Audit ledger recovery

## Finding

The historical `active/audit/` tree stopped receiving the hash-chained audit
stream after `audit-2026-05-31.jsonl`. The runtime writer and the operating
baseline use `active/shared/logs/audit/`, where entries resumed on 2026-08-08.
The old tree is retained as historical evidence; it is not a second live
ledger.

## Root cause and correction

The audit-chain writer had already moved to the shared runtime log location,
while older operator documentation and the legacy tree still presented
`active/audit/` as the live source. EG-03 makes the runtime location explicit:

- `libs/core/audit-chain.ts` writes only to `active/shared/logs/audit/`.
- `run_baseline_check` evaluates the newest valid JSONL timestamp in that
  directory and reports the result as the audit-ledger freshness layer.
- A missing or stale ledger is `needs_attention`; it cannot be hidden by a
  healthy janitor or provider result.

## Declared gap

The interval after the last legacy entry and before the shared-runtime stream
resumed is an audit evidence gap. Existing historical files are not rewritten
or synthesized. The gap remains visible for human review and is bounded by the
baseline freshness gate going forward.
