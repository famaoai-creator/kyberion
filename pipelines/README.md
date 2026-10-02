# Pipelines

## Directory Layout

```
pipelines/
  *.json          ← Kyberion system operation pipelines (self-ops only)
  *.yml           ← Legacy YAML skill-chain files (system scope)
  fragments/      ← Reusable step groups (core:include targets)

knowledge/product/pipeline-templates/
                  ← Canonical user-facing pipeline patterns (parameterized, no personal data)
                    Tenants instantiate these into their own namespace before running.
                    See `knowledge/product/pipeline-templates/README.md` for the preflight requirement.
```

**Scope rule:**

- `pipelines/` contains only pipelines that operate Kyberion itself — health checks, self-repair, onboarding, capability assimilation, chaos tests.
- User-facing workflows (voice, meeting, sales, content, etc.) live as **templates** in `knowledge/product/pipeline-templates/`.
- Tenant-specific instantiations go in `knowledge/confidential/{tenant}/pipelines/` or `knowledge/personal/pipelines/`.
- A tenant pipeline that declares `schedule` in `knowledge/confidential/{tenant}/pipelines/*.json` (direct children only) is picked up by chronos for **registered, operational** tenants. It runs in a child process bound to that tenant (`KYBERION_TENANT`, `KYBERION_TENANT_SCOPE_REQUIRED=1`, role `chronos_tenant_runner`) and only after an authenticated human approved its current content via `pnpm kyberion project-trust request <path>` → `pnpm kyberion approve <id> project-trust` (any edit invalidates the approval). Symlinked paths are refused. Run-time needs (credential scope, reasoning backend, tenant egress overlay) are declared in the ADF `runtime` block and injected only into that child process, bounded by `{knowledge_root}/governance/pipeline-runtime-allowlist.json`; the daemon needs no `AUTHORIZED_SCOPE`. Details: [tenant-bound-runtime-probing](../knowledge/product/governance/tenant-bound-runtime-probing.md).

**Workflow composition:**

- A step may select `facets.persona`, `facets.policies`, `facets.instructions`, and `facets.output_contract`.
- A step may declare `reasoning.provider`, `reasoning.profile`, `reasoning.model`, `reasoning.permission_mode`, `reasoning.tags`, and thresholded `reasoning.promotion`.
- Resolution is fail-closed and traceable: environment override → promotion → step declaration → policy routing by step/tag/persona → pipeline default → governed policy. Tenant facets are available only inside a matching non-public tenant scope.
- Validate facet purity with `pnpm check -- --only facet-purity`; validate the complete repository contract with `pnpm run validate`.

**Running a system pipeline:**

```bash
node dist/scripts/run_pipeline.js --input pipelines/<name>.json
# or shortcut:
pnpm pipeline --input pipelines/<name>.json
```

**Running a template directly (dev/testing only):**

```bash
node dist/scripts/run_pipeline.js --input knowledge/product/pipeline-templates/<name>.json
```

**Trust boundary:** only paths under `pipelines/` and
`knowledge/product/pipeline-templates/` are the pre-trust executable surface.
A pipeline anywhere else (e.g. `active/shared/tmp/`) fails with
`[TRUST_REQUIRED]` unless its exact human approval is supplied:
`pnpm kyberion project-trust request <path>` → `pnpm kyberion approve <id> project-trust`
→ `pnpm pipeline --input <path> --project-trust-approval <id>` (edits
invalidate the approval). For discovery/scratch iteration, place the draft
pipeline under `pipelines/` and remove or promote it afterwards — that keeps
ad-hoc runs on the governed surface instead of bypassing trust.

---

## What logic belongs in a pipeline

Pipelines are declarative wiring plus a governance envelope (trace, replay, budgets, guardrails). Keep logic in the layer that owns it (→ [LAYERED_EXECUTION_PLAN](../docs/developer/improvement-plans-archive/2026-07/LAYERED_EXECUTION_PLAN_2026-07-15.ja.md)):

