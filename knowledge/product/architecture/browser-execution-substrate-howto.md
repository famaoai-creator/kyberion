---
title: Browser Execution Substrate — How To
kind: howto
scope: repository
authority: reference
phase: [execution]
tags: [browser, actuator, playwright, chrome-extension, execution_substrate, security]
owner: ecosystem_architect
last_updated: 2026-09-06
---

# Browser Execution Substrate — How To

## What this is

A scenario recorded once via the Chrome extension (`tools/adf-replay-extension`) can be
replayed two ways, selected per-procedure by `execution_substrate`:

- **`extension`** (default, pre-existing) — the recording is compiled into a lease that the
  live Chrome extension redeems and executes itself.
- **`playwright`** (new) — the recording is compiled into a `browser:pipeline` ADF and run
  directly through `libs/actuators/browser-actuator` (headless or headed Chromium), with no
  Chrome extension involved at execution time.

Design background: `docs/INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md` §4/§7.
Architecture direction: [`browser-actuator-v3.md`](./browser-actuator-v3.md).

## Why this exists

A `browser-recording.v1` document never contains a CSS selector — every recorded action's
`target` is `{ref, role, name, snapshot_hash, dom_path?}`. Only the extension itself could
previously replay that, because Playwright's own `resolveRefSelector` only understands refs
minted by its own live `snapshot` op (`ctx.ref_map`), never an externally recorded ref. The
pieces below are the bridge that lets Playwright resolve a recorded target directly.

## How to compile a recording for Playwright

```ts
import { compileBrowserRecordingToPipeline } from '@agent/core';

const draft = compileBrowserRecordingToPipeline(approvedRecording, {
  executionSubstrate: 'playwright',
});
```

- Default (`executionSubstrate` omitted, or `'extension'`): output is byte-identical to
  before this feature existed.
- `'playwright'`: ops with a direct ref-aware actuator handler (`click_ref`, `fill_ref`,
  `press_ref`, `extract_text_ref`, and the recording's `wait_for_ref` → the actuator's
  `wait_ref`) are kept as their `*_ref` form plus `dom_path`, instead of being normalized to
  the old selector-only canonical ops (`click`/`fill`/`press`/`wait`) that require manual
  ref-to-selector resolution. Ops without a direct handler (`select_ref`, `submit_form`, …)
  still fall back to the old normalize+`needs_selector` path — this is an honest, incremental
  bridge, not full op coverage.
- `draft._review_required` still always lists the high-risk-approval-gate requirement
  regardless of substrate — a clean ref resolution says nothing about whether the action
  itself (`delete`/`purchase`/`credential_submit`/`settings_change`) is safe to auto-run.

## How to dispatch it

`libs/core/procedure-dispatcher.ts`'s `dispatchProcedure` routes a `ProcedureEntry` with
`substrate: 'browser'` and `execution_substrate: 'playwright'` to `dispatchPlaywrightPipeline`
— a sibling function to the pre-existing `dispatchExtensionSession` (never edited to
accommodate this; see the design doc's §9 rule: substrate branches live in separate
functions). It reuses `enforceBrowserExtensionApproval` and the origin-allowlist check
**verbatim** from the extension path, so governance parity holds across both substrates —
same high-risk approval gate, same allowed-origins enforcement.

`dispatchPlaywrightPipeline` still takes an injected function on `DispatchInput` (core must
never statically import `libs/actuators/*`):

```ts
executeBrowserPipeline?: (input: {
  steps: Array<{ id: string; type: string; op: string; params: Record<string, unknown> }>;
  sessionId?: string;
  options?: Record<string, unknown>;
}) => Promise<{ status: 'succeeded' | 'failed'; results?: unknown[]; errors?: string[] }>;
```

The production host boundary that wires `@agent/browser-actuator` `handleAction` is
`scripts/browser_playwright_executor.ts`. Operator entry points that inject it:

- `pnpm kyberion browser run` → `scripts/run_browser_procedure.ts` (standalone Playwright;
  optional `--cdp-url` / `--tab-id` to attach)
- `pnpm kyberion procedure run <id>` → `scripts/kyberion_home.ts` (same helper; standalone
  unless CDP flags are present)

Both launch Chromium through browser-actuator. They do **not** require a live Chrome
extension tab. Need Node `>=24` and a built `dist/` (`pnpm build` or `pnpm build:actuators`).

## Security model — read before enabling this for anything high-value

The resolver (`libs/actuators/browser-actuator/src/recorded-ref-resolver.ts`) matches a
recorded `{role, name}` against the **live** page at execution time, not at recording time.
An adversarial review found this alone is exploitable: a page that relabels a different
element with the recorded role+name (compromised, or just re-rendered) gets silently acted
on — for a secret-bearing fill, that's credential exfiltration, not just a mis-click.

The fix in place today:

