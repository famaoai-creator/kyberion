---
title: Kyberion Intent Catalog
category: Architecture
tags: [intent, pipelines, mission-classes, actuators, env-integration, audit, catalog]
importance: 9
last_updated: 2026-04-27
---

# Kyberion Intent Catalog

## 1. Purpose

This document is the canonical inventory of intents users can submit to Kyberion.
It maps human-facing requests to internal pipelines, mission classes, actuators,
and environment integration points so operators know **what to ask for** and
implementers know **what is wired**.

For naming and primitives, see
[`kyberion-canonical-concept-index.md`](knowledge/public/architecture/kyberion-canonical-concept-index.md).
For the human-boundary contract, see [`../../../docs/USER_EXPERIENCE_CONTRACT.md`](docs/USER_EXPERIENCE_CONTRACT.md).

## 2. User-Facing Vocabulary

At the human boundary, only four words are required:

```text
Request -> Plan -> State -> Result
```

Internally, Kyberion maps each Request through:

- **Mission class** (one of 9 canonical classes — see §6)
- **Pipeline(s)** (41 ADF pipelines — see §3-§5)
- **Team composition** (5+ roles auto-assigned per mission)
- **Actuators** (26 capability domains)
- **Reasoning backend** (5 modes, swappable)

## 3. Outcome Intents — get something built or decided

### 3.1 Software delivery

| Use case | Mission class | Primary pipeline(s) |
|---|---|---|
| Implement feature / fix bug / refactor | `code_change` | `implementation-plan` → `execute-task-plan` → `code-review-cycle` |
| Cut a release | `operations_and_release` | `release-package` → `deploy-release` |
| Review a contract / spec | — | `contract-review` |

### 3.2 Customer-facing requirements to delivery

| Use case | Mission class | Pipeline |
|---|---|---|
| Customer interview → requirements draft (text) | `customer_engagement` | `requirements-elicitation` |
| Customer interview → requirements draft (audio) | `customer_engagement` | `audio-to-requirements` |
| Requirements → design spec | `customer_engagement` | `design-from-requirements` |
| Requirements + design → test plan | `customer_engagement` | `test-plan-from-requirements` |
| Plan → tasks → execution | `customer_engagement` | `execute-task-plan` |

Review gates fire at each transition (`REQUIREMENTS_COMPLETENESS`,
`ARCHITECTURE_READY`, `QA_READY`, `CUSTOMER_SIGNOFF`, etc.).

### 3.3 Strategic decision support

| Use case | Mission class | Pipeline |
|---|---|---|
| Generate divergent hypotheses + cross-critique | `decision_support` | `hypothesis-tree` |
| Run counterfactual simulations of branches | `decision_support` | `counterfactual-branch` |
| Capture / formalize an intuition | `decision_support` | `intuition-capture` |
| Strategic executive report | `decision_support` | `ceo-strategic-report` |
| Daily summary | — | `daily-summary` |

The `hypothesis-tree` pipeline now produces a human-readable Markdown report
via `wisdom:render_hypothesis_report` in addition to the structured JSON.

The `counterfactual-branch` pipeline emits two artifacts per run:

- `simulation-summary.json` — LLM-produced branch outcomes
- `simulation-quality.json` — deterministic 6-check rubric
  (`evaluateSimulationQuality`) that flags vacuous output, persona
  imbalance, duplicate branches, or contradictory terminal modes;
  severity is `ok / warn / poor`. Use `wisdom:evaluate_simulation_quality`
  to re-run the rubric against an existing summary post-hoc.

### 3.4 Conversation orchestration

| Use case | Mission class | Primary intent |
|---|---|---|
| Ask for missing context or narrow a vague request | `customer_engagement` | `clarify-user-request` |
| Continue an active thread without resetting context | `customer_engagement` | `continue-conversation` |
| Summarize a discussion into decisions and next steps | `research_and_absorption` | `summarize-conversation` |
| Turn a thread into a governed mission brief | `decision_support` | `conversation-to-mission` |

