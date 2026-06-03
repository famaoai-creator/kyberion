---
title: Organization Profile Model
category: Architecture
tags: [architecture, organization, profile, mission, team, authority]
importance: 9
author: Ecosystem Architect
last_updated: 2026-05-31
---

# Organization Profile Model

## 1. Purpose

Kyberion needs an explicit organization layer above mission teams.

Mission teams are the execution unit.
The organization profile is the stable policy unit.

It answers:

- what kind of organization this is
- what defaults should govern missions and teams
- which backend preferences are allowed at the organization level
- how team templates should be selected by default
- which organization-specific team template catalog should be layered on top of the base templates

## 2. Relationship to Existing Models

This layer sits above:

- `organization-work-loop`
- `enterprise-operating-kernel`
- `mission-workflow-catalog`
- `mission-team-templates`
- `agent-profile-index`

The hierarchy is:

```text
Organization Profile
-> Organization Team Template Catalog
-> Mission Workflow Policy
-> Mission Team Template
-> Agent Profile
-> Runtime Execution
```

The important distinction is:

- organization profile: defaults, policy, boundaries
- organization team template catalog: organization-specific template overlays
- mission workflow: how work should flow
- team template: who should be present for a mission
- agent profile: who can fill a role

## 3. Why This Matters

If Kyberion is used as a company operating system, team composition alone is not enough.

Teams are too local.
Organizations need persistent defaults for:

- mission class defaults
- team template defaults
- backend preference overrides
- lifecycle policy
- operating principles

Without this layer, every mission must infer too much from scattered files.

## 4. Minimal Schema

The organization profile should minimally define:

- `organization_id`
- `name`
- `mission_defaults`
- `team_defaults`
- `team_template_catalog_id` if the organization needs a template overlay catalog
- `llm`
- `operating_principles`

This is intentionally small.

It is not a full org chart.
It is the governed default layer above missions and teams.

## 5. Resolution Order

For backend selection and similar configurable surfaces:

```text
user override
-> organization profile
-> governed policy
-> builtin fallback
```

This keeps user intent strongest while still allowing the organization to define stable defaults.

## 6. Implementation Notes

- Keep the profile declarative.
- Do not encode executable shell commands directly in the organization profile unless the field is explicitly an override surface.
- Use the profile as a source of defaults, not as a second parallel runtime.
- Teams should still be derived per mission, not pre-baked as rigid static org charts.

## 7. Companion Documents

- `knowledge/product/architecture/organization-work-loop.md`
- `knowledge/product/architecture/enterprise-operating-kernel.md`
- `knowledge/product/architecture/mission-team-composition-model.md`
- `knowledge/product/orchestration/organization-selection-guide.md`
- `knowledge/product/governance/organization-team-template-catalogs/README.md`
- `knowledge/product/governance/mission-workflow-catalog.json`
- `knowledge/product/orchestration/mission-team-templates.json`
- `knowledge/product/governance/organization-team-template-catalogs/*.json`
- `knowledge/product/orchestration/agent-profile-index.json`

Example catalogs currently documented:

- `default` for the base template set
- `demo-org` for development-heavy teams
- `ops-org` for operations and incident-heavy teams
