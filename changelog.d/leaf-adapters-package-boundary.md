---
category: Changed
---

- Moved the Slack automation-blueprint formatter from `@agent/core/automation-blueprint-slack` into `@agent/shared-interaction/automation-blueprint-slack` beside the satellite reply helpers; the blueprint contract stays in core.
- Moved the dirty-tile describer inside `libs/actuators/vision-actuator/src/` next to the screen-delta perceptual-diff consumer, and published `@agent/core/foundation/project-scope-env` for the scope binding it resolves.
- Removed the `@agent/core/intake-vectors` subpath: the intake-vector enablement catalog is used only by `scripts/vault_mount_cli.ts`, so it now lives in `scripts/lib/intake-vectors.ts`.
