---
category: Fixed
---

- **`--emit-adf` no longer prints a promote command that cannot succeed** — the draft used to suggest `pnpm pipeline:promote --input <adf> --source-is-public`, which fails `[PIPELINE_PROMOTION_UNVERIFIED]` now that catalog promotion requires the engine run id. Emit instead prints the verified-evidence run card (project-trust request → human approve → `pnpm pipeline` run → `promote --run <run-id>`), reuses a still-valid approval for unchanged content, and adds a `--context '{...}'` hint when the draft declares `{{placeholders}}`.
- **`--emit-adf <name> --request-trust` opens the project-trust approval request in the same command**, so the operator only reviews and approves; the printed run command already carries the request id.
