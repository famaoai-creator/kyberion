---
title: Kyberion in 1 Hour
category: Developer
tags: [tour, onboarding, architecture, c-2]
importance: 10
last_updated: 2026-05-08
---

# Kyberion in 1 Hour

A guided tour of Kyberion's codebase. Read top-to-bottom in one sitting; you should leave with a working mental model of how it all fits together.

This is **Phase C'-2**: the entry point that lets a new contributor be productive in a week.

If you only have 5 minutes, read just §1.

## 1. The thesis (5 min)

> **Kyberion turns organizational intent into governed execution, evidence, and reusable memory.**

The user-facing simplification:

```
Intent → Plan → Result
```

Internally, this expands to:

```
Intent → Context → Resolution → Outcome Design → Teaming →
  Authority → Execution → Accounting → Learning
```

Each step has a corresponding internal concept. The user only sees Intent / Plan / Result; everything else is the engine.

Read once: [`knowledge/public/architecture/organization-work-loop.md`](../../knowledge/public/architecture/organization-work-loop.md).

## 2. The five primitives (15 min)

Everything in Kyberion is one of these five things. If you understand them, you understand the system.

### 2.1 Mission

A piece of work with its own state, evidence, and lifecycle. Lives in `active/missions/<id>/` (its own git repo).

- States: `planned → active → validating → distilling → completed/paused/failed/archived`.
- Each mission has `mission-state.json` (the state machine), an evidence directory, and a history log.
- Created by `pnpm mission:create` or `mission_controller start`. Worked on by checkpoints. Closed by `finish`.

Code: `scripts/mission_controller.ts`, `scripts/refactor/mission-*.ts`, `libs/core/mission-*.ts`.

### 2.2 Actuator

A specialized executor for one domain (browser, file, voice, code, etc.). 23+ exist today.

- Each lives in `libs/actuators/<name>/`, has a `manifest.json` declaring its `op`s and a contract schema in `schemas/`.
- Called via the pipeline engine, not directly.
- Each actuator's `version` follows semver and is enforced by `pnpm check:contract-semver`.

Code: `libs/actuators/`, `CAPABILITIES_GUIDE.md`.

### 2.3 ADF (Agentic Data Format) Pipeline

A declarative, schema-validated description of *what to do*. Steps reference actuator ops.

- Lives in `pipelines/*.json`. Composable: a step can reference another pipeline via `ref`.
- Has `on_error` semantics: `skip` / `abort` / `fallback`.
- Validated before execution (preflight). Repaired by an LLM sub-agent on validation failure.

Code: `libs/core/src/pipeline-engine.ts`, `pipelines/`, `schemas/*-pipeline.schema.json`.

### 2.4 Knowledge Tier

Three-tier filesystem isolation for what an agent reads and writes:

| Tier | Path | Audience |
|---|---|---|
| Legacy personal fallback | `knowledge/personal/` (gitignored) | Legacy personal fallback when no customer overlay is active |
| Confidential | `knowledge/confidential/{project}/` (gitignored) | One project / org |
| Public | `knowledge/public/` (committed) | Reusable, shared |

When `KYBERION_CUSTOMER` is set, `customer/{slug}/` becomes the preferred overlay root for customer-specific identity, vision, connections, policy, voice, and onboarding state before falling back to `knowledge/personal/`.

Enforced at the file-IO boundary by `secure-io.ts` + `tier-guard.ts`. There is no "trusted code" exception — everything goes through the boundary.

Code: `libs/core/secure-io.ts`, `libs/core/tier-guard.ts`, `knowledge/`.

### 2.5 Trace

OTel-inspired structured tracing per pipeline run. Captures spans, events, artifacts, knowledge references.

- Persisted as JSONL under `active/shared/logs/traces/` (or `customer/{slug}/logs/traces/` when active).
- Read by Chronos (the operator viewer), distillation (failure → reusable hint), and the error classifier.

Code: `libs/core/src/trace.ts`, `docs/developer/TRACE_MIGRATION_TEMPLATE.md`.

## 3. The path of a single request (15 min)

Concrete walkthrough: a user types `今週の進捗レポートを作って`. Trace it through the codebase.

