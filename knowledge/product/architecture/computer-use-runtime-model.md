---
title: Computer Use Runtime Model
kind: architecture
scope: repository
authority: reference
phase: [alignment, execution]
tags: [computer-use, browser, actuator, runtime, governance]
owner: ecosystem_architect
last_updated: 2026-11-01
---

# Computer Use Runtime Model

This note captures what Kyberion should adopt from "computer use" style systems without copying a provider-specific implementation.

## Status and operational entry point

This is an architecture/reference note: statements using "should", the preferred
vocabulary, and the near-term list are design direction, not an inventory of
implemented end-to-end behavior. The step contract and physical executors exist;
their presence does not establish universal automatic verification, durable resume,
or exactly-once execution. Check each selected executor's supported contract.

For current operator procedure, use the canonical
[Browser Automation Operating Checklist](../orchestration/browser-automation-best-practices.md),
including fresh observations, unique targets, bounded state waits, approval boundaries,
postcondition readback, and uncertainty-aware resumption. Its conceptual certainty
labels do not replace the existing receipt schema statuses.

## Core Thesis

Kyberion should treat computer use as:

- a governed runtime loop
- over a sandboxed interaction surface
- using provider-independent action contracts
- with explicit observation, action, and approval boundaries

The concept is broader than browser automation.

It includes:

- browser sessions
- desktop-like surfaces
- text editing and terminal sidecars
- operator-visible replay and approval

## What Kyberion Already Has

Kyberion already contains much of the substrate:

- `browser-actuator` for Playwright execution (web pages)
- `system-actuator` for OS-level GUI actions through the macOS automation bridge
  (`os-automation-bridge-model.md`)
- `terminal-actuator` for PTY sessions
- `surface-runtime` for governed long-lived surfaces
- `A2UI` for human-facing live state
- `Chronos` for control and inspection
- approval workflows for risky operations

The missing part is not raw clicking.

The design goal is a first-class **computer interaction loop** across these parts;
this note alone does not establish the current completeness of that integration.

## The Loop

The canonical loop is:

1. observe the current computer state
2. decide the next interaction
3. execute the interaction
4. capture the result
5. repeat until complete or blocked

Kyberion should represent each step as:

- `observation`
- `action`
- `tool_result`

This is the role of `computer-interaction.schema.json`.

## Separation of Responsibility

### Provider / agent

The model decides:

- whether more observation is needed
- which action is most likely to help
- whether progress is complete

### Runtime / executor

Kyberion executes:

- browser or desktop operations
- screenshot capture
- coordinate normalization
- ref resolution
- trace and replay logging

### Governance layer

Kyberion enforces:

- site and domain risk policy
- approval gates for sensitive actions
- session isolation
- observability and operator review

## Action Vocabulary

The provider-facing contract should stay small and generic.

Preferred families:

- observe
  - `snapshot`
  - `screenshot`
  - `capture_console`
  - `capture_network`
- navigate / focus
  - `open_tab`
  - `select_tab`
- pointer / keyboard
  - `left_click`
  - `double_click`
  - `mouse_move`
  - `drag`
  - `scroll`
  - `type`
  - `key`
  - `wait`
- ref-driven browser actions
  - `click_ref`
  - `fill_ref`
  - `fill_secret_ref`
  - `press_ref`
  - `wait_for_ref`
  - `extract_text_ref`

Live `@eN` refs are session-scoped. A computer-use apply must not remint a
snapshot and then reuse a previously observed `@eN` — a fresh snapshot's
`@e1` is not the recording-time field. Prefer durable `selector` / `name` /
`role` / `dom_path` when replaying or filling secrets. Secret fills require a
corroborating `dom_path` or `selector`; the translator must not insert a
snapshot as a stand-in identity. Same-session `keep_alive` may apply a live
`@eN` from the last observation in that session.

This allows the same contract to work across:

- browser-only environments
- desktop-like environments
- future local-provider loops

## Element Identity

Every executor must answer "which element does this action hit" with evidence,
not position alone.

- Browser refs stay session-scoped live `@eN` from the last observation —
  unchanged.
