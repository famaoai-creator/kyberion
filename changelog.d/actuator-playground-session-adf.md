---
category: Added
---

- **Playground sessions emit promoteable ADF** — `pnpm playground -- --record <name>` appends each successful live op to a session under `active/shared/tmp/actuator-playground/sessions/`, and `--emit-adf <name>` writes a PipelineAdf draft (`domain:op` steps with Typed Flow roles, shared `session_id` for browser sequences, sensitive params redacted into `{{placeholders}}`) ready for `pnpm pipeline:promote --input <file> --source-is-public`. `--record <name> --reset` restarts a session. This closes the gap where a multi-step playground success had no path into `pipelines/` without hand-authoring ADF.
