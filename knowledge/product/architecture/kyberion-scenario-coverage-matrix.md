---
title: Kyberion Scenario Coverage Matrix
category: Architecture
tags: [audit, coverage, scenarios, roles, matrix]
importance: 9
last_updated: 2026-04-27
---

# Kyberion Scenario Coverage Matrix

This document audits which user-story scenarios Kyberion currently
covers end-to-end, partially, or not at all. It complements
[`kyberion-intent-catalog.md`](knowledge/product/architecture/kyberion-intent-catalog.md) (which
maps intents to surfaces) by approaching from the user-story angle and
producing a matrix that maintainers can scan for gaps.

Snapshot date: 2026-04-27. Reviewed against the implementation in this
repository at the same date.

## How to read this document

- ✅ — fully implemented and operationally verified
- ☐ — partially implemented; specific gap noted
- 📝 — by design a deployment-time obligation, not a code feature

Each row identifies an entry point (CLI command, env var, pipeline) and
the canonical surface(s) involved.

## A. Outcome scenarios — intent → deliverable

| # | Scenario | Entry | Flow | Status |
|---|---|---|---|---|
| A1 | Code change (feature / fix / refactor) | `mission_controller create` (`code_change`) | `implementation-plan` → `execute-task-plan` → `code-review-cycle` | ✅ |
| A2 | Customer requirement → working feature | `requirements-elicitation` or `audio-to-requirements` | `design-from-requirements` → `test-plan-from-requirements` → `execute-task-plan` → `release-package` → `deploy-release` | ✅ |
| A3 | Strategic decision support | `decision_support` mission | `hypothesis-tree` (with prior-knowledge injection) → `counterfactual-branch` (ensemble + UQ) → `dissent-log` | ✅ |
| A4 | Multi-perspective hypothesis tree | `hypothesis-tree` | divergePersonas + crossCritique + render report | ✅ |
| A5 | Counterfactual scenario simulation | `counterfactual-branch` | fork → simulate (single or N-run ensemble) → quality rubric → convergence | ✅ |
| A6 | Stakeholder consensus / nemawashi | `stakeholder-consensus-orchestrator` | relationship graph → readiness matrix → recommend | ✅ |
| A7 | Negotiation rehearsal | `negotiation-rehearsal` | counterparty persona → roleplay → debrief | ✅ |
| A8 | Marketing strategy / content | `marketing-strategy` / `marketing-content` | distill → render | ✅ |
| A9 | Add a FaaS API by conversation | `add-api.sh` → `faas-add-api` | NL → schema → CDK → Lambda | ✅ |
| A10 | GitHub issue → mission | `github-issue-ingest` | issue text → mission scaffold | ✅ |
| A11 | Calendar reschedule / schedule coordination | `schedule-coordination` | schedule brief → summary / handoff | ✅ |

## B. Operations / day-2

| # | Scenario | Entry | Status |
|---|---|---|---|
| B1 | Session start health check | `pnpm pipeline --input pipelines/baseline-check.json` | ✅ |
| B2 | Mission lifecycle | `mission_controller {create,start,checkpoint,verify,distill,finish}` | ✅ |
| B3 | Health pipelines (7) | `vital-check` / `full-health-report` / `system-diagnostics` / `dev-productivity-audit` / `agent-provider-check` / `daily-summary` / `ceo-strategic-report` | ✅ |
| B4 | Audit chain inspection | `cat active/audit/system-ledger.jsonl` or MOS `/audit` | ✅ |
| B5 | Read-only Web (MOS) | `pnpm dev` in `presence/displays/operator-surface` | ✅ |
| B6 | Recovery from interruption | `mission_controller resume` | ✅ |
| B7 | System self-upgrade | `system-upgrade-check` → `system-upgrade-execute` | ✅ |

## C. Multi-tenant

| # | Scenario | Entry / mechanism | Status |
|---|---|---|---|
| C1 | First paying-tenant launch (8 weeks) | `multi-tenant-operations.md` §5b | ✅ |
| C2 | Tenant-scoped mission creation | `mission_controller create --tenant-slug <slug>` | ✅ |
| C3 | Cross-tenant access denial | `tier-guard.checkTenantScope` + `tenant.scope_violation` event | ✅ |
| C4 | Tenant drift watchdog | `pnpm watch:tenant-drift` | ✅ |
| C5 | Per-tenant SIEM routing | `TenantFilteringAuditForwarder` | ✅ |
| C6 | Per-tenant rate limit | `tenant-rate-limit-policy.json` + `consumeTenantBudget` | ✅ |
| C7 | Cross-tenant knowledge promotion | `mission_controller memory-promote` + tier-hygiene gate | ✅ |
| C8 | Brokered mission flow | `cross_tenant_brokerage` in mission state + `tier-guard` exception + `tenant.broker_access` event + protocol doc | ✅ |

## D. Governance / compliance

