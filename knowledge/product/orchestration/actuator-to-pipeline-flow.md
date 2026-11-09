---
title: Actuator to Pipeline Flow (use → collaborate → register)
category: Orchestration
tags: [actuator, playground, collaboration, adf, pipeline-promote, procedure, trust]
importance: 8
author: Kyberion
last_updated: 2026-11-09
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
pnpm playground -- --record <name> --drop-last ...                            # replace the last step (alone: just drop it)
pnpm playground -- --sessions                                               # list recorded sessions
pnpm playground -- --show <name>                                            # inspect a session's steps
pnpm playground -- --emit-adf <name> [--name <slug>] [--out <path>] [--request-trust]
```

Session files and drafts live under the active scope's scratch partition:
`active/shared/tmp/<tier>/<tenant|shared>/actuator-playground/`. Tenant trials
(e.g. confidential browser discovery for an internal approval flow) therefore
stay on that tenant's floor instead of the legacy unpartitioned scratch root.
Protected-tier record / emit / sessions I/O (and child actuator spawns) run
under the tenant-bound `actuator_playground_worker` role — the same pattern
as `perception_media_worker` for media scratch — so the interactive CLI can
read its own tenant partition without a broader confidential grant.
Emitted steps use the ADF `domain:op` form with the Typed Flow role mapped
from the recorded op kind; a shared `session_id` is set when browser steps
are present; string params under sensitive-looking keys (password/secret/
token/…) are redacted into `{{placeholders}}` declared in `parameters`.
The draft is a starting point — review steps, selectors, and params before
promoting (§4).

`--emit-adf` prints the verified-evidence run card. A scratch draft is
project-local content: it needs a human-approved project-trust decision to
run at all, and `pipeline:promote` only accepts a draft whose exact bytes
have a successful engine run. `--request-trust` opens the approval request
in the same command; a still-valid approval for unchanged content is reused
automatically:

```bash
# Bind the tenant first — scratch placement follows the active scope.
pnpm scope use --tier confidential --tenant <slug>
pnpm playground -- --actuator <id> --op <op> --params '{...}' --record <name>
pnpm playground -- --emit-adf <name> --request-trust
pnpm kyberion approvals --approve <request-id>                              # human decides (TTY)
# Do NOT use `pnpm kyberion approve … project-trust` here: that verb bootstraps
# tenant reasoning and often fails with CREDENTIAL_BINDING_REQUIRED.
pnpm pipeline --input active/shared/tmp/confidential/<slug>/actuator-playground/<name>.adf.json \
  --project-trust-approval <request-id>                                     # prints Run ID
# public drafts:
pnpm pipeline:promote --input <adf>.json --run <run-id> --source-is-public
# tenant drafts (confidential/personal partition) — identity required for the asset ledger:
MISSION_ROLE=worker KYBERION_PERSONA=worker \
  pnpm pipeline:promote --input <adf>.json --run <run-id> --tenant <slug>
