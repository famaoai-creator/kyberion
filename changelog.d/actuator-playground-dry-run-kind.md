---
category: Fixed
---

- **Unknown `--actuator` is reported by name in machine mode** — `--actuator typo --op read --check --json` now returns `Unknown --actuator 'typo'` with the available ids instead of `Machine mode requires --actuator and --op`.
- **`--dry-run` actually runs wrapped capture ops** — `resolveCliActionKind` reads the step type of one-step pipeline envelopes (`buildSingleOpPipelinePayload`), so `pnpm playground -- --actuator file-actuator --op read --dry-run` executes the read instead of reporting `kind: apply, validate-only`. Multi-step pipelines keep the conservative `apply` default. The fix also applies to `pnpm kyberion run … --dry-run` and `createStandardYargs`-based actuator CLIs.