- Desktop / AX-style surfaces use snapshot-qualified refs
  `@<snapshot_id>:e<N>` (`qualified_ref` in the schema). A ref is valid only
  inside the snapshot map that allocated it; a bare or cross-snapshot ref is
  rejected, and re-identification re-checks stored evidence — process
  generation, role, path in the tree, stable text identity, bounds — before
  dispatch. Mutable control values never count as identity. Zero live matches
  is stale, several is ambiguous; both fail closed. This is the same rule the
  browser remint fix applied: never mint a fresh observation to make an old
  address resolve.
- When an executor can read durable identity (selector/dom_path on browser,
  platform `native_id` plus role/name on AX surfaces), callers should send it
  alongside the ref so resolution corroborates instead of trusting the
  ephemeral address.

## Delivery Disposition and Retry

`tool_result` carries `disposition.delivery` — `unknown`, `not_delivered`,
`delivery_uncertain`, `delivered_unverified`, or `delivered_verified` — and
`disposition.retry` follows from it: only `not_delivered` is `safe` to repeat.

Both executors now stamp this vocabulary: `system-actuator` and
`browser-actuator` `computer_interaction` results carry `code` / `disposition`
/ `recovery`, and thrown errors carry the same fields for in-process callers
(`libs/core/computer-interaction-outcome.ts`). Native error codes pass through
unchanged — the mark domain (`MARK_STALE`, `MARK_INVALID`), the snake_case
native-bridge codes (`macos_accessibility_denied`,
`macos_focused_input_unavailable`, `native_mouse_failed`, …) with per-class
recovery, and the Chrome-extension recorded-ref failures (`STALE_REF`,
`AMBIGUOUS_TARGET`, `TARGET_MISMATCH`). Unclassified failures on mutating
actions default to `unknown` / `unknown` — never auto-retried.

`delivered_verified` is reached where a cheap postcondition readback exists:
`activate_application` polls the frontmost app, `activate_tab_by_*` re-reads
the front window's active tab, `close_tab_by_*` re-lists tabs for absence,
and browser `fill_ref` / `fill_secret_ref` compare the live `inputValue`
(the boolean lands on the action-trail entry — secret values never do). A
contradicting readback demotes to `delivery_uncertain`; an unavailable read
stays `delivered_unverified`. Actions with no honest readback (clicks,
keystrokes, mouse) keep `delivered_unverified` by design.

Observation completeness is real too: `buildSnapshot` records
`element_total` (visible candidates before the cap), `truncated`, and
`complete`, and `buildBrowserPipelineSummary` propagates them as
`element_total` / `snapshot_truncated` so callers cannot mistake a capped
inventory for an exhaustive one.

- No unconditional success flags. A field like `clicked: true` on every
  successful call proves nothing; a result names the postcondition readback it
  performed, or reports `delivered_unverified` when none was possible.
- A retry after uncertain or unverified delivery can double-click, double-type,
  or undo a toggle. Recovery flows branch on `code` plus disposition, and
  `recovery.requires_fresh_observation` marks stale-ref recovery.
- Read failures classify before retry is chosen: a settled absence (the target
  does not have this) is never retried; a transport failure is retried inside
  the deadline; a gone element settles as stale; anything unclassified is
  terminal, not a retry candidate.

## agent-desktop Managed Backend (optional)

The Vercel Labs `agent-desktop` CLI is integrated as an **optional** governed
tool runtime — Kyberion works unchanged without it.

- **Lifecycle**: registry record `agent_desktop` in
  `knowledge/product/governance/tool-runtimes/` with checksum-pinned
  `managed_binary` artifacts for all six `{darwin,linux,win32}-{arm64,x64}`
  release tarballs (`archive: tar.gz`, verified then extracted into
  `bin/` beside the platform helper). Install goes through
  `pnpm tool:setup -- --tool agent_desktop --apply`; resolution order is
  `KYBERION_AGENT_DESKTOP_BIN` → managed env binary → registry command →
  PATH (`resolveAgentDesktopBin`).