```

When the draft declares `{{placeholders}}`, the run card appends the matching
`--context '{...}'` hint to the `pnpm pipeline` line.

### Tenant-trial operator notes

- **Same checkout as the scratch.** Session files, the ADF, the run journal
  (`active/shared/runtime/pipeline-library-runs/…`), and `pipeline:promote`
  must share one repository root. A git worktree that never saw the record
  step will fail with “source ADF must be an existing regular file”, and
  `--tenant` promote looks for the journal under
  `…/pipeline-library-runs/confidential/<slug>/` (not another checkout’s
  `public/shared/` copy).
- **Personal tenant profile.** Promote resolves
  `knowledge/personal/tenants/<slug>.json` in _this_ checkout (gitignored).
  Symlinks are refused; copy or recreate the profile in the worktree if it
  only exists on another checkout.
- **Actuator-only drafts under a persisted tenant scope.** `vcs:*` / `file:*`
  / similar steps do not need a model. The engine degrades reasoning to the
  stub chain when there is no WorkItem credential binding, instead of
  stopping on `CREDENTIAL_BINDING_REQUIRED`. Steps that _do_ need reasoning /
  voice / secrets still require a claimed WorkItem binding.
- **Capture channel.** Bare action payloads (e.g. `vcs:log`) land on
  `last_capture` / `last_transform` (or `params.export_as`). One-step pipeline
  envelopes are collapsed at the SDK boundary — to the channel value when
  `export_as` / a `last_*` key is present, otherwise to a branded context
  patch — so PTC / `system:json_query` see the same channel value (see §5
  Dispatch ABI). Prefer concrete params when recording (e.g. `vcs:log` with
  `{"limit":5,"oneline":true}`) so the draft is reviewable before promote.
- **Edits invalidate trust.** Any byte change to the ADF needs a new
  `--request-trust` / approval before `--project-trust-approval` will accept
  it again.

Charter delegation (alternative to the human round-trip): an accountability
charter that names `pipeline_trust_grant` in `envelope.delegated_decisions`
stands in for the approval. `--emit-adf` probes every active charter scope
(person + each tenant) and prints the delegated form when one covers the
draft:

```bash
pnpm pipeline --input <adf>.json --delegated-trust person          # person charter
pnpm pipeline --input <adf>.json --delegated-trust tenant:<slug>   # tenant charter
```

The delegated decision binds the exact file content (the correlation id
carries the content hash — an edited draft is a new decision) and is recorded
in the charter ledger; a deny/`stop` falls back to the normal approval path.

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
(`libs/core/pipeline/promotion-candidates.ts`); at ≥3 runs the same ADF surfaces as a
promotion candidate in the run output and in the operator status packet.
Uncertain requests that never became a pipeline accumulate in the
unhandled-intent registry instead (`libs/core/unhandled-intent-registry.ts`;
`pipelines/reconcile-unhandled-intents.json` turns them into catalog/routing
proposal stubs — the schedule ships disabled, opt-in).

Two promotions, different inputs:

| Input                                                       | Command                                                                                                                   | Output                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Successful one-off **ADF run**                              | `pnpm pipeline:promote --input <adf>.json --run <run-id> [--name <slug>] [--trace <id>] [--dry-run] [--no-llm] [--force]` | `pipelines/<slug>.json` + `promotion` provenance + README catalog row |
| Browser **recording** (`active/shared/runtime/recordings/`) | `promote-procedure` pipeline                                                                                              | `ProcedureCatalog` entry (Pattern A→B)                                |

`--run <run-id>` is the verified-evidence gate: the journal must prove this
exact ADF (sha-bound) ran to success in the target scope. Use `--draft` only
to stage an inert, non-executable proposal.

ADF lifecycle underneath: `draft → preflight → auto-repair → commit →
execute` (`validateAndRepairAdf`; permission/auth/config/env fails closed).

Placement:

- `pipelines/*.json` — system self-ops only (pre-trust executable).
- `knowledge/product/pipeline-templates/*.json` — canonical user patterns
  (parameterized, preflight gate required).
- `knowledge/confidential/{tenant}/pipelines/*.json` — tenant instantiation.

Trust: anything outside `pipelines/` + templates fails `[TRUST_REQUIRED]`
unless approved (`pnpm kyberion project-trust request <path>` → human
`pnpm kyberion approvals --approve <id>` → run with
`--project-trust-approval <id>`). Any edit invalidates the approval.
Schedules additionally need a `schedule{id,cron,timezone,enabled}` block and
`pnpm kyberion schedule register`.

The last crystallization rung is the accepted binding
(`libs/core/pipeline/accepted-pipeline-bindings.ts`): a promoted pipeline + a
successful run journal + authenticated human approval binds an `intent_id` to
`pipelines/<slug>.json`, and `run_intent` then bypasses LLM compile for that
utterance class. The bar is deliberately high — `shape: pipeline`,
`risk_profile: low`, confidence ≥0.9 with ≥0.1 margin, promoted provenance,
and a hash-matched successful run — so most actuator work still routes
through the normal compile path.

## 5. Dispatch ABI (input vs output)

Two different seams are easy to conflate:

- **Input (`actionInput`, #860)** — optional adapter on
  `defineCatalogBackedActuator` that shapes what the handler receives.
  Default is a one-step `{ action: 'pipeline', steps: [...] }` envelope;
  actuators whose handlers take `{ op, params }` / `{ action, params }`
  (vcs, calendar, terminal, …) declare `actionInput` and keep that shape.
  Do not remove it when changing output.
- **Output (catalog dispatch payload)** — `actuator.dispatch` returns an
  `ActuatorResult` whose `output` is the **op result**, never a one-step
  pipeline run report (`status` / `results` / `context` / `total_steps`).
  The SDK collapses legacy sub-pipeline envelopes: a channel value when
  `export_as` / `last_capture` / `last_transform` is present, otherwise a
  branded context patch for ad-hoc keys (`file:exists` → `exists`). The
  pipeline engine then assigns capture/transform/`export_as` to a context
  key or merges a patch. PTC `callOp` sees the same channel value.

Follow-up (not this change): migrate remaining ad-hoc context keys onto
declared channels so context-patch returns become rare. `actionInput` stays.

## 6. Known gaps (verified 2026-10-26)

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

## 7. Failure map (where this flow used to stall)

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
- `--emit-adf` pointed straight at `pipeline:promote --source-is-public`,
  which fails `[PIPELINE_PROMOTION_UNVERIFIED]` now that promotion requires
  the engine run id — fixed 2026-10-31 by printing the full run card
  (project-trust → `pnpm pipeline` run → `promote --run`), reusing a valid
  approval, and adding `--request-trust` to open the request in the same
  command.
- A recorded-but-wrong step forced a full `--reset` — fixed by
  `--record <name> --drop-last` (standalone drop, or success-gated
  replacement when combined with a run) plus `--sessions` / `--show` to
  inspect what was recorded.
- Tenant playground trials mixed into the unpartitioned scratch root and
  then failed protected-tier reads (`Higher tier required`) — fixed by
  partitioning scratch under `tmp/<tier>/<tenant|shared>/actuator-playground/`
  and assuming `actuator_playground_worker` (with child `KYBERION_TENANT`
  mirrored through `buildSafeExecEnv`).
- `pnpm kyberion approve … project-trust` under a tenant scope hit
  `CREDENTIAL_BINDING_REQUIRED` — run card now points at
  `pnpm kyberion approvals --approve` (TTY). Actuator-only drafts also
  degrade reasoning instead of requiring a WorkItem binding just to run
  `vcs:log`.
- Catalog-backed capture steps returned a payload object but left
  `last_capture` empty — fixed by mapping bare action payloads onto
  `last_capture` / `last_transform` (or `export_as`). A first cut that also
  wrapped one-step pipeline envelopes under the channel key broke
  `core:ptc`/`system:json_query` (envelope must keep its `.context` unwrap);
  the engine now branches on output shape. The SDK has since been converged
  onto payload-only dispatch results — envelopes normalize to channel values
  or context patches at the SDK boundary (see §5 Dispatch ABI).
- `pipeline:promote --tenant` from another checkout failed with missing ADF /
  journal / personal tenant profile — documented in §2 tenant-trial notes
  (same root, copy profile, set `MISSION_ROLE`/`KYBERION_PERSONA`).
