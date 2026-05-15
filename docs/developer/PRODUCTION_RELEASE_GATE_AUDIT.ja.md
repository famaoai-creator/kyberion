---
title: Production Release Gate Audit
category: Developer
tags: [production-readiness, release-gate, audit]
importance: 10
last_updated: 2026-05-15
---

# Production Release Gate Audit

この文書は `docs/developer/PRODUCTION_GOAL_INSTRUCTIONS.ja.md` の完了監査である。対象は
`docs/developer/PRODUCTION_READINESS_PLAN.ja.md` の G1-G7 / P0-P3 / S0-S10。

## 結論

現時点の repository patch は P0-P3 の実装 backlog と local release-candidate checks を満たしている。
ただし、ロードマップ上の実利用 KPI（30 日連続稼働、外部 contributor の初回 merge、外部 FDE 導入完了）は
local test だけでは実証できないため、この監査では「production-ready」とは呼ばず、
「release-candidate code gates passed」と扱う。

## Prompt-to-artifact checklist

| 要件 | Evidence | Status |
|---|---|---|
| G1: clean clone から documented command だけで first win | `pnpm pipeline --input pipelines/verify-session.json` completed and wrote `active/shared/tmp/first-win-session.png` (PNG 1280x720). Sandbox では Playwright 起動が OS permission denied になったため、browser runtime execution は承認済み outside-sandbox で確認。 | Pass |
| G2: mission / pipeline / actuator の trace と error classification | `pnpm run validate` includes trace / pipeline / classifier regressions. `pnpm pipeline --input pipelines/baseline-check.json` completed and wrote trace under `active/shared/logs/traces/traces-2026-05-15.jsonl`. | Pass |
| G3: personal / confidential / public と tenant / group scope | `pnpm run test:core` passed 206 files / 1171 tests, including tier-guard and governance regressions. | Pass |
| G4: meeting / voice / browser consent safety | `pnpm run test:ui-voice-browser-smoke`, `pnpm run test:meeting-dry-run`, and `libs/actuators/meeting-actuator/src/index.test.ts` cover consent-denied and consent-granted paths. | Pass |
| G5: doctor / bootstrap detects runtime capability gaps and next action | `pnpm run doctor` reports all required baseline capabilities satisfied. `pnpm doctor:meeting --mission P3-5-REFERENCE-DRIFT-AUDIT` fails closed for missing BlackHole / voice consent and prints `pnpm env:bootstrap --manifest meeting-participation-runtime --apply` plus consent next steps. | Pass for detection / guidance |
| G6: representative scenarios are repeatable by golden / contract / smoke tests | `pnpm run validate`, `pnpm run check:golden`, `pnpm run test:core`, `pnpm run test:ui-voice-browser-smoke`, and actual `verify-session` execution passed. | Pass |
| G7: contributor entrypoints and PR contract are current | `CONTRIBUTING.md`, `docs/developer/TOUR.md`, `docs/developer/EXTENSION_POINTS.md`, `docs/developer/GOOD_FIRST_ISSUES.md`, and `.github/ISSUE_TEMPLATE/good-first-issue-guide.md` are covered by contract tests. | Pass |

## Backlog checklist

