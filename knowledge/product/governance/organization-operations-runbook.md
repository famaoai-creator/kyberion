---
title: Organization Operations Runbook
tags: [organization, operation, incident, decision, governance]
last_updated: 2026-10-07
---

# Organization operations

Use `pnpm organization` for organization state changes. Select a tenant and organization scope first, and include `--tier confidential --tenant-slug <slug>` for confidential operations. Writes require an explicit `--apply` and either the sovereign persona or the least-privilege `MISSION_ROLE=organization_operator` with `KYBERION_TENANT=<slug>` (own tenant's confidential/public organization state only); inspect the same command with `--dry-run` first.

Shared-scope organizations (`active/organizations/<tier>/shared/…`) are not tenant-owned, so a tenant-bound `organization_operator` cannot write them from an interactive CLI call — use `KYBERION_PERSONA=sovereign` there. The role does cover shared orgs when a delegated execution scope binds the organization (`scope.organization_id`, e.g. a resident-dot cadence), via the `…/shared/${KYBERION_ORGANIZATION_ID}/` grant. An organization with records but no `organization-state.json` reports `organization_state:missing` in reconcile; repair it with `pnpm organization state ensure --organization-id <id> --tier <tier> --apply` (idempotent).

Setting up an organization for the first time? Follow the [Organization Lifecycle Verification Playbook](./organization-lifecycle-verification-playbook.md) end to end first (formation, domain and service, operation, cadence and decision, project, run, incident and learning, reconcile), then use this runbook for routine operation.

## Routine operations

Register a scheduled Operation with a five-field cron expression and an IANA timezone. When `--timezone` is omitted, due calculations use UTC. `operation run execute` runs an active Operation whose execution target is an existing governed file under `pipelines/`. It records a started Run, executes the validated pipeline, then records a completed Run and State with a trace reference. A failed pipeline also opens an Incident with the Run ID.

```bash
pnpm organization operation tick --organization-id ORG --tier confidential --tenant-slug TENANT --dry-run --json
pnpm organization operation tick --organization-id ORG --tier confidential --tenant-slug TENANT --apply --json
```

`tick` performs one catch-up run for each due Operation. The occurrence determines a stable Run ID, and execution holds an operation lock to prevent overlapping ticks from running it twice. If a process stops after recording `started`, the next applied tick marks that Run blocked and opens an Incident for operator review. Operations needing additional approval or another execution target are reported as blocked for a separate governed execution path. Arrange repeated `tick` calls through the operator's scheduler; creating an Operation record alone does not install a scheduler job.

### Scheduled cadences (tick, standup, retro)

Prefer the per-tenant resident-dot cadence: give the organization's dot charter an `operations_cadence` block (`tick_every_minutes`, `standup.cron`, `retro.cron`; requires `scope.organization_id` and `authority_role: organization_operator`). The agent-runtime supervisor then ticks due operations, files the standup and the weekly retro for that organization only, as `organization_operator` bound to the organization's tenant; a run whose bound tenant differs is refused and nothing needs `KYBERION_PERSONA=sovereign`. Each cadence is audited as `tick:scoped` / `standup:scoped` / `retro:scoped`, skipped while the organization budget is at the hard limit, and caught up at most once after downtime. `dots/org-operations.json` is the reference charter. See `dots/README.md`.

Use the sovereign Chronos schedules (`organization-operation-tick`, `organization-standup`, `organization-retro`, `organization-daily-digest`) only for a single operator who needs the cross-tenant view; they aggregate every tenant and refuse any persona other than `sovereign`. Do not enable both paths for the same organization, or its standup and retro are filed twice.

For a blocked Run, inspect its Incident and pipeline Trace, decide whether external effects already occurred, and resolve the Incident through the governed transition commands. A subsequent attempt needs a new explicit Run ID; the same scheduled occurrence ID is never replayed automatically. Correct the underlying failure before triggering another run.

When recording a completed Run for a mission-backed Operation, `--execution-ref` may be either a scoped path or the bare mission id (resolved to that mission's `mission-state.json` under the tenant mission tree). Evidence refs must still be existing files inside the operation scope.

## Deadlines and the daily digest

An Operation may carry a `deadline` (`--deadline-business-day <n> --deadline-time <HH:MM>`), evaluated in the trigger timezone on the Japanese bank calendar: weekends, national holidays (including substitute and citizen's holidays) and December 31 – January 3 are closed. A business day past the month's count is clamped to the month's last business day. A period is met only by a succeeded Run completed inside the period and at or before the deadline; a later success stays missed and is marked `completed_late`. The builder stamps `deadline.deadline_effective_from` when a deadline is added or its day/time changes and carries it forward otherwise, so a period whose deadline passed before that moment is `untracked` rather than missed. Editing other fields does not hide a missed period. Records without the field fall back to `updated_at`.

`pipelines/organization-daily-digest.json` (08:30 Asia/Tokyo) aggregates every organization across tenants for the sovereign operator: overdue and due Operations, business-day deadlines, pending Decisions, service observations that are stale or expire within seven days, and open Incidents. It runs only as `KYBERION_PERSONA=sovereign`, records one audit entry naming the tenants read, and skips a tenant it cannot read, listing it in the digest and the audit entry. Delivery goes to Slack through Chronos `deliver_to` with `channel: env:KYBERION_OPERATOR_SLACK_DM`; an unset value fails closed. On a host, `KYBERION_CHRONOS_SCHEDULES` (comma-separated schedule ids) limits which schedules Chronos runs; a value that lists no ids runs nothing. Install the daemon with `pnpm kyberion scheduler install --apply --forward-env KYBERION_PERSONA --forward-env KYBERION_CHRONOS_SCHEDULES --forward-env KYBERION_OPERATOR_SLACK_DM`.

## Incidents and decisions

Create an Incident with `incident add`, then advance it with `incident transition`: `detected → triaging → mitigating → resolved → closed` (triaging may resolve directly). Closing requires an existing post-incident review in the same knowledge tier and tenant. Write it at `knowledge/<tier>/<tenant>/incidents/<incident-id>-review.md` (what happened, impact, cause, follow-ups) and pass it as `--post-incident-review-ref`; `status` names the path once an incident is resolved.

Create a Decision as `proposed`, then advance it with `decision transition`. Move it to `pending_approval` with `--request-approval --chosen-option <option>` to open the human approval request; the command prints the request id and the `--approval-ref` to use. A human decides the request on an authenticated surface (Chronos / concierge approvals; `pnpm kyberion approvals --approve` uses a weaker method and is not accepted here). Then run `decision transition --record-status approved --chosen-option <same option> --rationale <text> --approval-ref <ref>`, or `--record-status rejected` with the same ref when the human denied it. Approval or rejection requires a `channel:id` approval reference whose record has a strongly authenticated human decision, `human_only` accountability, the same organization and tenant scope, and an effect binding of `organization:decision:<id>:approved` or `organization:decision:<id>:rejected`. An approved Decision needs a chosen option; `implemented` needs a follow-up reference.

Chronos shows tenant-scoped CLI commands beside organization intervention points. The HTTP view remains read-only; the commands enter through the governed organization facade.

## Learning candidates

Incidents, routine exceptions, project closures and governance decisions become learning candidates with `learning enqueue`. Triage them with `learning transition`: `proposed → approved → promoted`, or `→ rejected` with `--reason`. Promote only after the learning is written into `knowledge/` in the same tier and tenant, and pass that document as `--promoted-ref`. `status` lists candidates still waiting.

## Objectives and key results

Attach key results to an objective with `objective add` and `objective kr add`. A KR measures itself (`--metric-json` source `org_metric`, `file`, `probe` or `signal_ratio`) or takes values recorded by people (`manual`); `pnpm organization help` lists the shapes. KRs are measured automatically only while an active dot charter references the objective, so an organization run by hand measures on demand. Each KR is measured at most once per interval (`kr add --every <seconds>`, default 900); add `--force` to re-measure now, for example right after opening an incident. Objective lines show how old the oldest measurement is:

```bash
pnpm organization objective kr measure --organization-id ORG --tier confidential --tenant-slug TENANT --apply
pnpm organization objective kr record --organization-id ORG --tier confidential --tenant-slug TENANT \
  --objective-id OBJ --kr-id KR --value 30 --apply
```

`status` shows each objective's progress and the projects that point at it through `--objective-ids`. The walkthrough from objective to project is Step 11 of the [onboarding flow](./onboarding-flow.md).

## Members and roles

Link a chat or IdP identity to an existing member so team channels resolve the speaker: `pnpm organization member link-identity <member-id> --slack <user-id>` (or `--issuer <iss> --subject <sub>`; `unlink-identity` reverses it). Author roles with `pnpm organization role create --name <name> --domain <domain>` and grant authority with `role promote --role <role-id> --authority <authority-role-id>`.

## Subsidiaries

A subsidiary that does not warrant its own tenant is created under its parent's tenant and linked with `parent_organization_id`. The parent must exist in the same tier and tenant; a parent link is never a cross-tenant reference, and cycles are refused. Each organization keeps its own records, and `status` shows the parent and subsidiaries without merging them.

```bash
pnpm organization init --organization-id CHILD --name "<name>" --tier confidential --tenant-slug TENANT --parent-organization-id PARENT --dry-run
pnpm organization parent set --organization-id CHILD --tier confidential --tenant-slug TENANT --parent-organization-id PARENT --apply
pnpm organization parent set --organization-id CHILD --tier confidential --tenant-slug TENANT --clear --apply
```
