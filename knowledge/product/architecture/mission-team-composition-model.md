---
title: Mission Team Composition Model
kind: evergreen
scope: repository
authority: reference
phase: [alignment, execution]
tags: [mission, team-composition, authority-role, team-role, agents]
owner: ecosystem_architect
last_updated: 2026-11-23
---

# Mission Team Composition Model

Kyberion separates two kinds of roles:

- `authority_role`: permission boundary used by governance, `safe-io`, and actuator access policy
- `team_role`: functional responsibility used by Nerve when assembling a mission team

## Composition Flow

1. Resolve the mission template by `mission_type`
2. Expand required and optional `team_role` entries
3. Match each `team_role` against candidate agent profiles
4. Validate that the chosen agent exposes a compatible `authority_role`
5. Emit a `team-composition.json` artifact into the mission directory
6. When writing from CLI, execute with mission authority context. `scripts/compose_mission_team.ts --write` writes as `mission_controller`. It records the mission's Org Role (`--org-role`, else the mission state's `org_role`; `--persona` is a deprecated alias read for one release) in the plan's `org_role` field, and never copies it into the execution identity. A stored plan that still carries the old `assigned_persona` field is read as `org_role` for one release.

### Persona vs authority

- `org_role` (formerly `assigned_persona`) is mission metadata and prompt-shaping context.
- Mission file writes are governed by the process execution context (`MISSION_ROLE` / `KYBERION_BASE_ROLE`), not by the descriptive persona string stored in mission state.
- Mission lifecycle commands default to the safe worker persona. Use a more specific persona only when the mission explicitly needs that reasoning style.
- `Ecosystem Architect` remains the system-maintenance persona for product-level editing, but it should not be the default mission lifecycle persona.

## Lifecycle Guardrails

The composed team plan now carries a `team_governance` block with two concerns:

- `lifecycle`
  - per-template caps for parallel members, total members, message budget, wall-clock budget, and per-member turn budget
  - shutdown and resume policy used by mission control when a team is paused, handed off, or resumed
- `composition`
  - the required, optional, assigned, and unfilled roles for the current mission

This metadata is copied into `team-blueprint.json` so the runtime binding and audit trail keep the same lifecycle contract as the plan artifact.

## Runtime Orchestrator

Multi-step mission templates include an `orchestrator` team role between the
owner and execution workers. The owner retains final accountability; the
orchestrator supervises kickoff/follow-up sequencing, graph progress, retry /
replay decisions, provider degradation, and escalation. It does not author the
planner contract or mission deliverables.

The canonical role contract is
`knowledge/product/orchestration/team-roles/orchestrator.json`. The role is
staffed through the same composition path as other roles and is recorded in
`team-composition.json` and `staffing-assignments.json`.

## Indexes

- `knowledge/product/governance/authority-roles/` canonical directory, with `knowledge/product/governance/authority-role-index.json` as the compatibility snapshot
- `knowledge/product/orchestration/team-roles/` canonical directory, with `knowledge/product/orchestration/team-role-index.json` as the compatibility snapshot
- `knowledge/product/orchestration/agent-profiles/*.json` canonical
- `knowledge/product/orchestration/agent-profile-index.json` compatibility snapshot
- `knowledge/product/orchestration/mission-team-templates.json`

## Output Artifact

Each mission receives a `team-composition.json` file containing:

- selected template
- assigned and unfilled team roles
- selected agent, authority role, provider, and model
- required capabilities per role

This artifact is advisory for Nerve-driven staffing and makes team assembly explainable before delegation begins.

## Runtime Binding Artifacts

To keep planning and execution explicit, mission team data is split into three artifacts:

- `team-blueprint.json`
  - logical role design and delegation boundaries
  - lifecycle guardrails derived from `team_governance`
  - independent from who currently performs each role
- `staffing-assignments.json`
  - current role-to-actor mapping (`team_role -> actor_id`)
  - actor metadata such as authority role, provider, and model
- `execution-ledger.jsonl`
  - append-only record of actual execution events
  - always includes both logical role (`team_role`) and execution actor (`actor_id`)
  - post-verification evidence can be appended with `mission_controller record-evidence <MISSION_ID> <TASK_ID> "<NOTE>" --team-role <ROLE> --actor-id <ACTOR> --evidence <CSV>`

### Relationship to onboarding identities

| Stage            | Record                    | Identity relationship                                                                                                                                                                          |
| ---------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Onboarding       | Member and Agent Identity | The Member is the accountable human for the installed NHI. This relationship is recorded before a mission is created.                                                                          |
| Mission creation | `team-composition.json`   | The template supplies Team Roles. Composition selects compatible agent profiles, capabilities, and an Authority Role. The assignment's `agent_id` refers to the selected profile in this path. |
| Execution        | `execution-ledger.jsonl`  | The ledger records the Team Role, actor ID, and runtime identity when available. The runtime checks applicable to the operation govern whether the actor may execute.                          |

Staffing binds each role to a workforce resource in `staffing-assignments.json`.
Agent NHI derivation uses the mission tenant and organization context. A
tenantless mission derives a tenantless NHI. An explicitly supplied agent NHI
must use the mission tenant. Registry provisioning remains best effort.

When appending execution evidence, a supplied NHI must agree with the matching
staffing assignment and the stored mission tenant. If a historical assignment
contains an out-of-scope NHI, an event that omits its NHI can still be recorded
without copying that attribution. Historical ledger rows retain their evidence.

Mission creation passes mission type, tier, tenant, and organization context
to the composer. It does not pass the installed personal NHI as a worker
selection. When reading an assignment, follow its resource's
`runtime_identity` to the identity registry to determine whether it refers
to the same registered NHI. A matching conversational name or profile name
is insufficient. The scoped identity and its accountable Member are defined
in the [actor identity model](./actor-identity-and-responsibility-model.md).

For example, the installed assistant can help initiate a development mission.
The mission may staff an implementer and a reviewer from compatible profiles.
Each assignment records the work role and the staffed resource; the execution
ledger records who actually acted. The identity registry resolves each
agent's accountable human, and the review evidence establishes independence.

## Evaluation Feedback

Mission retrospective records objective `model × team_role` outcomes in
`active/shared/observability/retrospectives/model-role-outcomes.jsonl` and
aggregates them in `model-performance.json`. A user or operator may also
record a bounded 1–5 rating with `pnpm kyberion model feedback`; ratings are kept in a
separate append-only journal.

The learned score is deliberately bounded and ignored until the minimum sample
count is reached. It is a staffing hint only: explicit operator preferences,
capability matching, separation of duties, and governance policy remain
authoritative.

Relationship with project and mission layers:

- project: holds long-term goals and multiple missions
- mission: owns one blueprint and active staffing assignments
- task execution: appends fact records into execution ledger for audit and replay
