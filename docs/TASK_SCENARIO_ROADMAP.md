# TaskScenario Roadmap

TaskScenario is the task-first entry point for trying one repeatable workflow from the command line.

Use this roadmap when you want the shortest path from discovery to a dry-run preview.

## Current flow

1. Discover available tasks with `pnpm task:list`.
2. Initialize a saved profile with `pnpm task:init <task-id> --answers-json '<json>'`.
3. Review the dry-run plan with `pnpm task:run <task-id> --dry-run`.

## Quickstart

The copy-paste quickstart lives here:

- [TaskScenario Quickstart](./TASK_SCENARIO_QUICKSTART.md)

## Safety boundary

- `task:run` is currently dry-run only.
- No email, Slack, or other external send happens automatically.
- The roadmap describes the user flow only; it does not change runtime behavior.

## Related docs

- [Scenario Catalog](./SCENARIO_CATALOG.md)
- [Use-Case Quickstarts](./user/USE_CASE_QUICKSTARTS.md)