These intents make human/LLM exchange explicit instead of treating it as an
undifferentiated direct-reply fallback. The key design choice is that the
conversation itself remains the primary object, while mission escalation is
an explicit outcome rather than an implicit side effect.

### 3.4b Schedule coordination

| Use case | Mission class | Primary intent |
|---|---|---|
| Adjust, reschedule, or reconcile calendar constraints | `customer_engagement` | `schedule-coordination` |

Schedule coordination is treated as a governed umbrella over calendar edits
and schedule reshuffling. If the request becomes meeting-specific, Kyberion can
hand off to `meeting-operations` after the schedule boundary is clarified.

### 3.5 CEO / CTO operator harness

| Use case | Mission class | Primary intent |
|---|---|---|
| Compare strategy options and recommend one path | `decision_support` | `executive-strategy-brief` |
| Reduce executive focus to priorities and explicit non-priorities | `decision_support` | `executive-prioritization` |
| Produce executive KPI or management-meeting summaries | `decision_support` | `executive-reporting` |
| Draft stakeholder-facing communication | `customer_engagement` | `stakeholder-communication` |
| Prepare customer or account strategy | `customer_engagement` | `sales-account-strategy` |
| Write a CTO-style technical decision memo | `decision_support` | `technical-decision-memo` |
| Select LLM/provider/model policy for a use case | `environment_and_recovery` | `llm-provider-selection` |
| Plan agent runtime latency, cost, or capacity tuning | `operations_and_release` | `agent-runtime-tuning` |
| Bootstrap or verify the Kyberion runtime | `platform_onboarding` | `bootstrap-kyberion-runtime` / `verify-environment-readiness` |
| Configure reasoning backend or register a new actuator | `platform_onboarding` | `configure-reasoning-backend` / `register-actuator-adapter` |
| Start a first-run onboarding wizard | `platform_onboarding` | `launch-first-run-onboarding` |
| Configure organization-specific toolchain or save presentation preferences | `platform_onboarding` | `configure-organization-toolchain` / `register-presentation-preference-profile` |
| Inspect Kyberion system health or runtime supervisor | `operations_and_release` | `check-kyberion-baseline` / `check-kyberion-vital` / `diagnose-kyberion-system` / `inspect-runtime-supervisor` |
| Start or stop a governed service | `operations_and_release` | `start-service` / `stop-service` |
| Assess release readiness and go/no-go conditions | `operations_and_release` | `release-readiness-review` |
| Extract operator-specific preference learning | `research_and_absorption` | `operator-profile-learning` |

These intents are optimized for an operator who alternates between CEO and CTO
roles. They let Kyberion treat high-leverage executive and technical requests
as named work shapes, while keeping personal adaptation behind explicit
learning proposals.

### 3.6 Stakeholder / negotiation work

| Use case | Pipeline |
|---|---|
| Rehearse a negotiation against a synthetic counterparty persona | `negotiation-rehearsal` |
| Orchestrate stakeholder consensus building | `stakeholder-consensus-orchestrator` |

Built on the relationship-graph + dissent-log protocols.

### 3.7 Content / media

| Use case | Mission class | Pipeline |
|---|---|---|
| Marketing strategy distillation | `content_and_media` | `marketing-strategy` |
| Marketing copy generation | `content_and_media` | `marketing-content` |
| Re-execute marketing iteration | `content_and_media` | `marketing-re-execute` |
| PPTX from a template (ownership-aware) | `content_and_media` | `pptx-template-inherit` |

### 3.8 Platform / API extension

| Use case | Pipeline |
|---|---|
| Add a new FaaS API by conversation | `faas-add-api` |
| Ingest a GitHub issue as a mission | `github-issue-ingest` |

## 4. Environment Integration Intents — adapt Kyberion to your environment

This category covers **making Kyberion fit the operator's organization**. The
`platform_onboarding` mission class wraps the whole flow; individual env vars
and registries below let you tune one piece at a time.

### 4.1 Whole-organization onboarding

`platform_onboarding` mission class — runs `platform-onboarding` pipeline:

```
discovery transcript → requirements draft → design spec → test plan → task plan
```

