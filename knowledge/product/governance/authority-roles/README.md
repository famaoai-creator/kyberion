---
title: 'Authority Roles'
last_updated: 2026-11-10
---

# Authority Roles

Canonical per-role files live in this directory.

This directory is the only Authority Role registry (concept model v2 D6).

- File name must match the role id.
- Each file contains one authority role card: the catalog profile (`description`, `default_persona`, `write_scopes`, `scope_classes`, `allowed_actuators`, `tier_access`) and the role's path `permissions`.
- A process role sets `"assignable": false`: it is assumed by a script or service only, carries no profile, and is never offered to teams, organizations or dots.
- `knowledge/product/governance/authority-role-index.json` (the assignable roles) and `security-policy.json` `authority_role_permissions` (every card's `permissions`, verbatim) are generated. Edit the card, then run `pnpm kyberion sync authority-roles`; `--check` and the `governance-rules` gate fail on drift.
