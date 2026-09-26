---
title: Organization Operations Runbook
tags: [organization, operation, incident, decision, governance]
last_updated: 2026-09-24
---

# Organization operations

Use `pnpm organization` for organization state changes. Select a tenant and organization scope first, and include `--tier confidential --tenant-slug <slug>` for confidential operations. Writes require an explicit `--apply` and either the sovereign persona or the least-privilege `MISSION_ROLE=organization_operator` with `KYBERION_TENANT=<slug>` (own tenant's confidential/public organization state only); inspect the same command with `--dry-run` first.

## Routine operations

Register a scheduled Operation with a five-field cron expression and an IANA timezone. When `--timezone` is omitted, due calculations use UTC. `operation run execute` runs an active Operation whose execution target is an existing governed file under `pipelines/`. It records a started Run, executes the validated pipeline, then records a completed Run and State with a trace reference. A failed pipeline also opens an Incident with the Run ID.

```bash
pnpm organization operation tick --organization-id ORG --tier confidential --tenant-slug TENANT --dry-run --json
pnpm organization operation tick --organization-id ORG --tier confidential --tenant-slug TENANT --apply --json
```

`tick` performs one catch-up run for each due Operation. The occurrence determines a stable Run ID, and execution holds an operation lock to prevent overlapping ticks from running it twice. If a process stops after recording `started`, the next applied tick marks that Run blocked and opens an Incident for operator review. Operations needing additional approval or another execution target are reported as blocked for a separate governed execution path. Arrange repeated `tick` calls through the operator's scheduler; creating an Operation record alone does not install a scheduler job.

For a blocked Run, inspect its Incident and pipeline Trace, decide whether external effects already occurred, and resolve the Incident through the governed transition commands. A subsequent attempt needs a new explicit Run ID; the same scheduled occurrence ID is never replayed automatically. Correct the underlying failure before triggering another run.

## Deadlines and the daily digest

An Operation may carry a `deadline` (`--deadline-business-day <n> --deadline-time <HH:MM>`), evaluated in the trigger timezone on the Japanese bank calendar: weekends, national holidays (including substitute and citizen's holidays) and December 31 – January 3 are closed. A business day past the month's count is clamped to the month's last business day. A period is met only by a succeeded Run completed inside the period and at or before the deadline; a later success stays missed and is marked `completed_late`. The builder stamps `deadline.deadline_effective_from` when a deadline is added or its day/time changes and carries it forward otherwise, so a period whose deadline passed before that moment is `untracked` rather than missed. Editing other fields does not hide a missed period. Records without the field fall back to `updated_at`.

`pipelines/organization-daily-digest.json` (08:30 Asia/Tokyo) aggregates every organization across tenants for the sovereign operator: overdue and due Operations, business-day deadlines, pending Decisions, service observations that are stale or expire within seven days, and open Incidents. It runs only as `KYBERION_PERSONA=sovereign`, records one audit entry naming the tenants read, and skips a tenant it cannot read, listing it in the digest and the audit entry. Delivery goes to Slack through Chronos `deliver_to` with `channel: env:KYBERION_OPERATOR_SLACK_DM`; an unset value fails closed. On a host, `KYBERION_CHRONOS_SCHEDULES` (comma-separated schedule ids) limits which schedules Chronos runs; a value that lists no ids runs nothing. Install the daemon with `pnpm kyberion chronos install --apply --forward-env KYBERION_PERSONA --forward-env KYBERION_CHRONOS_SCHEDULES --forward-env KYBERION_OPERATOR_SLACK_DM`.

## Incidents and decisions

Create an Incident with `incident add`, then advance it with `incident transition`: `detected → triaging → mitigating → resolved → closed` (triaging may resolve directly). Closing requires an existing post-incident review in the same knowledge tier and tenant.

Create a Decision as `proposed`, then advance it with `decision transition`. Approval or rejection requires a `channel:id` approval reference whose record has a strongly authenticated human decision, `human_only` accountability, the same organization and tenant scope, and an effect binding of `organization:decision:<id>:approved` or `organization:decision:<id>:rejected`. An approved Decision needs a chosen option; `implemented` needs a follow-up reference.

Chronos shows tenant-scoped CLI commands beside organization intervention points. The HTTP view remains read-only; the commands enter through the governed organization facade.

## Subsidiaries

A subsidiary that does not warrant its own tenant is created under its parent's tenant and linked with `parent_organization_id`. The parent must exist in the same tier and tenant; a parent link is never a cross-tenant reference, and cycles are refused. Each organization keeps its own records, and `status` shows the parent and subsidiaries without merging them.

```bash
pnpm organization init --organization-id CHILD --name "<name>" --tier confidential --tenant-slug TENANT --parent-organization-id PARENT --dry-run
pnpm organization parent set --organization-id CHILD --tier confidential --tenant-slug TENANT --parent-organization-id PARENT --apply
pnpm organization parent set --organization-id CHILD --tier confidential --tenant-slug TENANT --clear --apply
```
