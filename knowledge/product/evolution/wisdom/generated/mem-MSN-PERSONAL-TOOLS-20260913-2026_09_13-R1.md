---
record_id: mem-MSN-PERSONAL-TOOLS-20260913-2026_09_13-R1
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-PERSONAL-TOOLS-20260913-2026_09_13-R1
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T13:31:05.792Z
source_branch: fix/voice-media-session-id-20261005
source_commit: 3914948b3e61c1a44cc2ec7e79234920b20756a7
---

# Personal workbench: personal-tier defaults, authenticated capture, proposal-only handoff

Design rules for personal-tier assistant workflows that touch external effects.

## Hint Scope

mission

## Trigger Phrases

- When building personal secretary/assistant workflows: (1) Default all data to the personal tier and require authentication at both load and capture boundaries — never read or write personal data anonymously. (2) Keep capture proposal-only: a proposal handoff cleanly separates preparing an action from executing it, so consequential external effects (sending mail, enqueuing knowledge, mutating calendar) stay behind explicit /action boundaries rather than running implicitly. (3) Multiple workflows can share one workbench when they reuse the same tier defaults, auth controls, proposal handoff, and registry-based discovery. (4) Pair focused workflow tests with repository-wide gates (typecheck/lint plus broader suites before merge) to catch both local defects and integration regressions.

## Recommended References

- active/missions/public/MSN-PERSONAL-TOOLS-20260913/evidence/ledger.jsonl
- active/missions/public/MSN-PERSONAL-TOOLS-20260913/evidence/intent-snapshots.jsonl

## Evidence

- active/missions/public/MSN-PERSONAL-TOOLS-20260913/evidence/ledger.jsonl
- active/missions/public/MSN-PERSONAL-TOOLS-20260913/evidence/intent-snapshots.jsonl

## Artifacts
