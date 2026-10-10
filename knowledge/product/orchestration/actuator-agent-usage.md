---
title: Agent-facing actuator discovery and usage
tags: [actuator, agent, browser-use, computer-use, discovery, cli]
last_updated: 2026-10-10
role_affinity: [implementer, operator, worker]
phase_affinity: [alignment, execution]
---

# Agent-facing actuator usage

Choose an executor by target, discover its contract, then observe → act → verify.
Use the existing pipeline for repeatable work. During exploration, describe one
operation instead of loading the entire catalog into the model context.

## Discover without execution

```sh
pnpm playground -- --list --search browser --json
pnpm playground -- --actuator browser-actuator --op snapshot --describe --json
pnpm playground -- --actuator agent-actuator --op snapshot --describe --json
```

`--list` optionally filters by actuator, exact `--op`, or case-insensitive
`--search` over actuator/operation names. `--describe` requires actuator and op.
Both are read-only, noninteractive and never invoke a handler or build actuators.
The list shows operation names and kinds; description shows catalog schemas,
examples and forwarding/deprecation metadata when present.
Discovery is metadata, not a readiness or permission probe.
Use `pnpm capabilities --json` for platform, binary and environment prerequisites.

## Check the input before applying it

```sh
pnpm playground -- --actuator agent-actuator --op snapshot --params '{}' --check --json
```

This intentionally invalid example reports the missing `agentId` without invoking
the handler. Supply parameters from `--describe`, then check again. `--check`
never runs the handler. `parameter_validation: authored-schema` means the
authored parameter schema was checked; `not-available` means no authoritative
parameter schema was available. Inferred/legacy schemas and examples are hints,
not proof that every field is valid. The runtime remains the authority.

`--dry-run` can execute capture operations. Use `--check` for zero execution.
For an authorized live call, omit `--check` and keep `--json`. Fine-grained
pipeline operations are wrapped into the existing one-step pipeline contract.
Malformed authored inputs are rejected before execution. Approval and tenant
scope continue to be enforced by the existing runtime.

## Choose the target and close the observation loop

| Target               | First choice                                   | Observation and recovery                                                                                                                   |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Web page             | `pnpm kyberion browser run` / browser-actuator | Observe a fresh snapshot; act on a unique ref; observe the changed page. Re-snapshot after navigation or stale refs.                       |
| Desktop app          | system-actuator `computer_interaction`         | Activate and verify the intended app/window, inspect a redacted screenshot, act, capture again. Coordinates belong to the current display. |
| Interactive terminal | terminal-actuator                              | Retain the session identifier, write once, poll output, verify exit/result before retrying.                                                |
| File/document/media  | Exact actuator op or perception CLI            | Verify the produced artifact using `read`, `see`, `listen` or `watch`.                                                                     |

For browser interactions retain one session through discovery and action;
separate one-shot playground calls do not imply a persistent browser session.
Follow [browser discovery](browser-discovery-playbook.md),
[browser operating checks](browser-automation-best-practices.md) and
[action executor selection](action-playbook.md).

Define success before acting. A process exit or receipt does not prove the user
outcome. If send/delete/purchase times out, reconcile the observed effect before
retrying; use the same approval boundary during recovery.

## Comparison informing this change

This is a comparison of published interfaces, not an execution benchmark.

| Interface              | Useful agent affordance                                                                   | Kyberion application                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic computer use | Small screenshot/mouse/keyboard tool surface with an observation loop                     | Keep the existing desktop bridge; document observe → act → verify and target/focus checks.                                       |
| Browser Use            | BrowserSession lifecycle, CDP attachment and structured ActionResult content/error fields | Retain browser session identity; expose just the relevant operation contract; distinguish validation from execution readiness.   |
| Kyberion actuators     | Deterministic ops across targets, scoped execution and governed pipelines                 | Add noninteractive list/describe and authored parameter preflight to the existing playground rather than another dispatch layer. |

Sources checked on 2026-10-10:
[computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool),
[Browser Use browser configuration](https://github.com/browser-use/browser-use/blob/main/skills/open-source/references/browser.md),
[Browser Use result format](https://docs.browser-use.com/open-source/customize/tools/response).

## Live operation checks and recovery

`click_ref` and `fill_ref` expose authored schemas: provide a nonempty `ref` from
the latest snapshot, and `text` for filling. Both the supplied text and its
resolved template value must be strings; explicit `""` clears the field, while
omitted, null and numeric values fail before filling. Browser pipelines accept both short
operation names and the `browser:` namespace. Ordinary clicks reject multiple
matches; use a unique ref or deliberately choose `click_first_match`. That
operation fails when no visible target matches.

Resident actuator responses report `ok: false` for failed or denied results.
One-shot commands preserve the failure result and exit nonzero. Playground JSON
also keeps child stdout/stderr on failure; inspect the result rather than treating
process completion as success. Live execution reports the actual handler kind.

Terminal sessions may use a pipe fallback when native PTY is unavailable. Resize
then fails explicitly. A missing session is a failure, with guidance to list or
create sessions; polling an exited session retains its exit code until cleanup.
An exit code such as 7 is evidence of command failure even when polling succeeds.

Re-run the safe synthetic browser and terminal scenarios after building core and
actuators:

```sh
node --import ./scripts/ts-loader.mjs scripts/browser_actuator_usability_probe.ts --json
node --import ./scripts/ts-loader.mjs scripts/terminal_actuator_usability_probe.ts --json
```

The browser probe checks 15 patterns including Unicode, keyboard input, omitted fill values,
nullable templates, explicit clearing, ambiguous
targets, delayed elements, timeout recovery, re-observation and tab switching.
The terminal probe checks 12 patterns including Unicode, incremental output,
exit codes, missing sessions and resize capability. Both return `report_path`,
write evidence under `active/shared/tmp/`, and clean up their own sessions.
Native PTY resize and real desktop GUI interactions still need host-specific live
checks. Many other parameter schemas remain inferred hints rather than authored
contracts.
