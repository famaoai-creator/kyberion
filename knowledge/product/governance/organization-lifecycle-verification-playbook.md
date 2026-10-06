---
title: Organization Lifecycle Verification Playbook
tags: [organization, project, operation, verification, governance, onboarding]
last_updated: 2026-10-06
---

# Organization lifecycle verification playbook

How to take one organization from formation through project composition to routine
operations, verifying that Kyberion works as a sustainable operations platform.
This is the exact procedure used for the `org-verify-20260928` acceptance run
(tenant `default`, tier `confidential`).

Start here when setting up an organization for the first time. For day-to-day
operation afterwards (scheduled cadences, deadlines, the daily digest,
objectives and key results, members, roles, subsidiaries), use the
[Organization Operations Runbook](./organization-operations-runbook.md).

## Prerequisites

- Writes under `active/organizations/` are authority-gated; without an
  authorized principal you get a `POLICY_VIOLATION`. For your own tenant's
  confidential or public organization state, prefer the least-privilege
  `MISSION_ROLE=organization_operator` with `KYBERION_TENANT=<slug>`. It cannot
  write another tenant, the personal tier, or `knowledge/`.
- Reserve `KYBERION_PERSONA=sovereign` for steps that need more: listing
  tenants, personal-tier organizations, cross-tenant views, and `project create`
  (step 5). The commands below use `sovereign` because the acceptance run did;
  for routine single-tenant work, substitute the operator role.
- Pick a **registered** tenant slug (`KYBERION_PERSONA=sovereign pnpm tenant list`).
  `public`, `confidential`, `personal`, and `shared` are reserved
  tier/partition names and are never valid tenants.
- Always try `--dry-run` before `--apply` on every authoring command.

## Step-by-step flow

### 1. Form the organization

```bash
KYBERION_PERSONA=sovereign pnpm organization init --organization-id <org> --name "<name>" \
  --tier confidential --tenant-slug <slug> --purpose "<purpose>" \
  --principle "<principle>" --owner-role ops_owner --dry-run --json
# then the same with --apply
```

### 2. Add domain, service, and service health

```bash
KYBERION_PERSONA=sovereign pnpm organization domain add --organization-id <org> \
  --tier confidential --tenant-slug <slug> --domain-id <dom> --name "<name>" \
  --owner-role ops_owner --apply --json

KYBERION_PERSONA=sovereign pnpm organization service add --organization-id <org> \
  --tier confidential --tenant-slug <slug> --service-id <svc> --domain-id <dom> \
  --name "<name>" --outcome "<outcome>" --owner-role ops_owner --consumer <team> --apply --json

# Declare runtime health (reconcile never infers health from absence).
KYBERION_PERSONA=sovereign pnpm organization service state set --organization-id <org> \
  --tier confidential --tenant-slug <slug> --service-id <svc> --health-status healthy \
  --reconcile-status current --freshness-seconds 3600 --confidence 0.9 --apply --json
```

Note: `--freshness-seconds` starts decaying immediately; a stale service is
reported by `reconcile` as `stale_services` (expected governance signal, not a bug).

### 3. Register a scheduled operation

```bash
KYBERION_PERSONA=sovereign pnpm organization operation add --organization-id <org> \
  --tier confidential --tenant-slug <slug> --operation-id <op> --name "<name>" \
  --operation-type scheduled --owner-role ops_owner --service-id <svc> \
  --trigger-kind schedule --trigger-expression "0 9 * * *" --timezone Asia/Tokyo \
  --execution-kind pipeline --execution-ref "pipelines/baseline-check.json" \
  --record-status active --apply --json
```

The operation definition holds the `pipelines/` execution target. Individual run
records cite **evidence inside the operation scope** instead (see §5).

### 4. Add governance cadence and drive a decision through its lifecycle

```bash
KYBERION_PERSONA=sovereign pnpm organization cadence add --organization-id <org> \
  --tier confidential --tenant-slug <slug> --cadence-id <cad> --name "<name>" \
  --cadence-type weekly --schedule "<schedule>" --owner-role ops_owner \
  --record-status active --apply --json

# New decisions ALWAYS start as proposed (omit --record-status or pass 'proposed').
KYBERION_PERSONA=sovereign pnpm organization decision add --organization-id <org> \
  --tier confidential --tenant-slug <slug> --decision-id <dec> --cadence-id <cad> \
  --title "<title>" --decision-owner ops_owner --due-at <iso> \
  --option <a> --option <b> --apply --json
```

Decision lifecycle (one step at a time; the CLI prints this on invalid transitions):

```text
proposed -> pending_approval -> approved -> implemented
side branches: proposed/pending_approval -> deferred -> pending_approval
terminal:      pending_approval -> rejected
```

Approving additionally requires `--rationale` and `--approval-ref <channel:id>`;
`implemented` requires a `--follow-up-ref`.

Incident lifecycle for reference:

```text
detected -> triaging -> mitigating -> resolved -> closed
(triaging may go directly to resolved; closing requires a post-incident review ref)
```

### 5. Compose the project (auto-attaches to the organization)

```bash
# Sovereign is required: project creation updates organization state.
KYBERION_PERSONA=sovereign pnpm project create --project-id <prj> --name "<name>" \
  --summary "<summary>" --tier confidential --tenant-slug <slug> \
  --organization-id <org> --json

pnpm project track create --track-id <trk> --project-id <prj> \
  --name "<name>" --summary "<summary>" --json
```

`project create --organization-id` attaches automatically — a separate
`organization project attach` is only needed for projects created without an
organization (attaching twice errors with a hint).

