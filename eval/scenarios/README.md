---
title: Executable scenarios (pnpm scenario)
tags: [scenarios, eval, testing, fixtures, approvals, ci]
last_updated: 2026-09-24
---

# Executable scenarios

Each `*.json` file here is a `kyberion-scenario.v1` definition
(`knowledge/product/schemas/kyberion-scenario.schema.json`). The runner executes
its turns against the real pipeline engine in-process, serves ops from
fixtures, and asserts on what actually happened.

```bash
pnpm scenario run eval/scenarios --lane pr-deterministic      # the PR gate
pnpm scenario run eval/scenarios/03-approval-approved-transition.json --keep --export-trajectory
pnpm scenario run eval/scenarios --json                        # machine-readable summary
```

Exit code is 1 when any scenario is `fail` or `error`; `skipped` and
`lane_skipped` never fail. Reports go to
`active/shared/tmp/scenario-reports/<run-id>/report.{json,md}` (plus
`trajectory.jsonl` with `--export-trajectory`). The run root
`active/shared/tmp/scenarios/<run-id>/` is removed after each run unless
`--keep` / `KYBERION_SCENARIO_KEEP_ROOT=1` is set. `KYBERION_SCENARIO_LANE`
sets the default `--lane`.

## Starter suite

All five are `pr-deterministic`, `simulated` and `model-free` (a reasoning call
fails the run).

| File                                       | Proves                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `01-pipeline-stubbed-apply.json`           | A fixture-served apply op is called once with params resolved from a prior step |
| `02-approval-rejected-no-side-effect.json` | A rejected approval blocks the op and it never executes                         |
| `03-approval-approved-transition.json`     | pending → approved lets the retry apply exactly once                            |
| `04-unstubbed-op-fails-closed.json`        | An op without a fixture fails closed (`[SCENARIO_UNSTUBBED_OP]`), never runs    |
| `05-trace-span-and-artifact.json`          | Executed ops leave trace spans; seed and turn artifacts exist in the run root   |

Pipelines used by pipeline turns are in `fixtures/` (paths are relative to the
scenario file). The runner only picks up top-level `*.json` files.

## Writing a scenario

- **Lane**: `pr-deterministic` scenarios must be `simulated`, declare
  `modelFixtures`, and cannot use `intent` turns or judges. Omitting `lane`
  means `live-only`. `live-only` scenarios with intent turns or judges are
  `skipped` when no live / judge backend is available; unmet `requires` and
  `deferred` also mean `skipped`.
- **Fixtures**: in the `simulated` profile every leaf op needs a
  `fixtures.ops["domain:action"]` entry (`result`, `ctx_patch` or `error`),
  except `system:log`, `core:transform` and `reasoning:*`.
- **Turns**: `pipeline` (`pipeline` file or inline `steps`; `expectError` makes
  it a negative turn that must fail with that substring), `advance_clock`
  (virtual clock), `approval_decision`, and `intent` (live-only).
  Per-turn `checks`: `expectedOps`, `forbiddenOps`, `responseMatchers` (dot path
  into the pipeline's final context), `judge` (live-only).
- **Final checks**: `opCalled`, `opNotCalled`, `opArgs` (JSON subset of the
  redacted params), `approvalRequested`, `approvalTransition`,
  `noSideEffectOnReject`, `artifactExists` (relative to the run root; each
  pipeline turn writes its redacted final context to `turns/<index>.context.json`),
  `traceSpanExists` (op spans are named after the op; each turn has a
  `scenario.turn` span).
- Pipeline turns receive `scenario_id` and `scenario_run_root` (repo-relative)
  in their context.

Reports carry `evidence_class: "simulated"` for simulated runs; evidence
intakes reject them (`assertNotSimulatedEvidence`).