```
1. presence surface (browser/Slack/CLI) captures the utterance
   → libs/actuators/presence-actuator/

2. Intent resolution turns utterance into a structured intent
   → libs/core/src/intent-compiler.ts (uses an LLM via reasoning-backend)

3. Mission classification picks the right mission shape
   → libs/core/mission-classification.ts
   → libs/core/mission-team-orchestrator.ts
   → reads knowledge/public/governance/mission-classification-policy.json

4. Mission seed → mission creation
   → scripts/refactor/mission-creation.ts
   → creates active/missions/<id>/ with its own git repo

5. Pipeline selected from mission seed
   → pipelines/<seed-pipeline>.json

6. Pipeline executes step-by-step
   → libs/core/src/pipeline-engine.ts orchestrates
   → each step routes to the right actuator
   → actuator's main loop in libs/actuators/<name>/src/index.ts

7. Actuator emits Trace + records evidence
   → libs/core/src/trace.ts (TraceContext)
   → evidence written under active/missions/<id>/evidence/

8. Mission lifecycle: checkpoint → finish
   → scripts/mission_controller.ts
   → distillation extracts hints to knowledge/public/procedures/hints/

9. Result returned to user
   → presence-actuator emits to the original surface
```

Cross-cuts:
- Every state-changing op writes to `active/audit/audit-{date}.jsonl` (audit chain).
- Every external LLM/HTTP egress goes through `egress-guard` (TODO: stronger redaction in Phase C'-7).
- Every actuator op is rate-limited / approval-gated per `knowledge/public/governance/`.

## 4. Where to find things (10 min)

```
kyberion/
├── docs/                   # Hand-written human docs (this directory)
│   ├── user/               # End-user docs
│   ├── operator/           # Deploy / run docs
│   ├── developer/          # ← you are here
│   └── PRODUCTIZATION_ROADMAP.md   # Where we're going
│
├── knowledge/              # System-referenced structured knowledge
│   ├── personal/           # gitignored
│   ├── confidential/       # gitignored
│   └── public/             # committed
│       ├── architecture/   # design docs (92 files)
│       ├── governance/     # active policies
│       └── procedures/     # runbooks, hints
│
├── libs/
│   ├── core/               # @agent/core — the framework
│   │   ├── path-resolver.ts        # filesystem resolution
│   │   ├── customer-resolver.ts    # FDE customer overlay
│   │   ├── secure-io.ts            # tier-enforced file IO
│   │   ├── mission-classification.ts # mission shape selection
│   │   ├── mission-team-orchestrator.ts # team assembly / flow
│   │   ├── src/pipeline-engine.ts   # ADF pipeline executor
│   │   ├── src/intent-compiler.ts   # structured intent resolution
│   │   ├── error-classifier.ts     # error → category + remediation
│   │   ├── native-tts.ts           # OS-native TTS wrapper (tier 0 voice)
│   │   ├── src/trace.ts            # Trace / Span / persistence
│   │   └── …
│   ├── actuators/          # 23+ actuators
│   │   ├── browser-actuator/       # Web automation and recording
│   │   ├── meeting-actuator/       # Join / leave / speak / listen / chat
│   │   ├── meeting-browser-driver/ # internal browser join helper for meetings
│   └── shared-*/           # Workspace shared libs
│
├── scripts/                # CLI entry points and tooling
│   ├── mission_controller.ts        # mission CLI
│   ├── run_pipeline.ts              # ADF runner
│   ├── onboarding_wizard.ts         # first-run setup
│   ├── voice_upgrade.ts             # tier switch
│   ├── check_*.ts                   # CI checks (esm, contracts, semver, etc.)
│   ├── license_audit.ts             # third-party licenses
│   └── refactor/
│       ├── mission-*.ts             # mission lifecycle internals
│       └── …
│
├── presence/               # User-facing surfaces
│   ├── displays/
│   │   ├── chronos-mirror-v2/       # main browser surface
│   │   ├── presence-studio/         # voice / multimodal surface
│   │   ├── operator-surface/        # operator dashboard
│   │   └── computer-surface/        # screen sharing
│   ├── bridge/                      # surface ↔ core bridge
│   └── sensors/
│
├── satellites/             # Long-running side processes
│   ├── slack-bridge/
│   ├── voice-hub/
│   ├── imessage-bridge/
│   ├── telegram-bridge/
│   └── macos-camera/
│
├── pipelines/              # 75 ADF pipelines (committed)
│   ├── baseline-check.json          # session-start health
│   ├── voice-hello.json             # tier-0 first win
│   ├── chaos-*.json                 # failure-injection drills
│   └── fragments/                   # reusable sub-pipelines
│
├── templates/verticals/    # Pre-built mission seeds for industry use cases
│   ├── finance-ringi-approval/
│   ├── lifestyle-reservation/
│   └── it-saas-inventory/
│
├── customer/               # FDE per-customer config (gitignored)
│   ├── README.md
│   └── _template/                   # template for new customers
│
├── tests/                  # Cross-cutting integration tests
│   └── golden/                      # golden-output snapshots
│
└── migration/              # Per-version migration scripts
```

## 5. The 8 most important files to read (15 min)

If you're going to read 8 files end-to-end, these are the ones:

1. `docs/WHY.md` — the thesis.
2. `docs/PRODUCTIZATION_ROADMAP.md` — the phasing of where we're going.
3. `knowledge/public/architecture/organization-work-loop.md` — the core model.
4. `libs/core/path-resolver.ts` — every file IO starts here.
5. `libs/core/secure-io.ts` — the tier-enforcement boundary.
6. `libs/core/src/pipeline-engine.ts` — the executor.
7. `scripts/mission_controller.ts` + `scripts/refactor/mission-maintenance.ts` — mission lifecycle.
8. `libs/actuators/browser-actuator/src/index.ts` — a complete actuator reference.

After these, the rest of the codebase makes sense by analogy.

## 6. How to make your first PR (10 min)

1. Pick a `good-first-issue` label from the GitHub issue tracker.
2. Read [`CONTRIBUTING.md`](../../CONTRIBUTING.md) (covers the PR contract).
3. Branch from `main`, name it `<type>/<short-description>` (e.g. `fix/tier-guard-test-flake`).
4. Make the change. Run `pnpm validate` locally.
5. Open a PR with a Conventional Commit title (`fix:`, `feat:`, `docs:`, etc.).
6. CODEOWNERS will auto-request a review. Address feedback. Merge.

For governance / decision rules: [`GOVERNANCE.md`](../../GOVERNANCE.md). For who reviews what: [`MAINTAINERS.md`](../../MAINTAINERS.md).

## 7. Where to go next

| Task | Doc |
|---|---|
| Author a new actuator | [`PLUGIN_AUTHORING.md`](./PLUGIN_AUTHORING.md) |
| Customize for an FDE customer | [`CUSTOMER_AGGREGATION.md`](./CUSTOMER_AGGREGATION.md) |
| Add Trace observability to an actuator | [`TRACE_MIGRATION_TEMPLATE.md`](./TRACE_MIGRATION_TEMPLATE.md) |
| Add a vertical mission seed | [`../../templates/verticals/README.md`](../../templates/verticals/README.md) |
| Run a release | [`RELEASE_OPERATIONS.md`](./RELEASE_OPERATIONS.md) |
| Triage incoming issues | [`ISSUE_TRIAGE.md`](./ISSUE_TRIAGE.md) |
| Understand stable vs internal surfaces | [`EXTENSION_POINTS.md`](./EXTENSION_POINTS.md) |

## 8. What to avoid

- **Don't** use `node:fs` directly in production code — use `secure-io`.
- **Don't** skip preflight on ADF — pipelines must validate before they execute.
- **Don't** add behavior to `main()` of a script — extract into a tested function.
- **Don't** add a new actuator manifest without bumping its semver if it changes existing ops.
- **Don't** commit secrets — `secret-actuator` reads from OS keychain. CI rejects committed secrets.
- **Don't** write to `customer/{slug}/` without explicit user consent — that directory is theirs.

If you're tempted to do any of the above, that's a signal to read [`EXTENSION_POINTS.md`](./EXTENSION_POINTS.md).
