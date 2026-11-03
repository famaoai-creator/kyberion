---
category: Fixed
---

- Repair main baseline so CI gates pass again: register `generate:governance-import-baseline` and `generate:platform-read-baseline` in the CLI command manifest (and raise the SX-05 package-script ratchet to 141), migrate both baseline generators to the `defineGenerator` harness (fixes script-integrity, `json_state_write_budget` and `bespoke_cli_parser_budget`), remove real-time sleeps from `lease-backend` KV interleave test (deterministic deferred gate), and regenerate `CLI_REFERENCE.md` / vocabulary types / pseudo-locale.