| Belongs in the pipeline                                                                                         | Belongs in a typed actuator op (TypeScript)                                   |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Sequential step wiring, `produces`/`consumes` channels (`sensitive: true` keeps a value out of the run journal) | State-driven loops (repeat until a computed condition, accumulate-and-decide) |
| Data-driven `core:foreach` over a known list                                                                    | Computation, data shaping, sorting/dedup                                      |
| Scenario-level `core:if` (e.g. include a login fragment)                                                        | Result verification ("did the actuator really succeed?")                      |
| Approval gates, budgets, `on_error` strategy                                                                    | Waiting/retry semantics (auto-wait belongs to the op, like browser ops)       |
| Semantic briefs handed to `reasoning:*`/`wisdom:*`                                                              | Anything you are tempted to write inside `core:transform` `script`            |

Rules of thumb:

- `core:transform` is for small glue only. Scripts longer than the governance limit (default 400 chars) trigger the `transform-script-oversized` guardrail warning — move that logic into a typed op with an input/output contract.
- Do not wrap a script with a `system:exec` step just to give it a pipeline name. Expose the script's logic as an actuator op so trace spans, budgets, and error classification reach inside it.
- For visual artifacts (PPTX/doc/video), author semantic content and set `designDefaults` / theme on the protocol — never inline per-element style literals.

## Scratch first, pipeline on reuse

For discovery work (browser exploration, media generation, PPTX/doc/video/web design), do **not** start inside ADF. Prototype as scratch / semantic brief under `active/shared/tmp/` or mission evidence until the result is accepted, then promote — same shape as the video [`scratch-to-pipeline-video-promotion.md`](../knowledge/product/orchestration/scratch-to-pipeline-video-promotion.md). Promote into `pipelines/` or `knowledge/product/pipeline-templates/` only when reuse, CI/validation, or a publish gate needs it.

## System Pipelines

### Health & Diagnostics

| Pipeline                      | pnpm shortcut                                         | Description                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `baseline-check`              | `pnpm pipeline --input pipelines/baseline-check.json` | Session-start health gate (onboarding / recovery / all-clear)                                                                                                |
| `vital-check`                 | `pnpm pipeline vital-check`                           | Core liveness check                                                                                                                                          |
| `system-diagnostics`          | `pnpm pipeline system-diagnostics`                    | Detailed system-level diagnostic report                                                                                                                      |
| `full-health-report`          | —                                                     | Aggregated health across all surfaces                                                                                                                        |
| `monitor-service-health`      | —                                                     | Continuous service health monitor                                                                                                                            |
| `system-upgrade-check`        | `pnpm system:upgrade -- --mode check`                 | Detect available system + dependency upgrades                                                                                                                |
| `system-upgrade-execute`      | `pnpm system:upgrade -- --mode execute`               | Apply upgrades interactively                                                                                                                                 |
| `inspect-system-hardware`     | —                                                     | Hardware and resource inventory                                                                                                                              |
| `inspect-network-environment` | —                                                     | Network topology and connectivity check                                                                                                                      |
| `inspect-workspace-surfaces`  | —                                                     | Active surface and channel inventory                                                                                                                         |
| `agent-provider-check`        | —                                                     | Verify AI provider availability                                                                                                                              |
| `audit-verify-daily`          | —                                                     | Daily audit-chain and system-ledger integrity verification for SA-01. Schedule: `15 4 * * *`.                                                                |
| `health-degradation-watch`    | —                                                     | Hourly degradation watch: latency regressions and provider demotions vs governed thresholds; escalates via ops-alert (OP-04 Task 1). Schedule: `30 * * * *`. |
| `dependency-vuln-scan`        | —                                                     | Daily dependency vulnerability scan and ledger append for AO-02. Schedule: `0 5 * * *`.                                                                      |
| `tenant-drift-watch`          | —                                                     | Daily confidential tenant drift scan using scripts/watch_tenant_drift.ts with alerting enabled. Schedule: `15 5 * * *`.                                      |
| `cowork-integration-review`   | —                                                     | Cowork Integration Review — checks MCP server reachability, surface outbox health, sync-state freshness, and pending approvals.                              |
| `inspect-mission-inventory`   | —                                                     | List the current mission inventory through the mission controller.                                                                                           |

