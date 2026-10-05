---
record_id: mem-MSN-ELIZA-ADOPTION-20260924-2026_09_26-R1
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-ELIZA-ADOPTION-20260924-2026_09_26-R1
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T13:30:33.622Z
source_branch: fix/voice-media-session-id-20261005
source_commit: 3914948b3e61c1a44cc2ec7e79234920b20756a7
---

# Plugin grant frames must wrap what functions return, and rollback must not widen grants

Security-review gotchas for capability wrapping and plugin lifecycle.

## Hint Scope

mission

## Trigger Phrases

- Independent review caught three blocking grant-escape patterns worth checking on any capability/grant wrapper: (1) wrapFunction/wrapObject that only guard the call let async generators and returned closures escape the grant frame — wrap returned iterables, promises, and function values too; (2) secret/credential getters (getActiveSecrets) reachable without a grant must be grant-gated; (3) reload-rollback that restores the superseded grant can silently widen permissions — rollback must restore the current (narrower) grant. Process lessons: split a cross-domain change (voice + scenario runner + plugins) into planned waves so implementation, tests, and review share one acceptance-item list; tests that fail only under full-suite load but pass alone are a signal to root-cause, not a pass; and record both local validation and remote CI before calling a reviewed PR verified.

## Recommended References

- active/missions/public/MSN-ELIZA-ADOPTION-20260924/evidence/distillation.md
- active/missions/public/MSN-ELIZA-ADOPTION-20260924/evidence/review-round1-findings.md
- active/missions/public/MSN-ELIZA-ADOPTION-20260924/evidence/retrospective.md

## Evidence

- active/missions/public/MSN-ELIZA-ADOPTION-20260924/evidence/distillation.md
- active/missions/public/MSN-ELIZA-ADOPTION-20260924/evidence/review-round1-findings.md
- active/missions/public/MSN-ELIZA-ADOPTION-20260924/evidence/retrospective.md

## Artifacts
