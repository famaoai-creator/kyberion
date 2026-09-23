---
title: Organization Operations Runbook
tags: [organization, operation, incident, decision, governance]
last_updated: 2026-09-24
---

# Organization operations

Use `pnpm organization` for organization state changes. Select a tenant and organization scope first, and include `--tier confidential --tenant-slug <slug>` for confidential operations. Writes require the sovereign persona and an explicit `--apply`; inspect the same command with `--dry-run` first.

## Routine operations

Register a scheduled Operation with a five-field cron expression and an IANA timezone. When `--timezone` is omitted, due calculations use UTC. `operation run execute` runs an active Operation whose execution target is an existing governed file under `pipelines/`. It records a started Run, executes the validated pipeline, then records a completed Run and State with a trace reference. A failed pipeline also opens an Incident with the Run ID.

```bash
pnpm organization operation tick --organization-id ORG --tier confidential --tenant-slug TENANT --dry-run --json
pnpm organization operation tick --organization-id ORG --tier confidential --tenant-slug TENANT --apply --json
```

`tick` performs one catch-up run for each due Operation. The occurrence determines a stable Run ID, and execution holds an operation lock to prevent overlapping ticks from running it twice. If a process stops after recording `started`, the next applied tick marks that Run blocked and opens an Incident for operator review. Operations needing additional approval or another execution target are reported as blocked for a separate governed execution path. Arrange repeated `tick` calls through the operator's scheduler; creating an Operation record alone does not install a scheduler job.

For a blocked Run, inspect its Incident and pipeline Trace, decide whether external effects already occurred, and resolve the Incident through the governed transition commands. A subsequent attempt needs a new explicit Run ID; the same scheduled occurrence ID is never replayed automatically. Correct the underlying failure before triggering another run.

## Incidents and decisions

Create an Incident with `incident add`, then advance it with `incident transition`: `detected → triaging → mitigating → resolved → closed` (triaging may resolve directly). Closing requires an existing post-incident review in the same knowledge tier and tenant.

Create a Decision as `proposed`, then advance it with `decision transition`. Approval or rejection requires a `channel:id` approval reference whose record has a strongly authenticated human decision, `human_only` accountability, the same organization and tenant scope, and an effect binding of `organization:decision:<id>:approved` or `organization:decision:<id>:rejected`. An approved Decision needs a chosen option; `implemented` needs a follow-up reference.

Chronos shows tenant-scoped CLI commands beside organization intervention points. The HTTP view remains read-only; the commands enter through the governed organization facade.
