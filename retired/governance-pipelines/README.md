Retired v1 ADF samples that lived under `knowledge/product/governance/pipelines/`.
They used pre-AR-01 `type: capture|transform|apply` and bare ops (`log`, `shell`,
`git_checkpoint`) that the current pipeline engine does not execute.

Kept in the active folder only when a contract test, Chronos agent, or procedure
still names the file. As of 2026-09-16 the remaining v1 samples were retired
too; Chronos now points at current self-ops pipelines, and the generation
schedule example lives at `knowledge/product/governance/surfaces/generation-schedule.json`.

| Asset                                   | Rationale                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `macro-hello.json`                      | Echo toy.                                                                                      |
| `file-replace-text.json`                | Bare `read` / `regex_replace` / `write` ops.                                                   |
| `network-ip-grep.json`                  | Host `ifconfig` shell.                                                                         |
| `modeling-stack-analysis.json`          | Host `ls -F` shell.                                                                            |
| `system-tech-stack.json`                | Host `ls` + `regex_extract`.                                                                   |
| `system-pulse-audit.json`               | Bare `pulse_status` op.                                                                        |
| `orchestrator-checkpoint.json`          | Bare `git_checkpoint` op.                                                                      |
| `code-skill-audit.json`                 | Pre-AR-01 `discover_capabilities`; current path is `pipelines/list-capabilities.json`.         |
| `wisdom-sync-dates.json`                | Non-pipeline `reconcile` document; current path is `pipelines/knowledge-curation-weekly.json`. |
| `wisdom-sync-docs.json`                 | Shell wrapper around `sync_component_inventory.ts`.                                            |
| `modeling-graph.json`                   | Bare `read_json` / `mermaid_gen` ops.                                                          |
| `modeling-validate.json`                | Bare `ajv_validate` op.                                                                        |
| `physical-browser-system-sequence.json` | Demo for the retired physical-bridge actuator.                                                 |
