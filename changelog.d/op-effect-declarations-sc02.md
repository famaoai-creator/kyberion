---
category: Added
---

- **Op effect declarations (SC-02)** — every actuator manifest capability now declares a side-effect class (`read` / `write` / `egress` / `none`), with optional `effect_from` / `resource_ref_from` input paths. A new `core:effect` preflight stage resolves the class (undeclared ops fail-safe to `write`) and stamps `_effect`/`_resource_ref` onto the call for downstream stages; `service:api` GET calls refine to `read` via `effect_from`. A new `check:op-effect-coverage` gate enforces declarations on all 267 capabilities.
