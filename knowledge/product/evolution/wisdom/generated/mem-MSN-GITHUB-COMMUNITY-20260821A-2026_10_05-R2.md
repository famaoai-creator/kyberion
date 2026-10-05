---
record_id: mem-MSN-GITHUB-COMMUNITY-20260821A-2026_10_05-R2
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-GITHUB-COMMUNITY-20260821A-2026_10_05-R2
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T13:33:07.191Z
source_branch: fix/voice-media-session-id-20261005
source_commit: 3914948b3e61c1a44cc2ec7e79234920b20756a7
---

# Governed delivery of public docs: reconcile task state, never count a failed worker as verification

Finish-gate and worker-failure gotchas from public community-docs delivery.

## Hint Scope

mission

## Trigger Phrases

- Three transferable rules: (1) Evidence records and approved artifact-review receipts do not flip NEXT_TASKS.json — the finish gate evaluates canonical task status, so work completed outside dispatch must be adopted via mission_controller reconcile-work before finishing. (2) A reasoning worker that hits a session/quota limit must be excluded from the success set; the owner may substitute deterministic verification (link/format/tier-safety/evidence checks) provided the commands and results are recorded as evidence. (3) For public community documentation, verify the package as a whole (relative links, formatting, public-tier safety, repo settings, evidence integrity, independent review) and keep GitHub settings verification read-only — leave the published PR open for human merge when delivery needs human approval. Also: generated lifecycle snapshots are weak intent evidence — preserve explicit user intent as the drift-review baseline.

## Recommended References

- active/missions/public/MSN-GITHUB-COMMUNITY-20260821A/evidence/retrospective.md
- active/missions/public/MSN-GITHUB-COMMUNITY-20260821A/evidence/ledger.jsonl

## Evidence

- active/missions/public/MSN-GITHUB-COMMUNITY-20260821A/evidence/retrospective.md
- active/missions/public/MSN-GITHUB-COMMUNITY-20260821A/evidence/ledger.jsonl

## Artifacts