- When `dom_path` is present, the resolver cross-verifies via `page.evaluate` that `dom_path`
  and the role/name match resolve to the **same DOM node** — disagreement throws
  `RecordedRefSpoofSuspectedError` rather than trusting the match.
- Secret-bearing fills (`fill_ref` with `classification: 'secret_ref'`, and `fill_secret_ref`
  always) and any op whose compiled step carries `params.high_risk` (the same
  `HIGH_RISK_OPERATIONS` set the approval gate uses) **fail closed** when no `dom_path` was
  recorded to corroborate the match at all.

**What this does not close**: `dom_path` is a coarse tag+`nth-of-type` ancestor path, not a
stable identity. A page under full attacker DOM-authorship control (e.g. XSS on the target
origin) could in principle construct a decoy element at the exact recorded structural
position with the same role/name, defeating the check by construction. This raises the bar
significantly against casual relabeling or ordinary content drift, but is **not** a defense
against a fully compromised page. Closing that fully needs a stronger per-element identity
signal than exists today — `snapshot_hash` on a recorded action only hashes the whole page's
interactive-element inventory (origin+path+title+every element's role/name), not one
element's identity, so it can't be used as-is for this. Tracked as a follow-up.

## Operator path — record → compile → run

Two legal ways to execute browser work through Kyberion:

1. **Governed recording / catalog procedure** (approval gate + origin allowlist)

   ```text
   Chrome extension records browser-recording.v1
     → human review approves the recording
     → promote / register a procedure (or keep the allowlisted recording)
     → pnpm kyberion browser run --procedure-id <id>
        or pnpm kyberion browser run --recording <allowlisted-recording.json>
        or pnpm kyberion procedure run <id>
   ```

   High-risk ops still stop at `approval_required`. Origins the recording touches must
   stay inside `procedure.target.origins`. Compiled recording drafts
   (`_source.kind = browser-recording.v1`) cannot be passed to `--adf` — that would
   skip the gate.

2. **Hand-authored browser-actuator example** (actuator contract only)

   ```text
   pnpm kyberion browser run --adf libs/actuators/browser-actuator/examples/explore-and-export.json
   ```

   This is the same JSON shape as
   `node dist/libs/actuators/browser-actuator/src/index.js --input …`. Use it for
   examples and engineering repros, not for unreviewed recordings.

Attach to an already-running Chrome only when you pass `--cdp-url` / `--cdp-port`
(and optionally `--tab-id`). Otherwise Playwright launches its own Chromium.

## Testing this yourself

- `libs/actuators/browser-actuator/src/recorded-ref-resolver.test.ts` — resolver unit tests,
  including the spoofing-defense cases (fake `page.evaluate`, no real browser needed).
- `libs/core/procedure-dispatcher.test.ts` (`describe('dispatchProcedure — playwright
substrate')`) — dispatcher routing, approval-gate parity, and blocked/executed outcomes,
  with `executeBrowserPipeline` mocked.
- `libs/actuators/browser-actuator/src/index.test.ts` — end-to-end through the real
  actuator's `handleAction`, including the fallback-resolution and fail-closed cases.

Run: `pnpm vitest run libs/actuators/browser-actuator libs/core/browser-extension-bridge.test.ts libs/core/procedure-dispatcher.test.ts scripts/browser_playwright_executor.test.ts scripts/run_browser_procedure.test.ts`

## Review process note

This feature went through a 4-persona adversarial review (Senior Developer, Security
Auditor, Red Team Adversary, Staff Engineer — Maintainability & Architecture Fit) per the
updated `knowledge/product/pipeline-templates/code-review-cycle.json`. The Red Team pass is
what found the spoofing gap above — a single-reviewer pass on the same diff did not catch it.
If you're extending this code, prefer that same multi-persona pass over a single ad-hoc
review, especially before any change that touches secret handling or the approval gate.

A follow-up question ("is that review actually enforced, or just data sitting in a file?")
found that it wasn't: this mission's own `self_review-code-review` task could be — and, in an
early throwaway verification run, briefly _was_ — marked complete by writing a placeholder
`evidence/REVIEW-*.md` and calling `record-evidence`, with zero review having occurred. That
gap is now closed at the mission-process level (`mission_controller review-task`, described in
`knowledge/product/governance/phases/execution.md`), which requires a real
`ArtifactReviewReceipt` with independence verified from the execution ledger — not
self-declared — before a review-kind task can complete. Use `review-task`, not
`record-evidence`, for every review-kind task from here on.

## Deliberately deferred (not built here)

- A `procedure:*` actuator op family to expose compile→dispatch as a proper ADF pipeline
  under `knowledge/product/pipeline-templates/` (blocked on: `pipelines/*.json` is scoped to
  Kyberion self-ops only, and wrapping a script in `system:exec` just to give it a pipeline
  name is explicitly discouraged by `pipelines/README.md`).
- Reverse path: Playwright action trail → replayable extension recording.
- Chronos UI panel for browser sessions.
- Full per-element identity binding (closing the residual spoofing gap above).