- **Bridge**: `libs/core/desktop-ax-bridge.ts` spawns the binary with an
  allowlisted subcommand set (`snapshot`, `find`, `click`, `type`, `press`,
  `scroll`, `set-value`, `select`, `list-windows`, `session`, `version`),
  redirects `AGENT_DESKTOP_HOME` to
  `active/shared/runtime/system/agent-desktop` (owner-only mode; refmaps
  and traces contain screen content and never reach the knowledge tier),
  and maps the caller's `session_id` to a runtime session minted via
  `session start --name` (in-process association; refs stay scoped to
  their snapshot namespace either way).
- **Ops**: `computer_interaction` exposes `ax_runtime_status` (preflight
  probe — answers `{available, bin, version}` even when the runtime is
  absent, so callers can discover the backend without eating a
  `TOOL_UNAVAILABLE`), `ax_snapshot`, `ax_find`,
  `ax_list_windows`, `ax_list_apps`, `ax_list_displays`,
  `ax_list_surfaces`, `ax_list_notifications`, `ax_get`, `ax_is`
  (observation); `ax_click`, `ax_right_click`, `ax_type`, `ax_press`,
  `ax_scroll`, `ax_scroll_to`, `ax_set_value`, `ax_select`, `ax_clear`,
  `ax_focus`, `ax_toggle`, `ax_check`, `ax_uncheck`, `ax_expand`,
  `ax_collapse` (mutating); and `ax_session_end`, `ax_session_gc`
  (lifecycle — seal/gc governed runtime sessions, no approval).
- **Approval tiers**: mutating ops split by risk, matching the existing
  per-op policy of the mark/coordinate path. Navigation-class ops
  (`ax_click`, `ax_scroll`, `ax_scroll_to`, `ax_focus`, `ax_expand`,
  `ax_collapse`) run ungated — same risk as `left_click`/`scroll`, but
  strictly safer since they act on a resolved ref. Commit-class ops
  (`ax_type`, `ax_press`, `ax_set_value`, `ax_select`, `ax_clear`,
  `ax_toggle`, `ax_check`, `ax_uncheck`, `ax_right_click`) keep the
  `wf_computer_destructive_v1` approval workflow — they commit value
  changes or invoke menus. Headed/physical commands (`hover`, `drag`,
  `mouse-*`, `double/triple-click`, `key-down/up`) stay excluded —
  upstream rejects them in stateless mode, and physical input already
  has a governed channel (marks + CGEvent); a `POLICY_DENIED` outcome
  points callers at that channel via `recovery.strategy:
use_physical_channel`.
- **Postcondition readbacks**: mutating ops whose intent maps to a cheap
  live property read get a verification step — `ax_set_value`/`ax_clear`
  → `get value`; `ax_check`/`ax_uncheck` → `is checked`;
  `ax_expand`/`ax_collapse` → `is expanded`; `ax_focus` → `is focused`;
  `ax_scroll_to` → `is visible`. A matched readback promotes to
  `delivered_verified`, a contradiction demotes to `delivery_uncertain`,
  a failed read leaves `delivered_unverified`. `ax_toggle` stays
  unverified by design ("invert" needs a before-state), and
  `click`/`type`/`press`/`scroll`/`select`/`right-click` have no honest
  single-property postcondition.
- **Session resilience**: the caller's `session_id` maps to a minted
  runtime session (`session start --name`). If a cached session id goes
  stale (runtime gc / idle expiry, `SESSION_*` errors) the bridge evicts
  it, re-mints, and retries the command exactly once — never loops.
  `ax_list_windows` is session-independent and skips the bootstrap.
- **Observation budget**: upstream's 3s snapshot deadline timed out on a
  real 597-element Finder window; ax ops default `--timeout-ms` to 15s
  unless the caller passes `timeout_ms`, and a `TIMEOUT` code still
  propagates honestly rather than being retried silently.
- **Fail-closed addressing**: ref ops require `qualified_ref`
  (`@<snapshot_id>:e<N>`); bare or cross-snapshot refs are rejected before
  spawn. Upstream envelope codes (`STALE_REF`, `AMBIGUOUS_TARGET`,
  `SNAPSHOT_NOT_FOUND`, `TIMEOUT`, `ACTION_NOT_SUPPORTED`) and their
  `disposition` pass through into `code` / `disposition` / `recovery`.
