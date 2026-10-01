---
category: Fixed
---

- **Mission dispatch on local LLM backends** — route profile `timeout_ms` / `tools_enabled` / `allowed_tools` now reach the unscoped reasoning backend (previously resolved then dropped before construction), and the `agent-runtime-ensure-result` catalog accepts the team-composition fields emitted by runtime staffing (`role_sources`, `instance_of`, `instance_index`, `standby`, `model_hint.execution_tier`).
- **Shared-scope project repair** — `reconcileProjectOperationalState` no longer serializes the literal `shared` partition into `tenant_slug`, fixing a schema violation that crashed `project reassign-project` for shared-scope projects.