| # | Scenario | Mechanism | Status |
|---|---|---|---|
| D1 | Review gates | `mission-review-gate-registry.json` + `evaluate*Gate()` | ✅ |
| D2 | Approval gate before risky changes | `policy-engine` + `approval-gate` | ✅ |
| D3 | Counterfactual rubric override | `mission_controller accept-with-override --reason --severity` → `rubric.override_accepted` | ✅ |
| D4 | Degradation policy | `counterfactual-degradation-policy.json` | ✅ |
| D5 | Tier hygiene | `pnpm run check:tier-hygiene` (CI) | ✅ |
| D6 | Contract schema validation | `pnpm run check:contract-schemas` (CI) | ✅ |
| D7 | MOS no-write-API + SSRF guard | `pnpm run check:mos-no-write-api` (CI) | ✅ |
| D8 | Rubric scope disclosure | `rubric-disclosure-template.md` | ✅ |

## E. Knowledge accumulation

| # | Scenario | Mechanism | Status |
|---|---|---|---|
| E1 | Mission distill | `mission_controller distill` → `knowledge/product/evolution/distill_*.md` | ✅ |
| E2 | Memory promotion queue | `memory-list` / `memory-approve` / `memory-promote` | ✅ |
| E3 | Cross-tenant promotion | `memory-promote` + tier-hygiene + `multi-tenant-operations.md §7` | ✅ |
| E4 | Post-release retrospective | `post-release-retrospective` pipeline | ✅ |
| E5 | Distill auto-reuse on new missions | `wisdom:inject_prior_knowledge` op + `findRelevantDistilledKnowledge`; runs as the first step in `hypothesis-tree.json` | ✅ |

## F. Cross-device / handoff

| # | Scenario | Mechanism | Status |
|---|---|---|---|
| F1 | iOS WebView state handoff | `mobile-webview-handoff-runner-ios` + `cross-device-handoff.schema.json` | ✅ |
| F2 | Android WebView state handoff | `mobile-webview-handoff-runner-android` | ✅ |
| F3 | Web session handoff | `web-session-handoff-runner` | ✅ |
| F4 | Replay / expiry guard | envelope `expires_at` + `max_replay_count` + dedup ring | ✅ |

## G. Voice / audio

| # | Scenario | Mechanism | Status |
|---|---|---|---|
| G1 | Microphone capture | `KYBERION_AUDIO_RECORD_COMMAND` + `voice-sample-recorder` (capture boundary) | ✅ |
| G2 | STT (audio → text) | `SpeechToTextBridge` + `KYBERION_STT_COMMAND` (bridge boundary) | ✅ |
| G3 | Audio → requirements | `audio-to-requirements` | ✅ |
| G4 | TTS / synthesis | `voice-engines/*.json` + `voice-engine-registry.json` snapshot + `voice-actuator` + `AudioBus` | ✅ |
| G5 | Voice profile management / promotion | `voice-profile-registry.json` + `promote-voice-profile.md` | ✅ |
| G6 | Real-time meeting coaching | `real-time-coaching-protocol.md` + `meeting-actuator` (`join` / `leave` / `speak` / `listen` / `chat` / `status`) + `meeting-browser-driver` + `AudioBus` + `pipelines/meeting-proxy-workflow.json` | ✅ |

## H. External validation (regulated finance)

| # | Scenario | Mechanism | Status |
|---|---|---|---|
| H1 | Validation bundle export | `pnpm export:validation-bundle <MSN-ID>` | ✅ |
| H2 | Operator attestations | `attestations/README.md` shape | ✅ (manual signing process) |
| H3 | Independent reproducibility from bundle | bundle includes prompts / model versions / governance / audit excerpt / sha256 manifest | ✅ |

## I. Environment integration

| # | Scenario | Mechanism | Status |
|---|---|---|---|
| I1 | Reasoning backend selection | `KYBERION_REASONING_BACKEND={claude-cli\|anthropic\|gemini-cli\|codex-cli\|claude-agent\|nemotron-api\|local\|stub}` | ✅ |
| I2 | CI/CD adapter | `DeploymentAdapter` + `KYBERION_DEPLOY_COMMAND` | ✅ |
| I3 | SIEM forwarder | `audit-forwarder.ts` + `TenantFilteringAuditForwarder` | ✅ |
| I4 | Secret resolver (Vault / HSM / KMS) | `SecretResolver` chain | ✅ |
| I5 | STT bridge | `SpeechToTextBridge` | ✅ |
| I6 | Audit ledger storage policy | local hash-chain authoritative + forwarder | ✅ |
| I7 | Whole-org onboarding | `platform-onboarding` pipeline | ✅ |
| I8 | Kyberion runtime bootstrap / readiness | `bootstrap-kyberion-runtime` / `verify-environment-readiness` | ✅ |
| I9 | Kyberion system observability | `check-kyberion-baseline` / `check-kyberion-vital` / `diagnose-kyberion-system` / `inspect-runtime-supervisor` | ✅ |
| I10 | Governed service lifecycle | `start-service` / `stop-service` | ✅ |
| I11 | Organization toolchain setup | `configure-organization-toolchain` | ✅ |
| I12 | Presentation preference registration | `register-presentation-preference-profile` | ✅ |
| I13 | First-run onboarding wizard | `launch-first-run-onboarding` | ✅ |

