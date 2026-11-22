---
record_id: mem-MSN-DELEGATE-UX-PILOT6-20261122-2026_11_22
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-DELEGATE-UX-PILOT6-20261122-2026_11_22
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-22T18:43:36.686Z
source_branch: agent/factory-pilot6-delegate-ux
source_commit: c44c270b7d1160d08abc3b72df6aadf842e5de38
---

# Charter delegation composition paths all converge on one human ceremony

Approval-to-charter delegation gains two simpler composition surfaces — `approvals --delegate <id>` and `onboarding authority preview --grant/--grant-field` — and both funnel into the unchanged preview → human approval → apply flow.

## Hint Scope

mission

## Trigger Phrases

- When a standing grant can be derived from a one-time human decision, store a server-derived delegation target on the request (never model payload) and re-validate it through the canonical registry parser before composing any plan; every composition surface — hand-written plan file, CLI flags, or request-derived --delegate — must end at the same reviewed envelope, human approval and apply ceremony, with explicit expiry. When a helper returns a result object like {ok}, pin the call-site contract with a test: a truthy {ok:false} silently swallowed the refusal path until review caught it.

## Recommended References

- active/missions/public/MSN-DELEGATE-UX-PILOT6-20261122/evidence/retrospective.md
- active/missions/public/MSN-DELEGATE-UX-PILOT6-20261122/evidence/implementation-report.md
- active/missions/public/MSN-DELEGATE-UX-PILOT6-20261122/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-DELEGATE-UX-PILOT6-20261122/evidence/ux-contract.json

## Evidence

- active/missions/public/MSN-DELEGATE-UX-PILOT6-20261122/evidence/retrospective.md
- active/missions/public/MSN-DELEGATE-UX-PILOT6-20261122/evidence/implementation-report.md
- active/missions/public/MSN-DELEGATE-UX-PILOT6-20261122/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-DELEGATE-UX-PILOT6-20261122/evidence/ux-contract.json

## Artifacts