Required adapters that the pipeline expects you to register:

- `SpeechToTextBridge` (voice input)
- `DeploymentAdapter` (CI/CD trigger)
- `AuditForwarder` (SIEM / log sink)
- `SecretResolver` (HSM / Vault / cloud KMS)

The first-run onboarding UX should make two reusable setup steps explicit:

- first-run onboarding wizard to capture the operator's workspace and goals
- organization toolchain registration for CI/CD, chat, deploy, and audit hooks
- presentation preference registration for brief questions and visual theme hints

Both are stored as governed knowledge so later requests can reuse the same
setup without hard-coded branches.

Repeated coordination work should now be modeled through the shared
`guided-coordination` archetype, with meeting, presentation, booking, video,
schedule, and onboarding playbooks acting as domain overlays rather than
independent one-off flows.

When the deployment serves more than one organization, follow
[`multi-tenant-operations.md`](knowledge/public/architecture/multi-tenant-operations.md) for directory
layout, `tenant-scope-policy.json`, per-tenant adapter routing, and the
single-tenant → multi-tenant migration recipe.

### 4.2 Reasoning backend selection

Mission distillation and other structured reasoning workflows are policy-driven through:

- [`wisdom-policy.json`](/Users/famao/kyberion/knowledge/public/governance/wisdom-policy.json)
- [`Wisdom Policy Adapter Guide`](/Users/famao/kyberion/knowledge/public/governance/wisdom-policy-guide.md)

Use this policy surface to select profiles and adapters without hardcoding provider branches in mission scripts.

| Setting | Env var(s) |
|---|---|
| Mode | `KYBERION_REASONING_BACKEND={claude-cli\|claude-agent\|anthropic\|gemini-cli\|codex-cli\|stub}` |
| Claude CLI | `KYBERION_CLAUDE_CLI_BIN`, `KYBERION_CLAUDE_CLI_MODEL`, `KYBERION_CLAUDE_CLI_TIMEOUT_MS`, `KYBERION_CLAUDE_CLI_EXTRA_ARGS` |
| Gemini CLI | `KYBERION_GEMINI_CLI_BIN`, `KYBERION_GEMINI_CLI_MODEL` |
| Codex CLI | `KYBERION_CODEX_CLI_BIN`, `KYBERION_CODEX_CLI_MODEL`, `KYBERION_CODEX_MODE`, `KYBERION_CODEX_APPROVAL`, `KYBERION_CODEX_MODEL_PROVIDER` |
| Anthropic SDK direct | `ANTHROPIC_API_KEY` |
| Gemini API direct | `GEMINI_API_KEY` |

Auto-selection order for runtime reasoning remains env-driven unless `KYBERION_REASONING_BACKEND` is set. Distillation policy selection is handled separately by `wisdom-policy.json`.

### 4.3 Voice / audio (record → STT/TTS → profile)

| Capability | Configuration |
|---|---|
| Microphone capture | `KYBERION_AUDIO_RECORD_COMMAND` + `voice-sample-recorder` |
| TTS engine catalog | `knowledge/public/governance/voice-engine-registry.json` |
| Voice profile catalog | `knowledge/public/governance/voice-profile-registry.json` |
| Profile lifecycle policy | `voice-runtime-policy.ts` (record → collect → promote) |
| Profile promotion procedure | `knowledge/public/procedures/media/promote-voice-profile.md` |
| STT bridge | `SpeechToTextBridge` contract; shell impl driven by `KYBERION_STT_COMMAND` |
| Audio → requirements | `audio-to-requirements` pipeline |

Sample collection and promotion are themselves missions, so every voice profile
change carries an audit trail.

### 4.4 CI/CD / deployment integration

- `KYBERION_DEPLOY_COMMAND` — shell hook for org-specific deploy trigger
- `KYBERION_DEPLOY_TIMEOUT_MS` — SLA bound
- `release-package` → `deploy-release` pipelines drive the production flow with
  approval gates around each stage

### 4.5 SIEM / audit forwarding

