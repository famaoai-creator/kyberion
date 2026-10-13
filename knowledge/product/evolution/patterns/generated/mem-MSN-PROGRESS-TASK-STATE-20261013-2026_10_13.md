---
record_id: mem-MSN-PROGRESS-TASK-STATE-20261013-2026_10_13
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-PROGRESS-TASK-STATE-20261013-2026_10_13
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-13T17:06:51.128Z
source_branch: fix/progress-task-state-clarity-20261013
source_commit: a519bd77adcf0c99b557aec722320f9764df449a
---

# Show recorded task state without inventing activity or action

Keep task phase, current detail, artifact verdict and historical updates distinct, and validate the same contract with an explicitly normal test environment.

## Applicability

- mission
- mission:MSN-PROGRESS-TASK-STATE-20261013

## Reusable Steps

1. Keep task phase, current detail, artifact verdict and historical updates distinct, and validate the same contract with an explicitly normal test environment

## Expected Outcome

A Progress surface must not turn every unfinished task into running work. Normalize only recorded phase and explicit input-wait signals; keep requirements collection distinct, let terminal states override stale wait flags, and use an unknown fallback for unrecognized values. Current detail must determine its own state rather than borrowing an older list row. Preserve explicit task-versus-artifact provenance so a linked task cannot overwrite artifact verdict semantics.

Label historical messages as recorded updates. Completion means completion was recorded; it does not establish an independent verification result. Guidance should name only state-backed manual next steps, without implying automatic continuation, approval authority or live execution. Exercise long localized badges in the actual source UI: placing task badges below titles preserved readable titles while keeping keyboard selection and artifact layout.

Validation must preserve its own provenance too. Separate offline wisdom lifecycle wrappers from ordinary CI test/check wrappers, and assert the actual child environment before a broad run. In this mission, inherited stub flags invalidated normal-CI equivalence and caused ten provider-selection/egress failures; removing those flags produced 261 passing targeted tests. The broad diagnostic still had local IPC/home failures, so it was not reported as all green. Keep failed resource attempts and later full-command recoveries separately; isolated gate success is not a full-suite pass. Actual browser proof used synthetic GET-only fixtures, not live provider, microphone or configured OIDC flows.

## Evidence

- active/missions/public/MSN-PROGRESS-TASK-STATE-20261013/evidence/design-spec.json
- active/missions/public/MSN-PROGRESS-TASK-STATE-20261013/evidence/ux-contract.json
- active/missions/public/MSN-PROGRESS-TASK-STATE-20261013/evidence/implementation-report.md
- active/missions/public/MSN-PROGRESS-TASK-STATE-20261013/evidence/test-report.md
- active/missions/public/MSN-PROGRESS-TASK-STATE-20261013/evidence/browser-verification.md
- active/missions/public/MSN-PROGRESS-TASK-STATE-20261013/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-PROGRESS-TASK-STATE-20261013/evidence/REVIEW-contract_authoring-ux-contract.md

## Artifacts
