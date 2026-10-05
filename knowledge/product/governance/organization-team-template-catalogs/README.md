---
title: Organization Team Template Catalogs
category: Governance
tags: [governance, organization, team-template, catalog, overlay]
importance: 7
author: Ecosystem Architect
last_updated: 2026-10-05
---

# Organization Team Template Catalogs

Organization team template catalogs are overlays on top of the base
`mission-team-templates.json` file, which lives at
`knowledge/product/orchestration/mission-team-templates.json` (not in this
directory).
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
- `consulting-firm.json`
- `financial-services-backoffice.json`
- `it-managed-services.json`
- `marketing-agency.json`
- `saas-product-company.json`

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

### `consulting-firm.json`

- `organization_id`: `consulting-firm`
- `templates.default.optional_roles`: adds `devils_advocate`, `counterparty_persona`, and `scribe`
- `templates.default.lifecycle`: extends the default run budget
- `templates.operations.optional_roles`: adds `scribe`, `tracker`, and `surface_liaison`
- `templates.operations.lifecycle`: widens operations team capacity

### `financial-services-backoffice.json`

- `organization_id`: `financial-services-backoffice`
- `templates.operations.required_roles`: adds `operator` to the required team
- `templates.operations.optional_roles`: adds `planner`, `reviewer`, `scribe`, and `tracker`
- `templates.operations.lifecycle`: tightens parallelism while extending wall-clock and cooldown
- `templates.incident.optional_roles`: adds `planner`, `reviewer`, and `surface_liaison`
- `templates.default.optional_roles`: adds `reviewer` and `scribe`

### `it-managed-services.json`

- `organization_id`: `it-managed-services`
- `templates.operations.required_roles`: adds `operator` to the required team
- `templates.operations.optional_roles`: adds `planner`, `tester`, `tracker`, and `surface_liaison`
- `templates.operations.lifecycle`: extends the operations team run budget
- `templates.incident.required_roles`: adds `operator` to the required team
- `templates.incident.optional_roles`: adds `planner`, `reviewer`, and `surface_liaison`
- `templates.incident.lifecycle`: expands the incident response budget
- `templates.security_scan.optional_roles`: adds `reviewer` and `tracker`
- `templates.security_audit.optional_roles`: adds `devils_advocate`, `scribe`, and `tracker`
- `templates.security_audit.lifecycle`: expands the security audit budget

### `marketing-agency.json`

- `organization_id`: `marketing-agency`
- `templates.default.optional_roles`: adds `experience_designer`, `relationship_curator`, and `scribe`
- `templates.default.lifecycle`: extends the default run budget
- `templates.development.optional_roles`: adds `experience_designer` and `tester`

### `saas-product-company.json`

- `organization_id`: `saas-product-company`
- `templates.product_development.required_roles`: adds `tester` to the required team
- `templates.product_development.optional_roles`: adds `product_strategist`, `experience_designer`, and `operator`
- `templates.product_development.lifecycle`: extends the product development run budget
- `templates.development.optional_roles`: adds `tester`, `product_strategist`, and `devils_advocate`
- `templates.operations.optional_roles`: adds `tester`, `surface_liaison`, and `tracker`

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
