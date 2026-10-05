---
category: Fixed
---

- **Objectives show progress without a dot** — new `pnpm organization objective kr measure --organization-id <id> --tier <tier> [--tenant-slug <slug>] --dry-run|--apply` measures an organization's key results on demand, and `pnpm organization status` now prints each active objective with its key-result progress (`Objective: <title> — 50% (kr-a 100%, kr-b 0%)`) instead of the title alone. `pnpm organization help` lists the valid `--metric-json` shapes for `objective kr add`.
- **`pnpm mission create|kickoff --project-id` no longer needs `--project-path`** — the project-os path is taken from the project record (or its standard location); a project without one is told to run `pnpm project scaffold <id>`.
- **`pnpm work list-items` honours its filters** — `--project-id`, `--organization-id`, `--tenant-slug`, `--status` and `--board-id` were parsed and ignored; `create-item` now says it requires `--description`.
- **Onboarding flow Step 11** documents the path from objectives and key results to projects, missions and work items.
