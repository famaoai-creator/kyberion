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