| Backlog | Evidence |
|---|---|
| P0-1 doctor / bootstrap | `scripts/run_doctor.ts`, `scripts/environment-doctor.ts`, `knowledge/public/governance/environment-manifests/meeting-participation-runtime.json`, targeted tests, `pnpm run doctor`, `pnpm doctor:meeting --mission ...` |
| P0-2 trace gaps | `scripts/run_pipeline.ts`, trace/audit regressions, baseline/verify-session traces |
| P0-3 tenant / group isolation | `libs/core/tier-guard.ts`, `libs/core/tier-guard-tenant.test.ts`, governance tests |
| P0-4 voice consent / meeting authority | `libs/actuators/meeting-actuator/src/index.ts`, `scripts/voice_consent.ts`, `scripts/meeting_participate.ts`, meeting actuator tests |
| P0-5 pipeline shell independence | `scripts/check_pipeline_shell_independence.ts`, `pnpm run check:pipeline-shell-independence` |
| P0-6 golden scenario catalog schema | `scripts/check_contract_schemas.ts`, governance catalog tests, `pnpm run check:contract-schemas` |
| P0-7 first-win smoke | `pipelines/verify-session.json`, `scripts/check_first_win_smoke.ts`, actual first-win screenshot artifact |
| P1-1 error classifier | `libs/core/error-classifier.ts`, `libs/core/error-classifier.test.ts` |
| P1-2 runtime receipts | `libs/core/environment-capability.ts`, `libs/core/environment-capability.test.ts` |
| P1-3 action lifecycle | `libs/core/action-item-store.ts`, `libs/actuators/wisdom-actuator/src/meeting-ops.test.ts` |
| P1-4 browser participation safety | `libs/core/meeting-participation-coordinator.ts`, meeting browser-driver tests, `test:meeting-dry-run` |
| P1-5 cross-OS representative scenarios | `.github/workflows/cross-os.yml`, `tests/workflow-operations-contract.test.ts` |
| P1-6 release / migration workflow | `docs/developer/RELEASE_OPERATIONS.md`, `CHANGELOG.md`, `migration/README.md`, release contract tests |
| P2-1 first-win docs | `README.md`, `docs/QUICKSTART.md`, `docs/WHY.md`, first-win docs contract |
| P2-2 developer tour alignment | `docs/developer/TOUR.md`, `docs/developer/EXTENSION_POINTS.md`, developer tour contract |
| P2-3 meeting operator docs | `docs/user/meeting-facilitator.md`, `knowledge/public/architecture/meeting-facilitator-use-case.md` |
| P2-4 good-first-issue decomposition | `docs/developer/GOOD_FIRST_ISSUES.md`, `.github/ISSUE_TEMPLATE/good-first-issue-guide.md`, contributing contract |
| P3-1 secure-io boundary | `libs/core/provider-discovery.ts`, `libs/core/security-boundary.contract.test.ts` |
| P3-2 actuator catalog parity | `CAPABILITIES_GUIDE.md`, `schemas/system-pipeline.schema.json`, `libs/actuators/system-actuator/src/op-catalog.test.ts` |
| P3-3 runtime bridge regressions | `scripts/agent_runtime_manager.ts`, runtime bridge targeted tests |
| P3-4 UI / voice / browser smoke | `pipelines/ui-voice-browser-smoke.json`, `test:ui-voice-browser-smoke` |
| P3-5 reference drift audit | `tests/reference-drift-contract.test.ts`, `check:reference-drift` in `pnpm run validate` |

## Commands verified on 2026-05-15

- `pnpm run validate` — passed, including `check:reference-drift` and production evidence status reporting.
- `pnpm run check:production-evidence-status` — reports pending non-local production proof requirements from the canonical JSON register.
- `pnpm run check:production-evidence-complete` — release promotion gate; must fail until every non-local evidence item is reviewed and `verified`.
- `pnpm run check:production-evidence` — verifies the register documentation contract.
- `pnpm run test:core` — passed, 206 files / 1171 tests.
- `pnpm run check:golden` — passed, baseline-check golden.
- `pnpm pipeline --input pipelines/verify-session.json` — passed outside sandbox; wrote `active/shared/tmp/first-win-session.png`.
- `pnpm pipeline --input pipelines/baseline-check.json` — passed.
- `pnpm run doctor` — passed, baseline must / should all satisfied.
- `pnpm doctor:meeting --mission P3-5-REFERENCE-DRIFT-AUDIT` — failed closed as expected because local BlackHole / voice consent are missing; printed bootstrap and consent remediation.
- `pnpm env:bootstrap --manifest meeting-participation-runtime --dry-run` — failed closed as expected and printed install / consent guidance.

## Remaining non-local evidence

These are roadmap KPI / operational evidence items rather than missing code gates. They are tracked in
[`PRODUCTION_EVIDENCE_REGISTER.ja.md`](./PRODUCTION_EVIDENCE_REGISTER.ja.md) and the canonical machine-readable register
`knowledge/public/governance/production-evidence-register.json`:
collection and review steps are defined in [`../operator/PRODUCTION_EVIDENCE_COLLECTION.md`](../operator/PRODUCTION_EVIDENCE_COLLECTION.md).

- 30 日連続稼働 (`docs/PRODUCTIZATION_ROADMAP.md` D2 / Phase B acceptance) is not proven by a single local validation run.
- 外部 contributor が初回 good-first-issue を 1 週間以内に merge できること is not proven until a real external contribution occurs.
- 外部 FDE / SI が fork なしで 1 件の顧客導入を完了すること is not proven until a real deployment occurs.
- README demo assets / third-party screenshots or videos remain a go-to-market asset task, not a release-blocking code gate in `PRODUCTION_READINESS_PLAN.ja.md`.
