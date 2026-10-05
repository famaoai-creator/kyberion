---
category: Fixed
---

- **Objectives show progress without a dot** — new `pnpm organization objective kr measure --organization-id <id> --tier <tier> [--tenant-slug <slug>] --dry-run|--apply` measures an organization's key results on demand, and `pnpm organization status` now prints each active objective with its key-result progress (`Objective: <title> — 50% (kr-a 100%, kr-b 0%)`) instead of the title alone. `pnpm organization help` lists the valid `--metric-json` shapes for `objective kr add`.
- **Key results can be recorded by hand** — `pnpm organization objective kr record --objective-id <id> --kr-id <id> --value <n> [--measured-at <iso>] --dry-run|--apply` writes a value measured outside Kyberion to the organization KR ledger, and the new `{"source":"manual"}` metric declares a KR that only such records move (sweeps skip it). `objective kr measure` now rolls up from the whole ledger, so recorded values count.
- **Projects can name the objectives they advance** — `pnpm project create|update --objective-ids <CSV>` stores `objective_ids` on the project record (each must be an objective of the project's organization), and `pnpm organization status` lists those projects under each objective.
- **`pnpm mission create|kickoff --project-id` no longer needs `--project-path`** — the project-os path is taken from the project record (or its standard location); a project without one is told to run `pnpm project scaffold <id>`.
- **`pnpm work list-items` honours its filters** — `--project-id`, `--organization-id`, `--tenant-slug`, `--status` and `--board-id` were parsed and ignored; `create-item` now says it requires `--description`.
- **Onboarding flow Step 11** documents the path from objectives and key results to projects, missions and work items.
