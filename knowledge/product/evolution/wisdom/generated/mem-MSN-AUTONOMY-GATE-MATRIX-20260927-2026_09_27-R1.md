---
record_id: mem-MSN-AUTONOMY-GATE-MATRIX-20260927-2026_09_27-R1
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-AUTONOMY-GATE-MATRIX-20260927-2026_09_27-R1
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T13:30:19.390Z
source_branch: fix/voice-media-session-id-20261005
source_commit: 3914948b3e61c1a44cc2ec7e79234920b20756a7
---

# Onboard new autonomy actions as shadow, then lock the matrix with contract tests

Policy-matrix changes ship versioned: schema fields + shadow:true actions + contract tests over the matrix itself.

## Hint Scope

mission

## Trigger Phrases

- When adding an autonomous action, do not wire it live directly. In knowledge/product/governance/autonomous-ops-policy.json add the action entry with shadow: true and declare action_class, veto_window_minutes, max_attempts, and required_evidence; bump the policy version (1.1.0 added 13 matrix-v2 actions, all shadow). Declare any new field in autonomous-ops-policy.schema.json first so validation catches drift. Gate-side rules belong in the engine (libs/core/autonomous-ops-gate.ts): record every decision in `escalations`, keep tenant merge floor-only, and make matchHighRiskPaths support `**` globs plus repo-escape detection. Then prove the matrix with contract tests over the file itself — e.g. a high-risk-coverage contract test asserting every required glob (tier-guard.ts, _secret_, _tenant_, _viewer_) is present — alongside gate unit tests; update script mocks when new logger/gate surfaces appear. The pattern: capture the matrix in a design contract first, ship it shadow, promote to live only after evidence.

## Recommended References

- active/missions/public/MSN-AUTONOMY-GATE-MATRIX-20260927/evidence/distillation.md
- active/missions/public/MSN-AUTONOMY-GATE-MATRIX-20260927/evidence/implementation-report.md
- active/missions/public/MSN-AUTONOMY-GATE-MATRIX-20260927/evidence/design-spec.json

## Evidence

- active/missions/public/MSN-AUTONOMY-GATE-MATRIX-20260927/evidence/distillation.md
- active/missions/public/MSN-AUTONOMY-GATE-MATRIX-20260927/evidence/implementation-report.md
- active/missions/public/MSN-AUTONOMY-GATE-MATRIX-20260927/evidence/design-spec.json

## Artifacts
