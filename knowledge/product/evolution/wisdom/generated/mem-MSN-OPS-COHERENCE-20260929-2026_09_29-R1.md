---
record_id: mem-MSN-OPS-COHERENCE-20260929-2026_09_29-R1
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-OPS-COHERENCE-20260929-2026_09_29-R1
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T13:30:46.996Z
source_branch: fix/voice-media-session-id-20261005
source_commit: 3914948b3e61c1a44cc2ec7e79234920b20756a7
---

# Re-verify remote CI on the final head and refresh evidence after CI-driven fixes

Local readiness gates miss real regressions; evidence must be reconciled to the actual PR head.

## Hint Scope

mission

## Trigger Phrases

- Two reusable rules from MSN-OPS-COHERENCE-20260929. (1) When a change touches several connected operational flows (here: shared-policy authorization, owner source, setup prerequisites, canonical WorkItem projection), write down which file/policy is the authority for each dimension in the design spec before editing — otherwise fixes in one flow silently contradict another. (2) Remote CI found test/fixture regressions that `pnpm check -- --scope pr` plus local vitest did not. After pushing CI-driven fixes, re-run the readiness gates, then confirm every required check on the final head SHA (record the run ids in the delivery report) and refresh review and test evidence so it describes the merged head, not an earlier commit. A non-required workflow failing (the hosted AI-findings run returned HTTP 400 'requested model is not supported') is not a blocker — verify required-check status only, but note the failure in the delivery report.

## Recommended References

- active/missions/public/MSN-OPS-COHERENCE-20260929/evidence/distillation.md
- active/missions/public/MSN-OPS-COHERENCE-20260929/evidence/delivery-report.md
- active/missions/public/MSN-OPS-COHERENCE-20260929/evidence/retrospective.md

## Evidence

- active/missions/public/MSN-OPS-COHERENCE-20260929/evidence/distillation.md
- active/missions/public/MSN-OPS-COHERENCE-20260929/evidence/delivery-report.md
- active/missions/public/MSN-OPS-COHERENCE-20260929/evidence/retrospective.md

## Artifacts
