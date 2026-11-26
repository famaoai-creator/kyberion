---
category: Fixed
---

- Pipelines that only read secrets no longer require a tenant reasoning credential (`CREDENTIAL_BINDING_REQUIRED`).
- `core:while` and `retry_until_quality` no longer stop on their second iteration with `[EXTERNAL_EXECUTION_ALREADY_RESERVED]`.
- Pipeline-declared browser `options` and `session_id` now reach each browser step. They come only from the pipeline file; run-time context cannot loosen navigation rules.
- Only allowlisted browser options apply, and a persistent profile or video recording applies only inside the file's own partition (`active/shared/runtime/browser/profiles/<tier>/<tenant|shared>/`, `active/shared/artifacts/<tier>/<tenant|shared>/browser-video/`). Other declared options (CDP attach, `launch_args`, registered Chrome profiles, `record_trace`, profiles elsewhere) are dropped with one warning per run, as before, and `pnpm pipeline check` lists them in a `browser` row.
- The Run Manifest now carries `browser_profile` / `browser_recording` for a confined persistent profile or recording, so a pipeline that sets one gets a new manifest hash and needs a new project-trust approval.
- A run recorded just before UTC midnight keeps its manifest pre-approval for steps after midnight.
- A run-manifest binding now always takes its bind time from the clock when it is installed. A caller can no longer pass an earlier date to reuse a run id recorded on a previous day and skip the daily run cap.
- A plugin can no longer register an operation under the name of a built-in actuator operation (for example `browser:goto`). Registration now fails with `[OP_REGISTRY_PLUGIN_CONFIG] … is a built-in actuator operation`; built-in ops keep their governed implementation and browser input confinement. New actions on a built-in domain are still allowed.
