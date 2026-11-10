---
category: Changed
---

- `security-policy.json` `project_permissions.<project>.allowed_personas` is renamed `allowed_base_roles` (same values). An installation catalog that still declares `allowed_personas` is read for one release when `allowed_base_roles` is absent; a non-array value admits nothing.