### Feedback Loop (Self-Repair)

| Pipeline                        | Description                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `reconcile-config-fallbacks`    | Auto-repair missing knowledge JSON files recorded during config loader fallbacks |
| `reconcile-unclassified-errors` | Write rule-proposal stubs for errors that matched no classification rule         |
| `reconcile-unhandled-intents`   | Write routing proposals for unrouted or unrecognized surface intents             |

### Onboarding & Provisioning

| Pipeline                         | pnpm shortcut | Description                                                                                                                                   |
| -------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `kyberion-autonomous-onboarding` | —             | LLM-drafted organization profile and interview questions, run by hand (`pnpm pipeline --input pipelines/kyberion-autonomous-onboarding.json`) |
| `launch-first-run-onboarding`    | —             | Interactive first-run setup wizard                                                                                                            |
| `platform-onboarding`            | —             | Organization-integration artifacts: discovery transcript → requirements → design → test plan → task plan                                      |
| `setup-oauth`                    | —             | Interactive pipeline to setup OAuth connection for a specific service                                                                         |

> `pnpm onboarding` is **not** a shortcut for `kyberion-autonomous-onboarding`: it runs the onboarding facade (`scripts/onboarding.ts`, wizard via `onboarding_wizard.ts`). Run the pipeline explicitly with `pnpm pipeline --input pipelines/kyberion-autonomous-onboarding.json`.

### Capability & Knowledge

| Pipeline                        | pnpm shortcut                                                    | Description                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `knowledge-sync`                | `pnpm knowledge:sync`                                            | Alias of `tenant-ingest` (kept for reference stability — pnpm script + MCP allowlist); inlines it via `core:include`                                                                                                                                                                                               |
| `tenant-ingest`                 | `pnpm pipeline --input pipelines/tenant-ingest.json`             | DA-03 incremental ingest sync: `core:foreach` over the `jobs` registry in `knowledge-sync-rules.json` → `ingest:sync_source` (watermark differential listing; advance only on full success, `schedule.cron` daily 02:30 Asia/Tokyo)                                                                                |
| `knowledge-curation-weekly`     | `pnpm pipeline --input pipelines/knowledge-curation-weekly.json` | KP-06 weekly report: scoped low-yield + freshness SLO breaches, two-week `archive_advisory` history, and steward-gated promotion candidates (`schedule.cron` Sun 03:00 Asia/Tokyo; no automatic archival)                                                                                                          |
| `knowledge:scope-reconcile`     | `pnpm knowledge:scope-reconcile`                                 | KO-19 weekly operator report: health, feedback/intent/ledger migration dry-runs, semantic/tier-hygiene checks, tenant weight proposals, and promotion audit continuity; legacy data is never auto-assigned                                                                                                         |
| `i18n-drift-audit`              | `pnpm pipeline --input pipelines/i18n-drift-audit.json`          | I18N-08 weekly report: ratchet baseline movement, per-locale translation-coverage regression (alerted via ops-alert), and unused-key accumulation for translation-ops review (not a gate — `pnpm check -- --only i18n` / `pnpm check -- --only catalogs` remain enforcement, `schedule.cron` Mon 08:00 Asia/Tokyo) |
| `first-win-lifecycle-weekly`    | `pnpm check -- --only first-win-lifecycle`                       | LC-17 weekly dry-run: onboarding → organization → project → mission → schedule tick → meaningful hint generation; no state is applied                                                                                                                                                                              |
| `history-search-refresh`        | —                                                                | Refresh the public zero-LLM conversation/mission history index                                                                                                                                                                                                                                                     |
| `background-review-curator`     | —                                                                | Archive stale background-review proposals without deleting governed records                                                                                                                                                                                                                                        |
| `surface-capability-check`      | —                                                                | Verify the governed surface capability layer and bridge integrations                                                                                                                                                                                                                                               |
| `list-capabilities`             | —                                                                | Enumerate installed actuators and their ops                                                                                                                                                                                                                                                                        |
| `assimilate-gateway-capability` | —                                                                | Ingest an external gateway into the capability registry                                                                                                                                                                                                                                                            |
| `promote-procedure`             | —                                                                | Pattern A → B 昇格: 記録した手順を ProcedureCatalog に登録し、次回から Pattern B で自動実行できるようにする。入力は scripts/promote_procedure.ts 内部で検証・secure-io 経由で書き込み（shell へ untrusted 値を展開しない）。                                                                                       |

