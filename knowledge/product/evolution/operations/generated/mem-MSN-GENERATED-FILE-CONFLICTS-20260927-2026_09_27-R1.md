---
record_id: mem-MSN-GENERATED-FILE-CONFLICTS-20260927-2026_09_27-R1
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-GENERATED-FILE-CONFLICTS-20260927-2026_09_27-R1
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T13:32:50.576Z
source_branch: fix/voice-media-session-id-20261005
source_commit: 3914948b3e61c1a44cc2ec7e79234920b20756a7
---

# Generated-file merge conflicts: untrack, fragment, or regenerate — in that order

Three-strategy ladder for eliminating recurring conflicts on generated artifacts.

## Procedure Steps

1. For generated files that conflict on nearly every merge: (1) Prefer untracking purely-derived artifacts — the knowledge integrity manifest is rebuilt by `pnpm build`, so tracking it only creates conflicts; verify no consumer reads it from the checkout. (2) Fragment shared append hot spots — CHANGELOG.md becomes changelog.d/<slug>.md per-change fragments plus an assemble step and a changelog-fragments gate, so parallel changes stop colliding. (3) For generated files that must stay tracked, provide regenerate-on-merge: `pnpm kyberion resolve generated` rebuilds unmerged paths from their index conflict stages (base/ours/theirs) in dependency order — it repairs leftover conflict markers too, and works without a merge driver. (4) An optional owner-installed merge driver automates step 3 locally, but GitHub's web merge ignores drivers — the resolve command must remain the fallback. Never hand-edit generated files to resolve conflicts; regeneration is authoritative.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-GENERATED-FILE-CONFLICTS-20260927/evidence/design-spec.json
- active/missions/public/MSN-GENERATED-FILE-CONFLICTS-20260927/evidence/implementation-report.md
- active/missions/public/MSN-GENERATED-FILE-CONFLICTS-20260927/evidence/distillation.md

## Artifacts
