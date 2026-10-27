---
title: Actuator to Pipeline Flow (use → collaborate → register)
category: Orchestration
tags: [actuator, playground, collaboration, adf, pipeline-promote, procedure, trust]
importance: 8
author: Kyberion
last_updated: 2026-10-26
role_affinity: [ecosystem_architect, mission_controller, operator, researcher]
phase_affinity: [alignment, execution, review]
---

# Actuator to Pipeline Flow

One path from trying an actuator to registering reusable work:
**use → collaborate → register**. Verified against the runtime on 2026-10-03.

## 1. Discover (what can run)

Two catalogs, different granularity:

- `manifest.json` per actuator (`libs/actuators/*/manifest.json`) — coarse entry
  points, often just `pipeline` for pipeline-driven actuators
  (file / browser / media / network / code).
- `knowledge/product/orchestration/actuator-op-discovery.json` — fine-grained
  step ops generated from each actuator's `describeOps()`
  (`pnpm generate:op-registry`). Human-readable render: `CAPABILITIES_GUIDE.md`.

Commands:

```bash
pnpm capabilities            # manifest scan, build-free; shows +N step ops hint
pnpm generate:op-registry    # regenerate discovery + registry after op changes
```

Every agent-facing surface merges both layers, so a step op that resolves in
the playground resolves everywhere: playground, `kyberion run`, and the MCP
`kyberion.capability.list` / `.search` tools (execution still bounded by
`actuator_invoke_allowlist`). `CAPABILITIES_GUIDE.md` is a generated render —
treat names in it as hints and confirm against `--describe` when an op does
not resolve.

## 2. Try (playground)

```bash
pnpm playground --actuator <id> --op <op> --params '{...}' --check    # schema/plan only
pnpm playground --actuator <id> --op <op> --params '{...}' --dry-run  # validate-only, except bare capture ops which execute
pnpm playground --actuator <id> --op <op> --params '{...}'           # live execution
```

Rules that bite:

- `--op` accepts manifest ops **and** discovery step ops.
- Discovery-only ops on actuators that accept `pipeline` are wrapped into a
  one-step pipeline (`{action:"pipeline", steps:[{type, op, params}]}`) — the
  same shape production ADF uses. A bare single-op action fails there with
  "pure pipeline-driven". Actuators without a `pipeline` entry (agent/secret/…)
  dispatch single actions directly and stay bare.
- Wrapped pipeline payloads are validate-only under `--check`/`--dry-run`;
  live execution needs no flag.
- `secret-actuator set` with a value is blocked live; use
  `pnpm kyberion secret introduce` / Concierge.
- Sense verbs are the production path for perception, not the playground:
  `pnpm kyberion read|see|listen|watch` (see `perception-playbook.md`),
  actions in `action-playbook.md`.

Recording a multi-step session (scratch → ADF draft):

```bash
pnpm playground -- --record <name> --actuator <id> --op <op> --params '{...}'  # each successful live run appends a step
pnpm playground -- --record <name> --reset ...                                # clear the session first
pnpm playground -- --emit-adf <name> [--name <slug>] [--out <path>]           # write a PipelineAdf draft
pnpm pipeline:promote --input active/shared/tmp/actuator-playground/<name>.adf.json --source-is-public
```

Session files and drafts live under `active/shared/tmp/actuator-playground/`.
Emitted steps use the ADF `domain:op` form with the Typed Flow role mapped
from the recorded op kind; a shared `session_id` is set when browser steps
are present; string params under sensitive-looking keys (password/secret/
token/…) are redacted into `{{placeholders}}` declared in `parameters`.
The draft is a starting point — review steps, selectors, and params before
promoting (§4).

## 3. Collaborate (cowork / peer)

Two systems, do not confuse:

- **Cowork** = MCP facade + knowledge sync (no execution bridge).
  `pipelines/cowork-integration-review.json` checks health only.
- **Peer** = same-tenant runtime-to-runtime messaging. Shortest path:
  `same-tenant-peer-quickstart.ja.md` (register → same `tenant-id` → inspect →
  `peer:conversation`), details in `peer-network.md`.

Acceptance gap (by design):

- `pnpm kyberion peer collaboration accept` records **local authorization
  only**. It never mutates mission state and never executes the embedded
  WorkItem/A2A proposal (`peer-network.md`).
- After `accept`, the operator still must track and run the follow-up, then —
  if reusable — promote the run (next section). Concrete shape:
  `pnpm work create-item --title "<proposal subject>" --tenant-slug <tenant> --assignee-peer-id <peer> --tier confidential`.
  The CLI prints these `next_steps` on accept.

## 4. Register (scratch → governed pipeline)

Doctrine: get to SUCCESS first (scratch under `active/shared/tmp/<job>/` or
mission evidence), promote only on reuse
(`pipeline-crystallization-memo.md`, `architecture/loop-closure-machinery.md`).

The repetition detector is mechanical: every successful ad-hoc ADF run (input
outside `pipelines/`) is tallied in
`active/shared/runtime/feedback-loop/adhoc-pipeline-runs.json`
(`libs/core/promotion-candidates.ts`); at ≥3 runs the same ADF surfaces as a
promotion candidate in the run output and in the operator status packet.
Uncertain requests that never became a pipeline accumulate in the
unhandled-intent registry instead (`libs/core/unhandled-intent-registry.ts`;
`pipelines/reconcile-unhandled-intents.json` turns them into catalog/routing
proposal stubs — the schedule ships disabled, opt-in).

