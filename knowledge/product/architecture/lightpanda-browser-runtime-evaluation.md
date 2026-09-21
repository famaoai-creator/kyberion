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

## Required seam work before registering a `lightpanda` provider

1. Let callers choose a provider: `resolveBrowserAutomationRuntime()` is called
   without a preference in `browser-runtime-helpers.ts`, so the first
   registered bridge (Playwright Chromium) always wins.
2. `launchPersistentContext` for Lightpanda = spawn `lightpanda serve` on a free
   port and connect over CDP; the Chrome-only `waitForCdpEndpoint(userDataDir)`
   (`DevToolsActivePort`) must not be used.
3. Never reuse the default context's pre-existing page; open a fresh page.
4. Declare provider capabilities (screenshot / multi_tab / webauthn = false) so
   pipeline preflight rejects unsupported ops instead of failing mid-run.
