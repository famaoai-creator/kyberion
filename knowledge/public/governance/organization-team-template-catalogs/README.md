---
title: Organization Team Template Catalogs
category: Governance
tags: [governance, organization, team-template, catalog, overlay]
importance: 7
author: Ecosystem Architect
last_updated: 2026-05-31
---

# Organization Team Template Catalogs

Organization team template catalogs are overlays on top of the base `mission-team-templates.json` file.
They are selected by `organization-profile.team_defaults.team_template_catalog_id`.

## How They Work

1. Kyberion loads the base mission team templates.
2. It checks the active organization profile for `team_template_catalog_id`.
3. If a matching catalog exists, it overlays only the template entries listed in that catalog.
4. Unspecified templates remain unchanged.

This means a catalog is a specialization layer, not a replacement layer.

## Catalog Files

- `default.json`
- `demo-org.json`
- `ops-org.json`

## Current Examples

### `default.json`

- `organization_id`: `default`
- `templates`: empty
- effect: use the base templates as-is

### `demo-org.json`

- `organization_id`: `demo-org`
- `templates.development.optional_roles`: adds `operator` and `surface_liaison`
- `templates.development.lifecycle`: increases team capacity and run budget

### `ops-org.json`

- `organization_id`: `ops-org`
- `templates.operations.optional_roles`: adds `tester`, `surface_liaison`, and `decision_maker`
- `templates.operations.lifecycle`: extends the operations team run budget
- `templates.incident.optional_roles`: adds `planner`, `tester`, and `surface_liaison`
- `templates.incident.lifecycle`: expands the incident response budget

## When to Add a New Catalog

Add a new catalog when an organization needs:

- different optional roles
- different lifecycle limits
- different template defaults for a mission class
- a more opinionated team shape without forking the base template catalog

## Related Docs

- [Organization Selection Guide](../../orchestration/organization-selection-guide.md)
- [Organization Profile Model](../../architecture/organization-profile-model.md)
- [Mission Team Templates](../../orchestration/mission-team-templates.json)