- `KYBERION_AUDIT_FORWARDER_COMMAND` — shell sink (e.g. `logger -t kyberion`)
- `KYBERION_AUDIT_FORWARDER_URL` + `KYBERION_AUDIT_FORWARDER_HEADERS` — HTTP
  sink (Splunk HEC, Datadog Logs API, etc.)
- `KYBERION_AUDIT_FORWARDER_TIMEOUT_MS`

The local hash-chained `audit-chain` stays authoritative; the forwarder is a
non-blocking publish.

### 4.6 Secret management

`SecretResolver` contract — register a chain (`ChainSecretResolver`) of
provider-specific resolvers (AWS Secrets Manager, HashiCorp Vault,
CloudHSM, etc.). All secret reads land on the audit chain.

### 4.7 Actuator inventory and adapters

26 actuators currently registered:

```
agent  android  approval  artifact  blockchain  browser  code  daemon
file  ios  media  media-generation  modeling  network  orchestrator
physical-bridge  presence  process  secret  service  system  terminal
video-composition  vision  voice  wisdom
```

Each actuator publishes:

- A schema (`schemas/<actuator>-action.schema.json`)
- Example actions in `libs/actuators/<actuator>/examples/`
- Tests covering the action contract

`agent-provider-check` pipeline verifies the registered reasoning backend and
adapter wiring for the current environment.

### 4.8 System self-upgrade

| Pipeline | Use |
|---|---|
| `system-upgrade-check` | Diagnose whether an upgrade is safe to attempt |
| `system-upgrade-execute` | Apply the upgrade |

## 5. Audit / Operations Intents — observe what is running

### 5.1 Health and diagnostics

| Pipeline | What it surfaces |
|---|---|
| `baseline-check` | Session-start gate: needs_recovery / needs_onboarding / needs_attention / all_clear / fatal_error |
| `vital-check` | Critical metrics snapshot |
| `full-health-report` | Full-stack health |
| `system-diagnostics` | Detailed diagnostics |
| `dev-productivity-audit` | Engineering productivity signals |
| `agent-provider-check` | Reasoning provider connectivity |
| `ceo-strategic-report` | Executive dashboard aggregation |
| `daily-summary` | Today's activity rollup |

### 5.2 Mission and knowledge auditing

- `mission_controller list [status]` — mission inventory
- `mission_controller status <ID>` — checkpoint history, git refs
- `audit-chain` ledger (hash-chained, tamper-evident) → forwarded to SIEM
- `intent-snapshot-store` → temporal record of every intent decision
- `policy-engine` policies in `knowledge/public/governance/*.json`

### 5.3 Contract and tier validation

| Command | Purpose |
|---|---|
| `pnpm run check:contract-schemas` | All declared contracts validate against their JSON Schemas (CI-required) |
| `pnpm run check:tier-hygiene` | No org-specific names / URLs leaked into the public tier |
| `pnpm run check:governance-rules` | Governance JSONs satisfy their schemas |
| `pnpm run check:catalogs` | Capability catalogs are well-formed |
| `pnpm run check:esm` | ESM import integrity |
| `pnpm run typecheck` | TypeScript correctness |
| `pnpm run validate` | All of the above |

### 5.4 Memory and learning

| Capability | Trigger |
|---|---|
| Distill a completed mission into structured knowledge | `mission_controller distill <ID>` |
| List memory promotion candidates | `mission_controller memory-list` |
| Approve / reject a candidate | `mission_controller memory-approve <ID>` |
| Promote candidate into `knowledge/` | `mission_controller memory-promote <ID>` |
| Post-release retrospective | `post-release-retrospective` pipeline |

Distilled knowledge lands in `knowledge/incidents/` (frozen incidents) or via
the promotion queue in `knowledge/public/`, `knowledge/confidential/`, or
`knowledge/personal/` per the source's tier.

## 6. Mission Classes (canonical set)

```
1. code_change             - default class for source modifications
2. product_delivery        - end-to-end product shipment
3. operations_and_release  - operations / release
4. customer_engagement     - customer-facing engagement / requirements
5. decision_support        - strategic decision support
6. content_and_media       - content generation
7. platform_onboarding     - environment integration
8. environment_and_recovery - incident recovery / session resume
9. research_and_absorption - cross-codebase research / external absorption
```