### Organization Operations

| Pipeline                      | pnpm shortcut                                                                                      | Description                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organization-daily-digest`   | `KYBERION_PERSONA=sovereign pnpm run pipeline -- --input pipelines/organization-daily-digest.json` | `core:organization_digest` across every organization and tenant (confidential + public): overdue / due-today operations, business-day deadlines, pending decisions, service observation windows, open incidents. Sovereign-only, audited per run; `schedule.cron` daily 08:30 Asia/Tokyo, delivered to the operator DM via `deliver_to.channel: "env:KYBERION_OPERATOR_SLACK_DM"` |
| `accountability-report-daily` | `pnpm run pipeline -- --input pipelines/accountability-report-daily.json`                          | `core:accountability_report`: for every accountability charter in force, what ran inside it, what was held for a decision, budget use, standing tripwires and expiry, sent to the accountable human through operator notifications (same as `approval_inbox charter --send`). Does nothing while no charter is in force; `schedule.cron` daily 08:00 Asia/Tokyo                   |
| `action-item-reminders`       | —                                                                                                  | Daily 09:00 JST reminder sweep across all active missions. Schedule: `0 9 * * *`.                                                                                                                                                                                                                                                                                                 |
| `auto-checkpoint`             | —                                                                                                  | Daily automatic checkpoint pass for active missions. Schedule: `45 5 * * *`.                                                                                                                                                                                                                                                                                                      |
| `mission-hygiene-weekly`      | —                                                                                                  | Weekly dry-run mission hygiene audit via core:run_mission_hygiene — stuck/abandoned missions, purge preview, and empty mission-dir candidates. Schedule: `0 9 * * 3`.                                                                                                                                                                                                             |
| `mesh-delivery`               | —                                                                                                  | AA-02: drive queued Mesh Hub deliveries (claim → HTTP dispatch → ack/retry/dead-letter). Schedule: `*/5 * * * *`, currently `enabled: false` — requires `KYBERION_MESH_PEER_ID`; opt back in per host via `KYBERION_CHRONOS_SCHEDULES=mesh-delivery-5min`.                                                                                                                        |
| `sdlc-cycle`                  | —                                                                                                  | E2E-05 Task 4: one-shot SDLC intake — intent → requirements draft → design spec → task plan → NEXT_TASKS.json (worker contract) → test plan.                                                                                                                                                                                                                                      |
| `contract-review`             | —                                                                                                  | Multi-perspective contract review: digest extraction, multi-agent critique, dissent logging, and written output.                                                                                                                                                                                                                                                                  |

### Verification

| Pipeline                     | Description                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify-session`             | Verify surface session lifecycle                                                                                                                                                                                                                                                                                      |
| `verify-session-fallback`    | Verify session fallback behaviour                                                                                                                                                                                                                                                                                     |
| `service-lifecycle-smoke`    | Service start/stop/health smoke test                                                                                                                                                                                                                                                                                  |
| `orchestration-jobs`         | Run the `orchestration-config.json` job batch by hand (no schedule is declared)                                                                                                                                                                                                                                       |
| `ai-audit`                   | AI audit test layer (KC-05): fan `tests_ai/*.md` semantic invariants out to the reasoning backend, aggregate `report.json` (run: `pnpm ai-test`; weekly schedule; skips on stub backend)                                                                                                                              |
| `agentic-source-code-review` | Threat-model-first source review: deterministic reconnaissance/rule selection, human approval gate, scoped multi-perspective hypotheses, independent critique, and human-only validation handoff                                                                                                                      |
| `ui-voice-browser-smoke`     | End-to-end smoke test: launches presence-studio, runs voice-hello pipeline, verifies browser session, and checks meeting consent gate.                                                                                                                                                                                |
| `soak-endurance`             | Compressed soak / endurance harness for AO-04 with maintenance pulses, resource trend sampling, and fail-closed regression validation. Schedule: `30 5 * * *`.                                                                                                                                                        |
| `soak-endurance-live`        | Daily live soak evidence pulse for OP-04. Schedule: `30 5 * * *`.                                                                                                                                                                                                                                                     |
| `ui-ux-governance-audit`     | Weekly deterministic audit for canonical design tokens and operator-facing UX vocabulary. Schedule: `30 7 * * 1`.                                                                                                                                                                                                     |
| `aws-operations-simulation`  | AWS 運用操作の副作用なし決定的シミュレーション(ドライラン)。変更計画(change-plan)を入力に、terraform plan / aws-cli --dry-run 相当の実行トレース(作成/変更/削除リソース・IAM/権限チェック・影響範囲(blast radius)・切り戻し手順・前提条件の合否)を生成し、実プロビジョニングせずに評価結果を出力する。it-operation... |
| `ce-chronos-perf`            | Weekly browser-dependent CE-08 FPS and JS heap evidence for Chronos. Schedule: `30 3 * * 1`.                                                                                                                                                                                                                          |

