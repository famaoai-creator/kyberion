---
title: Computer-Use Ref Identity Audit
kind: architecture
scope: repository
authority: reference
phase: [alignment, execution, review]
tags: [computer-use, browser, actuator, snapshot, ref, secret, replay]
owner: ecosystem_architect
last_updated: 2026-09-13
---

# Computer-Use Ref Identity Audit

Audit of `computer_interaction` / computer-use paths against the browser
`export_adf` failure classes fixed on PR #733 (open on
`cursor/fix-browser-export-adf-replay-c09b` at the time of this note).

## Shared with browser export vs computer-use-specific

| Surface                                                            | Shared with `export_adf` / PR #733? | Notes                                                                                                                                                       |
| ------------------------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser-runtime-helpers.renderBrowserAdf` / `parseRecordedAction` | No                                  | Computer-use does not call `export_adf`. Trail export is a browser pipeline transform.                                                                      |
| `resolveRefOrRecordedTarget`                                       | Yes (apply path)                    | After translation, `click_ref` / `fill_ref` / `fill_secret_ref` run through the same resolver. On `main`, a `ref_map` hit skipped `dom_path` corroboration. |
| `translateComputerInteractionToBrowserAction`                      | Computer-use only                   | Not touched by #733. This is the live observe/act lowering.                                                                                                 |
| Terminal `computer_interaction`                                    | N/A                                 | PTY spawn/poll/write. No `@eN`, no DOM refs.                                                                                                                |
| System / desktop `computer_interaction`                            | N/A                                 | Coordinates + remembered focus. No `@eN` remint. `type_into_focused_input` is plaintext `text` (no `secret_ref`).                                           |
| Chronos Computer Sessions                                          | Inspection only                     | Lists sessions / screenshots / action counts. Does not replay refs.                                                                                         |
| Browser conversation candidate execute                             | Related, out of scope               | Inserts `snapshot` then `click_ref({ref: element_id})` with `keep_alive: false`. Same remint class; left for a follow-up.                                   |

## Failure modes from the browser export lesson

### 1. Export dropped durable identity — does not apply 1:1

Computer-use has no `export_adf`. The contract is a live observe/act loop.
Replay of a stored `computer_interaction` payload is "send the same action
again." The schema (`additionalProperties: false`) previously could not carry
`selector` / `name` / `role` / `dom_path` / `secret_ref`, so a recorded
`click_ref({ref:'@e1'})` had no durable target to replay.

### 2. Secret fills need `requireDomPathMatch` + `dom_path` — applied

The schema had no `fill_secret_ref`. A password typed through `fill_ref.text`
would be recorded on the trail as plaintext. Translation now accepts
`fill_secret_ref` / `fill_ref` + `secret_ref`, requires a corroborating
`selector` or `dom_path`, and lowers to pipeline `fill_secret_ref` (which
already sets `requireDomPathMatch: true`).

### 3. Blocking: remint snapshot then apply recorded `@eN` — applied (live loop)

This **did** copy. The translator always inserted:

```text
snapshot → click_ref|fill_ref|…({ref:'@eN'})
```

`buildSnapshot` assigns `@e${index+1}` by current visible interactive order.
A new `@e1` is not the observation-time field. `keep_alive` already restores
the last observation's `ref_map`; the inserted snapshot overwrote it.

Same-session keep_alive after an explicit `snapshot` action is the intended
live loop. Fresh-session replay of `@eN` without durable identity must fail
closed (`Unknown browser ref`), not remint as a stand-in.

## What was fixed

- Stop reminting before ref applies. Observe (`snapshot`) and act are
  separate computer-use turns; act reuses the leased `ref_map`.
- Prefer durable `selector` (plus `name` / `role`) and emit canonical
  `click` / `fill` / `press` / `wait` when a selector is present.
- `fill_secret_ref` without `selector` / `dom_path` throws at translate time
  (`refusing snapshot+@eN stand-in`).
- Resolver: `requireDomPathMatch` still corroborates on a `ref_map` hit
  (shared helper; same class as #733 — this PR carries it so computer-use
  secrets are safe on `main` before #733 merges).

## What does not apply

- Terminal / system executors have no ephemeral DOM `@eN`.
- Desktop coordinates are inherently session-geometry-bound; there is no
  durable CSS identity to prefer. Focus-target match already guards
  `type_into_focused_input`.
- Docs that mention computer-use "replay" mean operator-visible action
  trails / traces, not ADF export of `@eN` sequences. The runtime model now
  states that live refs are session-scoped.

## How to verify

```bash
pnpm exec vitest run \
  libs/actuators/browser-actuator/src/browser-interaction-helpers.test.ts \
  libs/actuators/browser-actuator/src/recorded-ref-resolver.test.ts \
  libs/actuators/browser-actuator/src/index.test.ts \
  tests/computer-interaction-contract.test.ts
```
