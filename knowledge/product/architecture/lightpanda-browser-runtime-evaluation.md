---
title: Lightpanda as a Browser Automation Runtime Provider — Evaluation
kind: reference
scope: repository
authority: reference
phase: [alignment, execution]
tags: [browser, actuator, lightpanda, cdp, playwright, seam, tool-runtime]
owner: ecosystem_architect
last_updated: 2026-09-21
---

# Lightpanda as a Browser Automation Runtime Provider — Evaluation

[Lightpanda](https://github.com/lightpanda-io/browser) is a headless browser
written from scratch in Zig (V8 for JS, libcurl, html5ever; no Blink/WebKit, no
layout engine). It serves CDP, so it can back the `browser-automation-runtime`
seam (`libs/core/browser-automation-runtime-bridge.ts`) through Playwright's
`chromium.connectOverCDP()`. Upstream claims ~16x less memory and ~9x faster
than headless Chrome for page loads.

## Install

Governed tool-runtime `lightpanda` (checksum-pinned `managed_binary`, 0.4.1):

```bash
pnpm tool:setup -- --tool lightpanda --apply
# → active/shared/runtime/tool-runtimes/lightpanda/bin/lightpanda
```

Resolve the binary with `resolveLightpandaBin()` (`KYBERION_LIGHTPANDA_BIN`
override first). Always launch with `LIGHTPANDA_DISABLE_TELEMETRY=true`
(telemetry is on by default upstream). License is AGPL-3.0: invoke it as an
external binary, never vendor or link it.

## Probe results (0.4.1, Playwright connectOverCDP, 2026-09-21)

| Capability                                              | Result                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `connectOverCDP('http://127.0.0.1:<port>')`             | OK (`/json/version` served)                                                        |
| `browser.contexts()[0]` (actuator attach path)          | OK — a default context exists                                                      |
| `context.pages()[0]` of the default context             | **Phantom page: `goto` hangs.** Always `context.newPage()` instead                 |
| `goto`, `title`, locator, `getByLabel`, `fill`, click   | OK                                                                                 |
| `keyboard.type`, `waitForSelector`, `evaluate`          | OK                                                                                 |
| `mouse.click` / `boundingBox`                           | Runs, but geometry is synthetic (5x5 boxes) — coordinate-based ops are unreliable  |
| `locator.ariaSnapshot()`                                | OK                                                                                 |
| cookies add/get, `page.route` interception              | OK                                                                                 |
| `page.screenshot`, `page.pdf`                           | Returns an image, but text-flow rendering without CSS layout — not visual evidence |
| `context.tracing`                                       | Completes; DOM snapshot streamer throws inside the page (trace snapshots degraded) |
| CDP `WebAuthn.*`                                        | **Not implemented** — passkey ops unsupported                                      |
| CDP `Accessibility.getFullAXTree`                       | Fails (`InvalidParams`)                                                            |
| second page in the same context / `target=_blank` popup | **Fails** (`TargetAlreadyLoaded`; no `page` event)                                 |
| second `browser.newContext()`                           | **Fails** (one browser context per connection)                                     |
| second parallel CDP connection to one process           | OK (isolated browser per connection, default max 16)                               |

## Fit

- Good: read-mostly flows — navigate, extract (`distill_dom`, `evaluate`,
  `json_query`, `regex_extract`), simple form fill/click, network interception —
  and high-parallelism scraping/research workers (one CDP connection per
  session).
- Not a fit: multi-tab / popup flows (`select_tab*`), visual evidence
  (screenshots, video recording, visual review), passkeys, persistent Chrome
  profiles (`user_data_dir`), coordinate-based interaction.

## Provider (`browser_runtime: lightpanda`)

The browser-actuator registers `lightpanda` on the `browser-automation-runtime`
seam next to `playwright-chromium`
(`libs/actuators/browser-actuator/src/browser-automation-runtime-lightpanda.ts`).

- **Opt-in only.** Pipelines select it with `options.browser_runtime:
"lightpanda"`; hosts with `pnpm kyberion browser run --browser-runtime
lightpanda` (also `pnpm kyberion procedure run`). `auto` resolution never
  picks a provider that declares `capabilities`, so the Chromium default is
  unaffected. `browser_runtime` is host-owned: dispatcher/recording options
  cannot switch it.
- **Purpose-driven choice.** Instead of naming the runtime, a pipeline can
  state `runtime_purpose` (CLI `--browser-purpose`) and let the governed
  policy pick among the runtimes that can run its steps — see
  [seam-provider-selection](./seam-provider-selection.md).
- **Process model.** Each session spawns its own `lightpanda serve` on a free
  loopback port (via `safeSpawn`, telemetry disabled) and works in a fresh
  `browser.newContext()` — never the default context's phantom page. Closing
  the context (`keep_alive: false`, `close_session`, lease expiry) closes the
  browser and kills the process; the process is also killed on Node exit, so
  sessions are not reattached across processes.
- **Session namespace.** Non-default runtimes scope the session id as
  `<runtime>--<session_id>` (e.g. `lightpanda--checkout`), so leases, the
  per-session runtime dir, session metadata, action trails and evidence file
  names never collide with a Chromium session of the same name. The default
  runtime keeps bare ids, and an already-scoped id is used as-is, so callers
  can pass back the `session_id` a run reported.
- **Fail fast.** `preflightBrowserRuntimePipeline`
  (`browser-runtime-capabilities.ts`) scans every step, including nested
  control flow, before launch: tab ops, `screenshot`, passkey ops,
  `list_profiles`, `extension_session`, CDP attach options and Chrome profile
  options raise `[BROWSER_RUNTIME_UNSUPPORTED]`. Host-default `record_video`
  is dropped with a warning; `record_trace` still works (degraded DOM
  snapshots).
- Verified end to end (2026-09-21): goto / fill / click / evaluate / title /
  `distill_dom` on a local page and example.com, keep_alive reuse across two
  pipeline calls, `close_session` stops the process, the CLI `--adf` path, and
  unchanged Chromium default runs.
