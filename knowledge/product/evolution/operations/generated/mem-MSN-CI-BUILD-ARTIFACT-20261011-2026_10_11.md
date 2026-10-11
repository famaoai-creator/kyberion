---
record_id: mem-MSN-CI-BUILD-ARTIFACT-20261011-2026_10_11
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CI-BUILD-ARTIFACT-20261011-2026_10_11
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-11T17:36:18.668Z
source_branch: feat/ci-build-artifact-20261011
source_commit: 9c5b0b7224d9b224fac78c9bdbb73a7d94473098
---

# Share owned build outputs via artifacts — the artifact list should come from the ownership contract, not guesswork

Per-job pnpm run build (~4min x ~12 jobs) was the residual CI tail. One build-artifacts job uploads the owned compiler outputs declared in build-output-layout.ts; consumers download (~30s). first-win keeps its own build; multi-GB .next stays out.

## Procedure Steps

1. (1) After parallelism wins are exhausted, per-job fixed setup dominates — measure step-level durations before sharding more. (2) An ownership contract (build-output-layout.ts) turns artifact contents from a guessed glob into a declared set — keep CI artifact paths aligned with it. (3) Artifact classes differ: compiler outputs (~66MB) belong in artifacts; UI bundles (3GB+) do not — gate by consumer need. (4) Jobs that test the build itself (clean-clone checks) must keep their own build — a shared artifact would void the check.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-CI-BUILD-ARTIFACT-20261011/evidence/design-spec.json
- active/missions/public/MSN-CI-BUILD-ARTIFACT-20261011/evidence/retrospective.md

## Artifacts