- **Absent runtime**: every ax op fails closed with `TOOL_UNAVAILABLE`
  plus `recovery.strategy: install_tool_runtime` — never a crash, never a
  silent downgrade to marks/coordinates.
- **Tri-state evidence** (shipped): observation ops stamp
  `tool_result.evidence` — `known` when a field was read, `absent` when
  it provably does not exist (`get` null value, `is applicable:false`),
  `unknown` when the read itself failed. Upstream `complete`/`truncated`
  flags surface at the contract level. Upstream's own fail-closed codes
  (`POLICY_DENIED`, `ACTION_NOT_SUPPORTED`, `AMBIGUOUS_TARGET`,
  `INVALID_ARGS`, `SESSION_*`) classify as `not_delivered` with
  non-retryable recovery; `POLICY_DENIED` additionally hints
  `use_physical_channel`.
- **Runtime lifecycle**: the bridge registers a one-shot `exit` drain
  when the first runtime session is minted — every minted session is
  sealed (`session end`) and stale manifests swept (`session gc`) so a
  dying Kyberion process never orphans runtime sessions. The upstream
  command host exits on its own idle clock once its sessions are sealed.

## Observation Evidence

- Observed properties are tri-state (`tool_result.evidence`): `known`,
  `absent` (asked, does not exist), `unknown` (read failed or untrusted).
  `absent` satisfies completeness checks; `unknown` must not — a predicate
  collapsed to boolean is safe only in positive position, because negating
  `unknown` silently reads it as "definitely not".
- Observations are budgeted. A snapshot that exhausts its budget returns
  `complete: false` with the partial tree and `truncated` rather than an error
  with no data; a targeted re-observation of one region must be complete to
  replace stored refs.

## Why This Differs From Raw Browser Pipelines

Current browser automation in Kyberion is strong for deterministic engineering execution.

Computer use adds:

- iterative observe/act loops
- first-class screen state artifacts
- action replay as an operator concept
- approval-aware "ask before acting" on risky UI steps

So the conceptual shift is:

- from pipeline-only execution
- to runtime-mediated interaction loops

## High-Risk Actions

Computer use should never auto-execute certain actions just because the target is visible.

Examples:

- sign in / credential submission
- purchase / payment
- publish / post / send
- delete
- permission grant
- privileged admin settings change

These should be emitted with:

- `risk.level`
- `risk.requires_approval`
- `risk.approval_scope`

The actual approval should flow through the same Kyberion approval model used elsewhere.

## Surface Model

Kyberion should expose computer use through distinct surfaces:

- `command surface`
  - the user asks for a task
- `computer surface`
  - live screen, current step, last observation, risky action prompts
- `control surface`
  - Chronos shows sessions, traces, and blocked/risky steps
- `work surface`
  - drill-down into screenshots, action trails, console, network

## Recommended Near-Term Implementation

1. Keep the physical executors split by target — `browser-actuator` (page),
   `system-actuator` (OS / desktop apps), `terminal-actuator` (PTY) — all speaking
   the same `computer_interaction` contract (`target.executor`). They are not
   duplicates and are not merged; see `orchestration/action-playbook.md`.
2. Use the existing `computer-interaction.schema.json` as the provider-neutral step contract.
3. Prefer structural desktop observation (`observation.mode: ax_tree`) over
   screenshot-and-marks when an executor or backend can supply an accessibility
   tree, because snapshot-qualified refs give actions a durable, retry-safe
   address that pixel coordinates cannot. Set-of-Marks remains the fallback for
   AX-opaque applications. AX trees carry private window content, so they flow
   through the same governed capture paths and redaction scope as screenshots.
4. Create a `computer-surface` runtime that displays:
   - latest screenshot
   - action trail
   - current target
   - approval waits
5. Add `Computer Sessions` to Chronos.
6. Route high-risk actions through approval workflows.

## Design Rule

The key import from computer-use systems is:

- not "LLM clicks things"
- but "LLM proposes interaction steps inside a governed execution loop"

That fits Kyberion's actuator-first and control-surface concepts directly.
