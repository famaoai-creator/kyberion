---
title: Mission Team Composition Model
kind: architecture
scope: repository
authority: reference
phase: [alignment, execution]
tags: [mission, team-composition, authority-role, team-role, agents]
owner: ecosystem_architect
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
6. When writing from CLI, execute with mission authority context. `scripts/compose_mission_team.ts --write` resolves the mission's assigned persona and applies it for governed writes.

## Indexes

- `knowledge/public/governance/authority-role-index.json`
- `knowledge/public/orchestration/team-role-index.json`
- `knowledge/public/orchestration/agent-profile-index.json`
- `knowledge/public/orchestration/mission-team-templates.json`

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
  - independent from who currently performs each role
- `staffing-assignments.json`
  - current role-to-actor mapping (`team_role -> actor_id`)
  - actor metadata such as authority role, provider, and model
- `execution-ledger.jsonl`
  - append-only record of actual execution events
  - always includes both logical role (`team_role`) and execution actor (`actor_id`)
  - post-verification evidence can be appended with `mission_controller record-evidence <MISSION_ID> <TASK_ID> "<NOTE>" --team-role <ROLE> --actor-id <ACTOR> --evidence <CSV>`

Relationship with project and mission layers:

- project: holds long-term goals and multiple missions
- mission: owns one blueprint and active staffing assignments
- task execution: appends fact records into execution ledger for audit and replay
