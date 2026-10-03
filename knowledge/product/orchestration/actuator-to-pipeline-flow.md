---
title: Actuator to Pipeline Flow (use → collaborate → register)
category: Orchestration
tags: [actuator, playground, collaboration, adf, pipeline-promote, procedure, trust]
importance: 8
author: Kyberion
last_updated: 2026-10-03
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

## 5. Failure map (where this flow used to stall)

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
