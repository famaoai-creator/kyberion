---
title: Seam Provider Selection — Choosing Between Providers of the Same Function
kind: reference
scope: repository
authority: reference
phase: [alignment, execution]
tags: [seam, provider, selection, capability-broker, browser, lightpanda, governance, audit]
owner: ecosystem_architect
last_updated: 2026-09-22
---

# Seam Provider Selection

Some seams have several providers that do the same job with different
capabilities and characteristics — `browser-automation-runtime` has Chromium
(full fidelity, signed-in profiles) and Lightpanda (fast, light, no layout).
Choosing between them is **deterministic**, **audited** and **pinned per
mission**; it is not an LLM judgment.

Code: `libs/core/seam-provider-selection.ts` (pins via
`libs/core/capability-broker.ts`). Policy:
`knowledge/product/governance/seam-provider-selection-policy.json`.

## The three steps

1. **Hard filter (code truth).** The seam's caller marks every provider
   eligible or not from what the task actually needs. For the browser this is
   the same capability preflight that rejects unsupported ops
   (`preflightBrowserRuntimePipeline`), run against each registered runtime.
2. **Purpose ranking (policy).** The task states a purpose; eligible providers
   are scored as `Σ weight(purpose, trait) × trait(provider)`. Ties go to the
   seam default, then provider id. Unknown purposes fail closed.
3. **Record and pin.** Every decision goes to the audit chain
   (`action: provider_selection`, operation `<seam>/<provider>`, with
   eligible / excluded / scores / rationale). Inside a mission
   (`MISSION_ID` set) a fresh decision is pinned under
   `seam_pins["<seam>:<decisionKey>"]` of the mission's provider pins, and
   later runs reuse it. A pin the current task cannot use is **not**
   overwritten — that run falls back and says so in the rationale.

No purpose = the seam default. An explicit provider always wins; selection
never moves a task off the default unless the task asked for a purpose.

## Traits must say where their numbers come from

Every trait value carries `trait_basis: measured | declared` plus `evidence`
links, and the rationale prints the basis (`speed=0.6×1 (declared)`).
Declared values are claims (e.g. upstream benchmarks); promote them to
`measured` only with a local measurement, the same honesty rule as
`backend-capability-honesty.ts` for reasoning backends.

## Browser runtime usage

| Caller                        | How                                                                       |
| ----------------------------- | ------------------------------------------------------------------------- |
| Pipeline / ADF                | `options.runtime_purpose: "throughput"` (no `browser_runtime`, or `auto`) |
| `pnpm kyberion browser run`   | `--browser-purpose throughput` (host flag wins over pipeline options)     |
| `pnpm kyberion procedure run` | `--browser-purpose throughput`                                            |

Purposes today: `evidence` (fidelity), `throughput` (speed + footprint),
`authenticated` (signed-in sessions). Verified 2026-09-22: a read-only
pipeline with `throughput` runs on Lightpanda; the same purpose with a
`screenshot` step falls back to Chromium (Lightpanda excluded, mission pin
kept); `evidence` picks Chromium; a re-run reuses the mission pin.

## Adding another seam

1. Give its providers capability declarations the caller can check.
2. Add `seams.<seam>` to the policy: `default_provider`, `traits`,
   `providers` (traits + basis + evidence), `purposes`.
3. In the caller, build `{ id, eligible, unmet }` candidates and call
   `resolveSeamProviderDecision({ seam, candidates, purpose, decisionKey })`.
   Write the chosen id back where downstream code reads it so nested calls do
   not re-select.