### Source Engineering

| Pipeline                          | Description                                                                                                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source-to-engineering-artifacts` | Analyze a workspace source tree and emit an evidence-backed design document, test inventory, safe test scenario pipeline, and proposal-only IaC artifacts under governed active storage.                  |
| `agentic-source-code-review`      | Generate a threat-model plan first; only after explicit human approval does it run scoped static analysis, multi-perspective hypotheses, and independent critique. PoC and remediation remain human-only. |

Example:

```bash
pnpm pipeline --input pipelines/source-to-engineering-artifacts.json \
  --context '{"source_root":".","project_id":"repo-audit","target_provider":"aws","output_dir":"active/shared/tmp/source-engineering"}'
```

The generated `source-test-scenarios.json` may be run after review. Tests with a supported framework and no detected network/process/filesystem mutation are `safe_auto`; side-effect tests become `approval_required`, while inferred routes and unknown frameworks remain deferred. The design document includes dependency/import/export signals, and the IR, inventory, scenario, and IaC outputs are schema-validated before writing. IaC output is never an apply operation.

### Scheduled Operations (Backup, Janitor, Volatile Memory)

Routine cron-driven maintenance. Schedules are registered with chronos.

| Pipeline               | Description                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup-daily`         | Creates an encrypted daily Kyberion state snapshot. Schedule: `15 3 * * *`.                                                                                                                                                     |
| `backup-restore-drill` | Monthly restore drill for OP-02. Restores the latest backup archive into a disposable target and reports whether the archive can be decrypted and extracted. Schedule: `45 3 1 * *`.                                            |
| `storage-janitor`      | Runs governed TTL cleanup for active/shared/tmp, shared logs, data-vault, and runtime retention directories via libs/core/storage-janitor.ts. Schedule: `30 4 * * *`.                                                           |
| `volatile-gc`          | Volatile Knowledge Layer GC — single working-memory:run-gc op that scans all *.volatile.json sidecars, expires ttl/session faces, rolls over daily TODO items, and writes a summary to active/shared/... Schedule: `0 4 * * *`. |
| `volatile-index`       | Volatile Knowledge Layer — regenerates active/INDEX.volatile.{md,json} by scanning all *.volatile.json sidecars. Schedule: `0 5 * * *`.                                                                                         |
| `daily-routine`        | Volatile Knowledge Layer — daily routine: opens today's journal + TODO, rolls over pending items from previous TODO.md. Schedule: `0 6 * * *`.                                                                                  |
| `weekly-review`        | Volatile Knowledge Layer — weekly review: opens the current week's face, then nominates it as a memory-promotion-queue candidate for distillation into knowledge/. Schedule: `0 7 * * 1`.                                       |