Classification rules live in
`knowledge/public/governance/mission-classification-policy.json`.
Per-class workflows are defined in
`knowledge/public/governance/mission-workflow-catalog.json`.
Review gates per class are in
`knowledge/public/governance/mission-review-gate-registry.json`.

## 7. Cross-Device / Handoff Intents

| Use case | Pipeline |
|---|---|
| Hand off mobile webview state (Android) | `mobile-webview-handoff-runner-android` |
| Hand off mobile webview state (iOS) | `mobile-webview-handoff-runner-ios` |
| Hand off web session state | `web-session-handoff-runner` |

The handoff envelope is canonicalized in
[`schemas/cross-device-handoff.schema.json`](schemas/cross-device-handoff.schema.json)
(`envelope_version: "1.0.0"` — handoff_id, expires_at, source/target
surface, surface_state.contract_ref, secret_refs, replay-bounded policy,
audit-chain anchors).

Operator obligations — checklist before export, checklist before import,
failure modes (`reject_and_log` / `fall_back_to_clean_session` /
`prompt_operator`), replay protection, and security considerations — live
in [`../procedures/system/cross-device-handoff-operations.md`](knowledge/public/procedures/system/cross-device-handoff-operations.md).

## 8. Invocation Patterns

### 8.1 One-shot pipeline (low overhead)

```bash
pnpm pipeline --input pipelines/<name>.json --context '<json>'
```

If `MISSION_ID` env is set, `mission_dir`, `mission_evidence_dir`, and
`mission_tier` are auto-injected into the pipeline context.

### 8.2 Mission-tracked execution (governance + replay)

```bash
node dist/scripts/mission_controller.js create MSN-XXX
node dist/scripts/mission_controller.js start MSN-XXX
pnpm pipeline --input pipelines/<name>.json --context '...'
node dist/scripts/mission_controller.js checkpoint <task-id> "<note>"
node dist/scripts/mission_controller.js verify MSN-XXX verified "<note>"
node dist/scripts/mission_controller.js distill MSN-XXX
node dist/scripts/mission_controller.js finish MSN-XXX
```

Each mission gets:

- An independent Git repository (atomic rollback)
- Auto-assembled team (5 roles minimum)
- Hash-chained audit ledger entries
- An evidence directory under the right tier

### 8.3 Natural-language entrypoint

User utterance flows through:

1. `intent-extractor` (LLM) — normalize utterance into structured intent
2. `intent-resolution-contract` — bind to mission class
3. `mission-classification-policy` — derive class from hints / utterance / task type
4. `mission-workflow-catalog` — pick the phase sequence
5. `team-role-index` — auto-assemble 5+ roles
6. Pipeline execution begins; each phase has its own gate

## 9. When to Mission vs One-shot

Per `AGENTS.md` Rule 7, mission the work when **any 2** of the following hold:

1. 5+ artifacts will be produced
2. External / regulatory audience for the deliverable
3. Re-execution / variant exploration is likely
4. Same pattern will recur ≥5 times
5. Multiple legitimate viewpoints would improve quality

Otherwise a one-shot pipeline is fine.

## 10. Coverage Snapshot (2026-04-27)

| Layer | State |
|---|---|
| Intent intake (text / audio / photo / email) | All four routes implemented |
| Reasoning backends (Claude / Gemini / Codex / Anthropic / stub) | 5 modes, swappable |
| Mission lifecycle | create → start → checkpoint → verify → distill → finish |
| Pipeline runner (wisdom dispatch + tier-aware paths) | End-to-end |
| Persona divergence + cross-critique | Verified with stub and `claude-cli` |
| Markdown report rendering | `wisdom:render_hypothesis_report` |
| Audit chain (tamper-evident) | Local + SIEM forwarder |
| Knowledge distill / memory promotion | + human approval queue |
| Voice profile registry | Active |
| Contract schema validator | Active, CI-required |
| Cross-device handoff | Envelope schema v1.0.0 + operator runbook |
| Multi-tenant operations | Playbook + scope policy specified (runtime tenant_slug enforcement is future work) |
| Counterfactual quality rubric | 6 deterministic checks, severity `ok / warn / poor`, runs after every `simulate_all` |
| Operator surface strategy | CLI-first + read-only Web fixed; MOS MVP spec'd |