## J. Recovery / incidents

| # | Scenario | Mechanism | Status |
|---|---|---|---|
| J1 | Network interruption | `mission_controller resume` | ✅ |
| J2 | Mission crash | independent mission Git repo | ✅ |
| J3 | Cross-system policy violation | `tenant.scope_violation` + `tier-hygiene` lint | ✅ |
| J4 | Security incident response | `security-incident-response.md` procedure | ✅ |
| J5 | Compensating control during transition | `tenant-drift watchdog` | ✅ |

## K. Operator UX surfaces

| # | Surface | Coverage | Status |
|---|---|---|---|
| K1 | CLI (primary) | `mission_controller` / `pnpm pipeline` / `pnpm run validate` / `pnpm export:validation-bundle` / `pnpm watch:tenant-drift` | ✅ |
| K2 | MOS read-only Web | 5 pages + `mos.read` events + tenant scope | ✅ |
| K3 | Chronos-mirror-v2 (ambient display) | existing presence app | ✅ |
| K4 | Mobile (handoff target) | iOS / Android WebView | ✅ |
| K5 | Voice interactive | `a2a_roleplay` / `runRoleplaySession` + `pipelines/voice-recording-session.json` / `voice-learning-setup.json` / `voice-instant-clone.json` + `meeting-proxy-workflow.json` + `meeting-browser-driver` + `AudioBus` + `knowledge/product/agents/meeting-proxy.agent.md` template (per-operator instances under `knowledge/personal/agents/`) | ✅ |

## L. Developer / Platform engineer

| # | Scenario | Entry | Status |
|---|---|---|---|
| L1 | New actuator | `libs/actuators/<name>/` + schema + examples + tests | ✅ |
| L2 | New pipeline | `pipelines/<name>.json` + new `wisdom:` op when needed | ✅ |
| L3 | Reasoning backend extension | `libs/core/<backend>-reasoning-backend.ts` + bootstrap | ✅ |
| L4 | Developer onboarding workflow | [`developer-onboarding.md`](knowledge/public/procedures/system/developer-onboarding.md) | ✅ |
| L5 | Tier-hygiene safety net | `pnpm run check:tier-hygiene` | ✅ |

## M. CISO / Security lead

| # | Scenario | Mechanism | Status |
|---|---|---|---|
| M1 | Tenant isolation enforcement | `tier-guard tenant scope` + watchdog | ✅ |
| M2 | Audit chain integrity | hash-chained + parent_hash continuity | ✅ |
| M3 | Per-tenant SIEM | `TenantFilteringAuditForwarder` | ✅ |
| M4 | Secret leak prevention | `SecretResolver` + audit emission | ✅ |
| M5 | MOS attack surface | no-write-API + SSRF static guard + `mos.read` events | ✅ |
| M6 | WAF / OIDC / mTLS | deployment-time obligation | 📝 |
| M7 | Pen test cadence | quarterly per `multi-tenant-operations.md §5b Week 5` | ✅ runbook |

## Summary

```
✅ Fully covered:    71
☐ Partial:           0
📝 Deployment-time:  1 (M6 WAF / OIDC / mTLS)
❌ Not covered:      0
```

All in-code scenarios are now fully covered. The single 📝 item is
intentional: WAF / OIDC / mTLS are perimeter concerns that the deploying
organization owns, not Kyberion code.

**G6 / K5 closure (2026-04-27 takeover)**: the real-time voice +
meeting proxy track was previously ☐. The takeover generalized the
identity-bound assets (Ichimura-specific files moved to
`knowledge/personal/agents/`), introduced a public-tier
`meeting-proxy.agent.md` template, generalized the voice cloning
pipelines to be persona-parameterized, replaced broken op references
in `meeting-proxy-workflow.json` with real ops (`wisdom:extract_requirements`
+ `meeting-actuator` shell dispatch), and added schema-validating
contract tests for the meeting-actuator (6 cases pass).

## Cross-references

- [`kyberion-intent-catalog.md`](knowledge/product/architecture/kyberion-intent-catalog.md) — what to ask for
- [`kyberion-canonical-concept-index.md`](knowledge/product/architecture/kyberion-canonical-concept-index.md) — primitives and vocabulary
- [`multi-tenant-operations.md`](knowledge/product/architecture/multi-tenant-operations.md) — multi-tenant operational baseline
- [`operator-surface-strategy.md`](knowledge/product/architecture/operator-surface-strategy.md) — UI strategy
- [`../procedures/system/developer-onboarding.md`](knowledge/public/procedures/system/developer-onboarding.md) — developer first month
- [`../orchestration/cross-tenant-brokering-protocol.md`](knowledge/product/orchestration/cross-tenant-brokering-protocol.md) — brokering protocol