### Meeting & Voice

Meeting participation and the voice first-win path (see `docs/user/meeting-facilitator.md`).

| Pipeline                        | Description                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `voice-hello`                   | Minimal voice first-win pipeline: check TTS, speak a greeting.                                                                                                                                           |
| `voice-health-check`            | Verifies the governed voice toolchain: tool runtime inventory, mlx_audio_tts_bridge.py, native TTS, STT bridge availability, and the realtime-loop surfaces (silero VAD bridge script).                  |
| `voice-onboarding`              | One-command voice onboarding: record three reference samples, register the voice profile, generate a short试听 artifact, and grant per-mission voice consent.                                            |
| `create-my-avatar`              | Parameterised avatar onboarding flow that captures a reference photo, generates a stylised expression set from it (per-run consent required for cloud / host-bridge providers), and registers the pho... |
| `meeting-facilitation-workflow` | AI-led meeting session: join → listen N seconds → leave.                                                                                                                                                 |
| `meeting-proxy-workflow`        | Meeting proxy: join with cloned voice → listen → extract action items.                                                                                                                                   |
| `meeting-watcher`               | Calendar-driven auto-join: list today's events, pick the meeting starting now, join with live-caption capture. Schedule: `*/5 * * * *`.                                                                  |
| `meeting-followup`              | Post-meeting follow-up flow: turn a meeting transcript into minutes.md, persist action items to the mission store, and emit a delivery pack for downstream handoff.                                      |

### Media & Reporting

Governed document/deck/video production and executive reporting.

| Pipeline                        | Description                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `campaign-suite`                | E2E-02 Task 6: generate deck/doc/video/web/mv deliverables from one campaign brief under a single resolved design.        |
| `ceo-strategic-report`          | Generates a strategic executive report for CEO decision-making: code analysis, multi-scenario reasoning, and PPTX output. |
| `executive-narrative-bridge`    | Bridges raw analysis into executive-grade narrative: reasoning synthesis, multi-perspective wisdom, and system logging.   |
| `marketing-content`             | Generates brand-aligned marketing materials: diagrams, themed PPTX slides, and merged content output.                     |
| `trial-narrated-report`         | End-to-end narrated executive report: voice narration + video composition with strict ADF preflight.                      |
| `kyberion-vtuber-narrated-demo` | Produce a vtuber-style video that presents Kyberion as a live operator persona with on-air cues, chat, and demo beats.    |

### Chaos & Resilience

| Pipeline                  | Description                                                |
| ------------------------- | ---------------------------------------------------------- |
| `chaos-actuator-down`     | Simulate actuator failure; validate fallback               |
| `chaos-network-partition` | Simulate network partition; validate retry/circuit-breaker |
| `chaos-secret-missing`    | Simulate missing secret; validate secret-guard error path  |

### Feature Validation Envelopes

Replayable acceptance runs for one delivered feature slice: each re-runs that slice's targeted
tests and gates in one command (`pnpm pipeline --input pipelines/<id>.json`). CI already runs the
same tests; use an envelope when re-validating the slice after touching it.