Two promotions, different inputs:

| Input                                                       | Command                                                                                                    | Output                                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Successful one-off **ADF run**                              | `pnpm pipeline:promote --input <adf>.json [--name <slug>] [--trace <id>] [--dry-run] [--no-llm] [--force]` | `pipelines/<slug>.json` + `promotion` provenance + README catalog row |
| Browser **recording** (`active/shared/runtime/recordings/`) | `promote-procedure` pipeline                                                                               | `ProcedureCatalog` entry (Pattern A→B)                                |

ADF lifecycle underneath: `draft → preflight → auto-repair → commit →
execute` (`validateAndRepairAdf`; permission/auth/config/env fails closed).

Placement:

- `pipelines/*.json` — system self-ops only (pre-trust executable).
- `knowledge/product/pipeline-templates/*.json` — canonical user patterns
  (parameterized, preflight gate required).
- `knowledge/confidential/{tenant}/pipelines/*.json` — tenant instantiation.

Trust: anything outside `pipelines/` + templates fails `[TRUST_REQUIRED]`
unless approved (`pnpm kyberion project-trust request <path>` → human
`pnpm kyberion approve <id> project-trust` → run with
`--project-trust-approval <id>`). Any edit invalidates the approval.
Schedules additionally need a `schedule{id,cron,timezone,enabled}` block and
`pnpm kyberion schedule register`.

The last crystallization rung is the accepted binding
(`libs/core/accepted-pipeline-bindings.ts`): a promoted pipeline + a
successful run journal + authenticated human approval binds an `intent_id` to
`pipelines/<slug>.json`, and `run_intent` then bypasses LLM compile for that
utterance class. The bar is deliberately high — `shape: pipeline`,
`risk_profile: low`, confidence ≥0.9 with ≥0.1 margin, promoted provenance,
and a hash-matched successful run — so most actuator work still routes
through the normal compile path.

## 5. Known gaps (verified 2026-10-26)

- `actuator_action` in the execution-shape enum is declarative only — it
  projects to `task_session` and no route handler dispatches a bare actuator
  op for an utterance. Single ops go through the routes in §1–2.
- `resolveWorkScopeSignalOptions` reads only five runtime signals, so just
  two of the seven `work-scope-policy.json` mandatory triggers
  (`external_regulatory_evidence`, `high_stakes_action`) are reachable from
  context; the rest need a caller to pass them programmatically.
- `front-desk-execution` calls `resolveWorkScopeDecision` with no input
  signals, so the scope gate never promotes or restricts there.
- `reconcile-unhandled-intents` ships `enabled: false`; the trace→procedure
  analyzer was retired, leaving the browser-extension recording compiler as
  the only active recording→procedure path.
- `pipeline:promote`'s LLM advice (`{{placeholder}}`, `_semantic` flags) is
  advisory — nothing downstream enforces it, and a stub backend promotes
  verbatim.
- super-nerve `system:shell` execs `zsh -lc` directly, bypassing the
  typed-op/approval machinery it otherwise enforces.

## 6. Failure map (where this flow used to stall)

- Playground rejected valid step ops (`Machine mode requires --op`) — fixed by
  merging discovery ops; discovery-only ops on pipeline-accepting actuators
  auto-wrap into a one-step pipeline.
- `pnpm capabilities` showed only coarse ops — fixed with the `+N step ops`
  hint pointing at the discovery index.
- Every `pipeline:promote` failed: the stamped `promotion` provenance key was
  rejected by `pipeline-adf.schema.json` (`additionalProperties: false`).
  Fixed by allowing `promotion` in the schema and `PipelineAdf` contract.
- `pipeline:promote` vs `promote-procedure` confusion — scope now stated in
  both usage texts.
- `accept` with no follow-up — `next_steps` now printed on accept and in the
  cowork review completion log.
- Playground machine mode always emitted `{action, op, params}`; strict
  contracts declaring `required: ["op"]` with `additionalProperties: false`
  (vcs, scheduler, calendar, data, working-memory, media-generation, wisdom,
  deployment, build) rejected every call — fixed 2026-10-18 by allowing the
  compatibility discriminator key in those schemas and by validating
  normalized candidates in `evaluatePlaygroundDryRun`.
- `pipeline` ops and flat schemas (build) never validated because user params
  were nested under `params` — fixed by spreading params top-level when the
  contract schema declares a flat shape (`contractSchemaUsesFlatParams`).
- `--dry-run` skipped capture ops outside the hardcoded name list
  (`adb_health_check`, `list_calendars`, `knowledge_search`, …) — fixed by
  resolving the op kind from the discovery registry.
- Machine mode required `--params` even for zero-argument ops — now optional.
- The MCP surface (`kyberion.capability.*`, `actuator.invoke`) saw manifest
  ops only, so pipeline-driven actuators advertised just `pipeline` and
  allowlisted step ops died on `[MCP_ACTUATOR_OP_UNKNOWN]` — fixed 2026-10-26
  by merging `actuator-op-discovery.json` into list/search/declaration and
  wrapping discovery-only ops into the one-step pipeline envelope.