### 6. Record a run, then tick the schedule

```bash
# succeeded runs REQUIRE --evidence-ref: an existing file inside the operation scope,
# e.g. a trace log. The pipelines/ ref lives on the operation definition, not here.
KYBERION_PERSONA=sovereign pnpm organization operation run record \
  --organization-id <org> --tier confidential --tenant-slug <slug> \
  --operation-id <op> --run-id <op>-<yyyymmdd> --run-status succeeded \
  --result-summary "<summary>" \
  --evidence-ref "active/shared/logs/traces/traces-<yyyy-mm-dd>.jsonl" --apply --json
```

`ticks` (and `execute`) on confidential/personal tiers require a matching scope
selection first — even for `--dry-run`:

```bash
pnpm scope use --tier confidential --tenant <slug> --organization <org>
KYBERION_PERSONA=sovereign pnpm organization operation tick \
  --organization-id <org> --tier confidential --tenant-slug <slug> --dry-run --json
pnpm scope clear   # restore the default scope when finished
```

`ticks` performs one catch-up run per due operation; right after a recorded run it
correctly reports `"due": []` with the next due date projected.

### 7. Exercise incident, learning, and reconciliation

```bash
# Incident (detected -> triaging -> ...).
KYBERION_PERSONA=sovereign pnpm organization incident add --organization-id <org> \
  --tier confidential --tenant-slug <slug> --incident-id <inc> --title "<title>" \
  --severity low --owner-role ops_owner --impact-summary "<text>" \
  --service-id <svc> --apply --json

# Learning candidates use closed vocabularies:
#   --source-type: incident_review|routine_exception|project_closure|governance_decision
#   --target-kind: pattern|sop_candidate|knowledge_hint|report_template
KYBERION_PERSONA=sovereign pnpm organization learning enqueue --organization-id <org> \
  --tier confidential --tenant-slug <slug> --learning-id <learn> \
  --source-type routine_exception --source-ref <run-id> --title "<title>" \
  --summary "<summary>" --target-kind pattern \
  --evidence-ref "active/shared/logs/traces/traces-<yyyy-mm-dd>.jsonl" --apply --json

# Governance health check and projections.
KYBERION_PERSONA=sovereign pnpm organization reconcile --organization-id <org> \
  --tier confidential --tenant-slug <slug> --dry-run --json
KYBERION_PERSONA=sovereign pnpm organization status --organization-id <org> \
  --tier confidential --tenant-slug <slug> --json
KYBERION_PERSONA=sovereign pnpm organization lineage --organization-id <org> \
  --tier confidential --tenant-slug <slug> --json
pnpm project show <prj> --json
pnpm project reconcile <prj> --dry-run --json
```

`reconcile: attention` with `stale_services` / `pending_decisions` entries is the
governance working as intended — clear them by refreshing service state and
advancing decisions.

## Evidence and logging conventions

- Every pipeline execution appends to `active/shared/logs/traces/traces-<date>.jsonl`.
- Cite the trace file as `--evidence-ref` on run records and learning candidates
  so each operational fact links back to its raw log.
- Organization state lives under
  `active/organizations/<tier>/<tenant>/<org>/state/`; project registry under
  `active/projects/<tier>/<tenant>/<project>/`. Both are gitignored runtime
  state — verification runs leave no tracked-tree pollution (`git status` clean).
- Never create ad-hoc directories for residue: runtime residue under reserved
  tenant paths (`*/shared/`) or unregistered slugs is rejected by current
  validation and only confuses operators.

## Troubleshooting (first-run friction log, 2026-09-28)

| Symptom                                                                            | Cause                                                                           | Fix applied                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid tenant slug 'shared'`                                                     | Reserved partition name used as tenant                                          | Error now names the reserved set and points at `KYBERION_PERSONA=sovereign pnpm tenant list` to find a valid `--tenant-slug`; empty residue dirs under `*/shared/` and unregistered slugs removed |
| `decision add --record-status decided` rejected                                    | New decisions must start `proposed`; no `decided` state exists                  | Error now shows the full transition path and approval requirements; `usage()` Notes document the lifecycle                                                                                        |
| `proposed -> decided` transition rejected                                          | Must advance one step (`pending_approval` next)                                 | Transition errors now list allowed next states plus the full lifecycle diagram (decisions and incidents)                                                                                          |
| `project create` → `POLICY_VIOLATION`                                              | Organization-state write needs sovereign                                        | Documented in flow (§5); `usage()` Notes cover it                                                                                                                                                 |
| `project attach` → `already attached`                                              | `project create --organization-id` auto-attaches                                | Error now says no action is needed and when a separate attach applies                                                                                                                             |
| `run record --run-status succeeded` rejected                                       | `--evidence-ref` mandatory for success                                          | Error now shows the expected flag and an example trace path                                                                                                                                       |
| `execution ref must be an existing path within the operation scope: pipelines/...` | Run refs are scope-restricted; `pipelines/` belongs on the operation definition | Error now lists the allowed prefixes and explains the definition-vs-evidence split                                                                                                                |
| `operation tick` → scope error (even `--dry-run`)                                  | Confidential/personal execution needs `pnpm scope use` first                    | Error now prints expected vs actual scope and the exact `scope use` command; `usage()` Notes document it                                                                                          |
| `Invalid organization learning candidate: /source_type ...`                        | Closed enum vocabularies                                                        | Error appends the allowed values; `usage()` line shows the enums inline                                                                                                                           |