| Pipeline                        | Description                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ce-adoption-validation`        | Claw-empire adoption slice (CE-01..12): full build, core workforce/CE tests, Chronos collaboration-stream/live-sync tests, DOM-contrast gate |
| `cloudflare-os-validation`      | Cloudflare OS control plane (OS-01..15): core control-plane/egress/OAuth tests, service-actuator tests, operator- and computer-surface tests |
| `project-management-validation` | Project control and mission reassignment: project tests, typecheck, package build, Chronos typecheck                                         |
| `qm02-trigger-validation`       | QM-02 trigger unification: core build, trigger-runner/managed-process/scheduler tests, `script-integrity` gate                               |
| `media-review-fix-validation`   | Media review gates: compile a canonical brief and fail on unapproved PPTX layout overflow (deterministic, no rendering)                      |
| `soak-restart-e2e`              | AO-04 soak restart: boots a worker, kills it, resumes and checks that state was restored (`core:run_soak_restart_e2e`)                       |

### Media Demos and Production

| Pipeline                      | Description                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `media-produce-and-review`    | MP-01..07 deck flow: lock brief → design protocol → layout preflight → render → visual review → delivery gate; override `brief_path` / `mission_evidence_dir` with `--context` |
| `generate-design-system-demo` | Diagnostic PPTX exercising all slide-layout presets and core element types; writes `active/shared/exports/design_system_demo.pptx`                                             |
| `generate-masterclass-pptx`   | Layout sample deck from `pipelines/fragments/masterclass_design_protocol.json`; writes `active/shared/exports/all_objects_layout_sample.pptx`                                  |
| `kyberion-product-intro`      | Local narrated product-intro video (ja; no publish). `scripts/kyberion_product_intro_render.ts` renders the same flow directly                                                 |

### Op Entry Points

Minimal runnable pipelines that make an actuator op reachable (OW-05); run them with
`pnpm pipeline --input pipelines/<id>.json`.

| Pipeline                         | Description                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `browser-failure-evidence`       | Capture the redacted browser action trail and export a failure-evidence bundle                        |
| `incident-review`                | List recorded incident notes and run the SRE root-cause analysis over a failure signal                |
| `meeting-hearing-session`        | Run a guided requirements hearing on a topic and export the structured result                         |
| `meeting-tutor-session`          | Run a guided tutoring session over a material file and export the result                              |
| `mission-team-prewarm`           | Queue a team prewarm request so a mission's agent runtimes are ready before work starts               |
| `mission-team-staff`             | Staff a mission's team runtimes through the agent-runtime supervisor and return the plan              |
| `open-active-surfaces`           | Open one browser tab per running UI surface                                                           |
| `terraform-topology-ir`          | Parse a Terraform directory into a topology IR for diagramming or review                              |
| `test-inventory-device-pipeline` | Compile a test inventory and app profile into an Android/iOS device pipeline (proposal; run approved) |

---

### Promoted (pipeline:promote)

Pipelines promoted from successful one-off runs (LC-02). Provenance is recorded in each file under `promotion`.

| Pipeline | pnpm shortcut | Description |
| -------- | ------------- | ----------- |

## Fragments (`pipelines/fragments/`)

Step-group building blocks consumed via `core:include`. Fragments contain no personal data and are safe to compose into any pipeline or template.

```json
{ "op": "core:include", "params": { "path": "pipelines/fragments/common/log-lifecycle.json" } }
```

See `pipelines/fragments/` for the full catalog.

---

## Pipeline Templates (`knowledge/product/pipeline-templates/`)

Canonical user-facing pipeline patterns. These are parameterized (use `{{params.*}}` placeholders) and contain no hardcoded personal data.

**Instantiate a template for your tenant:**

1. Copy the template to `knowledge/confidential/{tenant}/pipelines/{name}.json`
2. Fill in tenant-specific params (endpoints, persona, credentials via `secret:`)
3. Run from the tenant path

Templates cover: voice setup, meeting facilitation, sales workflows, content generation, code review, deployment, analysis, and more. See `knowledge/product/pipeline-templates/` for the full list.

For cross-tool office work, use `productivity-task-orchestration.json` after creating a plan with `pnpm kyberion task plan`. The template is dry-run only: it creates a review package and receipt but performs no calendar write, meeting participation, email send, browser action, payment, or network request.

---

## Op Syntax Reference

Every step `op` uses **`domain:action`** format:

```json
{ "op": "media:pptx_render" }       // media-actuator
{ "op": "wisdom:knowledge_search" } // wisdom-actuator
{ "op": "system:shell" }            // built-in runner
{ "op": "core:if" }                 // built-in control flow
{ "op": "reasoning:analyze" }       // reasoning backend
```

### Pipeline ID Resolution

In `intent-routing-map.json`:

- **Bare ID** (e.g. `"baseline-check"`) → runner prepends `pipelines/`
- **Path ID** (e.g. `"knowledge/product/pipeline-templates/speak-with-my-voice"`) → runner appends `.json` and uses the path as-is

### service-actuator: preset calls

```json
{
  "op": "service:preset",
  "params": {
    "service_id": "backlog",
    "operation": "get_issues",
    "auth": "secret-guard",
    "params": { "space": "your-space", "query": { "projectId[]": [12345], "count": 50 } }
  }
}
```

---

## Path Security

Output paths must be within the project root. Use `active/shared/tmp/` or `active/shared/exports/` as staging areas.

`[ROLE_VIOLATION]` errors mean the active persona/role does not have access to the requested path. Check `knowledge/product/governance/security-policy.json`.

---

## Path Conventions — write portable, machine-independent paths

**Default: write paths as repo-relative.** A relative path like `active/shared/tmp/run.json` or `knowledge/product/x.md` is already portable across machines — it is resolved against the project root at runtime (actuator ops relativize against root, and `system:exec` / `system:shell` run with `cwd` = project root). You almost never need an absolute path in a pipeline.

**Never do:**

- **Machine-absolute paths** — `/Users/<name>/...`, `/home/<user>/...`, `C:\Users\...`. These break the moment the pipeline runs on another machine. The governance lint (`pnpm check -- --only governance-rules`) fails the build on these in committed `knowledge/`, `libs/`, `scripts/`.
- **Leading-slash "repo" paths** — `/knowledge/personal/x.md` is an _absolute_ path pointing at the filesystem root (`/knowledge/...`), **not** the repo. Drop the leading slash: `knowledge/personal/x.md`. (This was a real bug fixed in `system-upgrade-check.json`.)

**When you genuinely need an absolute path at runtime** (e.g. a value handed to an external tool that does not inherit `cwd` = root), resolve it at runtime instead of hardcoding it — keep the source portable:

- **Inline path tokens** in any `{{...}}`-templated field: `{{@root}}`, `{{@knowledge:product/x.md}}`, `{{@shared:tmp/run.json}}`, `{{@active:missions}}`, `{{@tmp:run.json}}`, `{{@vault:...}}`. Each expands to a machine-local absolute path at run time. Unknown domains are left literal.
- **`system:resolve_path` op** (pure, no I/O) — `mode`: `resolve` | `shared` | `knowledge` | `active` | `tmp` | `vault` to expand, and `to_relative` | `normalize` to collapse back.

**Never persist a resolved absolute path.** Tokens / `resolve_path` expand to a machine-local absolute path — fine for transient use this run, but if you write it into a context file, registry, or artifact you have re-introduced a machine-specific path. Before storing a path, collapse it with `system:resolve_path` (`mode: to_relative` or `normalize`) — or `pathResolver.toRepoRelative()` in code — so what lands on disk stays repo-relative.

`KYBERION_ROOT` overrides project-root detection when a pipeline runs from a non-standard working directory.