## 11. Known Gaps (and how they are now addressed)

| Gap | Status | Reference |
|---|---|---|
| Cross-device UX (mobile / browser handoff) | **Documented** — handoff envelope schema + operations runbook published | [`schemas/cross-device-handoff.schema.json`](schemas/cross-device-handoff.schema.json), [`../procedures/system/cross-device-handoff-operations.md`](knowledge/public/procedures/system/cross-device-handoff-operations.md) |
| Multi-tenant operations | **Playbook published** — directory conventions, tenant scope policy, per-tenant adapter guidance, migration from single-tenant | [`multi-tenant-operations.md`](knowledge/public/architecture/multi-tenant-operations.md) |
| Counterfactual simulation quality (LLM non-determinism) | **Hardened** — deterministic 6-check rubric (`evaluateSimulationQuality`) runs after every `simulate_all`; severity `ok / warn / poor` written next to summary; standalone `wisdom:evaluate_simulation_quality` op for retro-checks | [`libs/actuators/wisdom-actuator/src/decision-ops.ts`](libs/actuators/wisdom-actuator/src/decision-ops.ts) |
| GUI / Web UI for operators | **Strategy fixed** — CLI-first, read-only Web second, no mutating GUI; Minimum Operator Surface (MOS) MVP spec'd with acceptance criteria | [`operator-surface-strategy.md`](knowledge/public/architecture/operator-surface-strategy.md) |

Remaining genuine gaps:

**Improvements landed 2026-04-27** (MSN-IP-IMPLEMENTATION-20260427):

- ✅ **`tier-guard` tenant enforcement** — `IdentityContext.tenantSlug`
  populated from `KYBERION_TENANT` / `mission-state.json`;
  `validateWritePermission` and `validateReadPermission` now reject
  cross-tenant `confidential/{other}/` access; SUDO bypass preserved
  ([`tier-guard.ts`](libs/core/tier-guard.ts), tests in
  [`tier-guard-tenant.test.ts`](libs/core/tier-guard-tenant.test.ts)).
- ✅ **`audit-chain` `tenantSlug`** — first-class additive field on
  `AuditEntry`; `record()` auto-fills from identity context;
  `TenantFilteringAuditForwarder` available for per-tenant SIEM routing.
- ✅ **Counterfactual ensemble + uncertainty quantification** —
  `simulateAllEnsemble` runs N rounds and writes `simulation-ensemble.json`;
  `evaluateEnsembleConvergence` produces a per-branch convergence score
  and raises `divergent_outcomes_warning` below threshold.
- ✅ **Counterfactual degradation policy** —
  [`counterfactual-degradation-policy.json`](knowledge/public/governance/counterfactual-degradation-policy.json)
  formalizes warn/poor handling, re-execution limits, and override
  rules.
- ✅ **Tenant-drift watchdog** — `pnpm watch:tenant-drift` scans
  `confidential/{slug}/` paths and reports declared vs. expected tenant
  mismatches; emits an `integrity_check` audit event on findings.
- ✅ **Rubric override audit event** —
  `mission_controller accept-with-override <id> --reason "..." [--severity warn|poor]`
  emits `rubric.override_accepted` per the degradation policy.
- ✅ **Rubric scope disclosure template** —
  [`rubric-disclosure-template.md`](knowledge/public/procedures/system/rubric-disclosure-template.md)
  is now mandatory companion to any externally-shared simulation output.
- ✅ **MOS security baseline** — `operator-surface-strategy.md` §9.1
  acceptance criteria now require SSRF tests, WAF placement, and
  independent auth review before any external exposure; §9.2 documents
  the alternative "structured CLI → existing dashboard" path.
