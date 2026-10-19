---
category: Added
---

- **CI failure triage** — `pnpm kyberion ci triage [log-file ...] [--job <name>] [--json]` classifies a red CI log (`generated-drift`, `ratchet/registration`, `gate-failure`, `test-failure` with a suspected-flake mark, `platform`, `infra`, `unknown`) and prints the exact next command per failure. Every main CI / PR Validation / Cross-OS job now writes that triage to its job summary on failure, and the new `main-failure-triage.yml` workflow opens or updates one `ci-main-red` issue per failing signature when CI or Cross-OS Smoke goes red on `main`.
