---
title: Project Operational State Store
category: Architecture
tags: [architecture, project, operational-state, tenant, distillation, active-projects]
importance: 9
author: Ecosystem Architect
last_updated: 2026-10-08
---

# Project Operational State Store

Kyberion keeps two different kinds of project information:

- **operational state**: the live working record for active projects, tracks, missions, and current status
- **knowledge**: distilled, reusable, tiered memory that is derived from the operational record

This split is intentional.
The operational store is where the system remembers what is currently happening.
The knowledge tier is where the system remembers what should be reused later.

## 1. Storage Contract

Primary operational state lives under:

```text
active/projects/<tier>/<tenant_or_shared>/<project_id>/state/
```

Recommended layout:

```text
active/projects/
  <tier>/
    <tenant_or_shared>/
      <project_id>/
        project-os/          # instantiated project documentation scaffold
        state/
          project-state.json  # canonical live project snapshot
          tracks/
            <track_id>/track-state.json
          task-sessions/
            <session_id>/session-link.json
          evidence/           # raw evidence, receipts, and operational snapshots
          distill/
            queue.jsonl       # optional distillation backlog / handoff notes
```

### Tier and tenant rules

- The first path segment after `active/projects/` is the tier: `personal`, `confidential`, or `public`.
- The second segment is the tenant scope.
- When a project is not tenant-bound, use `shared`.
- Tenant-scoped reads/writes should still respect the existing authority model and tenant drift controls.

## 2. Canonical Records

The canonical operational record is a snapshot, not a speculative plan.
It should capture the current state of the project as it exists in the workspace.

Minimum fields:

- project identity
- tenant scope when applicable
- tier
- current status
- active track ids
- active mission ids
- recent source references
- last updated timestamp

Recommended additional fields:

- current phase
- active task sessions
- knowledge references already distilled from this state
- distill targets
- metadata for project-specific extensions

## 3. Distillation Rule

Operational state is **not** the knowledge tier.

Use the operational store for:

- live progress
- current mission and track links
- task session links
- raw operational receipts
- current project status

Use knowledge for:

- stable findings
- reusable procedures
- architecture decisions
- incidents and lessons learned
- operator guidance

Distillation flow:

```text
active/projects/.../state/*
  -> review / checkpoint / distill
  -> knowledge/product/evolution/* or knowledge/product/incidents/*
  -> optionally update project docs and runbooks
```

The distillation step should preserve provenance back to the operational source.

## 4. Relationship to Project OS

`project-os/` is the instantiated document scaffold.
`state/` is the live operating record.

They are siblings, not competitors.

- `project-os/`
  - charter, design, runbook, test, gate, closure documents
- `state/`
  - current truth about what is active, what is linked, and what evidence exists

## 5. Mission and Track Links

The single source of project membership is each mission's own state:
`mission-state.json` `relationships.project` / `relationships.track`. Everything the project
side stores about its missions is a projection of that source, rebuilt on every mission sync
(`libs/core/project/project-mission-index.ts`):

- `project-state.json` — one file per project workspace; `active_mission_ids` /
  `active_track_ids` are the linked missions in an active status (planned, active,
  validating, distilling, paused). Finished missions leave the list.
- `track-state.json` — one file per track; `active_mission_ids` holds every active mission
  on the track (not only the last one synced).
- the project record's `active_missions` / `active_tracks` — the same projection
  (`pnpm project reconcile --apply` computes the identical result).
- `session-link.json` — one file per linked task session under the project workspace.

A mission can link only to a registered project (`[PROJECT_LINK_INVALID]` otherwise); it
inherits the project's tenant and organization. Finished missions are read from the
mission archive (`pnpm project show` lists them as `archived_missions`, next to the
project's artifact records). The former per-mission `mission-link.json` is no longer
written: nothing read it.

## 6. Why This Exists

Kyberion already has:

- missions for durable execution
- tracks for project lifecycle segmentation
- knowledge for distilled memory
- artifacts for concrete outputs

What it was missing was a clean place for:

- the current operational status of a project
- the live relationship between project, mission, and track
- tenant-aware project working state that is not yet knowledge

This store fills that gap.

## 7. Governed project and track lifecycle

Use `pnpm project archive <PROJECT_ID>` or
`pnpm project update <PROJECT_ID> --status archived` to archive a project.
Both paths use the same lifecycle checks. Active missions, live task sessions,
and unfinished tracks must be closed first; archiving never silently drops their
ownership links.

An archived project returns to active state only through
`pnpm project restore <PROJECT_ID>`. Restore validates the linked organization
and reconciles the operational snapshot. Name, summary, and other descriptive
fields can be edited while the project remains archived.

Track creation and mutation belong to the same project facade:

- `pnpm project track update --track-id <TRACK_ID> --name <NAME> --summary <TEXT>`
  edits descriptive fields. Release id, required artifacts, lifecycle model,
  locale and metadata can also be updated.
- `pnpm project track pause|resume|complete|archive --track-id <TRACK_ID>`
  changes lifecycle state; `track update --status <STATUS>` uses the same checks.
- A planned track may become active, completed or archived. An active track may
  become paused, completed or archived. A paused track may become active,
  completed or archived. A completed track may be archived. Archived tracks are
  terminal.
- Moving a track out of active state requires closing its live missions first.
  Mutation reconciles active track membership and selects an active replacement
  for the default track, or clears the default when none remains.

Project and track mutations require the mission owner: a worker view cannot
prove that sibling missions have finished. Lifecycle writes use scoped records,
audit events and rollback on reconciliation failure. IDs and ownership are immutable.