- ✅ **Independent validation evidence package** —
  [`independent-validation-evidence-package.md`](knowledge/public/governance/independent-validation-evidence-package.md)
  defines the SR-11-7-class bundle hand-off contract for external
  model-risk validators.
- ✅ **Multi-tenant onboarding runbook** — `multi-tenant-operations.md`
  §5b now contains an 8-week first-tenant runbook with concrete weekly
  milestones derived from the outcome simulation.

**Closed in 2026-04-27 MOS sprint**:

- ✅ **MOS Next.js MVP** — `presence/displays/operator-surface/` ships a
  read-only Next.js 15 app: mission list, mission detail, audit
  timeline, health summary, intent-snapshots placeholder, knowledge
  browser. `KYBERION_TENANT` filters every loader. Acceptance criteria
  §9 met (no write API, multi-tenant scope, copy-able commands).
  Security baseline §9.1: filesystem read sandbox enforced by
  contract test (`test/no-write-api.test.ts` — fails CI on any
  mutating import). WAF / SSRF / OIDC items remain deployment-time
  obligations as documented in the MVP README.

**Closed in 2026-04-27 follow-up**:

- ✅ **Per-tenant rate limiting** — `tenant-rate-limit-policy.json` +
  `consumeTenantBudget` token-bucket limiter. Wisdom dispatcher checks
  budget before every reasoning-cost op (`a2a_fanout`, `cross_critique`,
  `simulate_all`, etc.). Exempt personas (`sovereign`,
  `ecosystem_architect`) bypass. State persists to
  `active/shared/runtime/tenant-rate-limit-state.json`.
- ✅ **Validation bundle exporter** — `pnpm export:validation-bundle <MSN-ID>`
  assembles the SR-11-7-class evidence bundle (output / reasoning-context
  / reasoning-environment / audit-story / governance / attestations) per
  `independent-validation-evidence-package.md` §2 with sha256 checksums
  in `manifest.json`.
- ✅ **`mission_controller --tenant-slug <slug>` flag** — `create` and
  `start` accept `--tenant-slug`, validate against
  `^[a-z][a-z0-9-]{1,30}$`, and persist to `mission-state.json` so
  `tier-guard` and `audit-chain` honour the binding.

## 12. References

- [`kyberion-canonical-concept-index.md`](knowledge/public/architecture/kyberion-canonical-concept-index.md)
  — canonical primitives and vocabulary
- [`kyberion-concept-evaluation-2026-04-26.md`](knowledge/public/architecture/kyberion-concept-evaluation-2026-04-26.md)
  — concept evaluation and improvement plan (origin/main 2026-04-26)
- [`../../../docs/USER_EXPERIENCE_CONTRACT.md`](docs/USER_EXPERIENCE_CONTRACT.md)
  — human boundary contract
- [`../../../docs/INTENT_LOOP_CONCEPT.md`](docs/INTENT_LOOP_CONCEPT.md)
  — six-stage intent loop reference
- [`../../../AGENTS.md`](AGENTS.md) — operator rules (Rule 7 = mission threshold)
- [`../governance/mission-classification-policy.json`](knowledge/public/governance/mission-classification-policy.json)
  — class assignment rules
- [`../governance/mission-workflow-catalog.json`](knowledge/public/governance/mission-workflow-catalog.json)
  — per-class phase sequences
- [`../governance/mission-review-gate-registry.json`](knowledge/public/governance/mission-review-gate-registry.json)
  — review gate registry
- [`../orchestration/team-role-index.json`](knowledge/public/orchestration/team-role-index.json)
  — team role definitions
- [`multi-tenant-operations.md`](knowledge/public/architecture/multi-tenant-operations.md)
  — multi-tenant directory conventions, scope policy, migration
- [`operator-surface-strategy.md`](knowledge/public/architecture/operator-surface-strategy.md)
  — CLI-first / read-only-web stance + MOS MVP spec
- [`../procedures/system/cross-device-handoff-operations.md`](knowledge/public/procedures/system/cross-device-handoff-operations.md)
  — handoff runbook (envelope expiry, replay protection, security)
