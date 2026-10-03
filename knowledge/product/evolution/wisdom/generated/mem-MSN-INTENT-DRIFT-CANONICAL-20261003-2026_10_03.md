---
record_id: mem-MSN-INTENT-DRIFT-CANONICAL-20261003-2026_10_03
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-INTENT-DRIFT-CANONICAL-20261003-2026_10_03
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-03T04:39:51.372Z
source_branch: fix/intent-drift-canonical
source_commit: e6afa0042c6c95f641b734fe9d2093afa33b64cb
---

# Intent-drift gate compares origin vs canonical intent, not the snapshot log

Snapshot streams are append-only activity logs; comparing an origin snapshot against the latest emitted line manufactures drift blocks. Compare origin vs the mission canonical intent (goal_summary||source_text + outcome-contract fields), and record canonical intent in every snapshot source when it exists — LLM extraction is a fallback only.

## Hint Scope

mission

## Trigger Phrases

- Intent-drift was manufactured by four seams: (1) worker_transition snapshots wrote synthetic goals bypassing the canonical guard; (2) missions without goal_summary recorded checkpoint/commit text as snapshot goals; (3) user_prompt origins stored LLM-extracted paraphrases vs verbatim canonical later; (4) the gate compared origin vs latest activity line. Fixes: missionCanonicalIntent/buildCanonicalIntentBody projections, all-source canonical snapshots, evaluateIntentDriftGate currentIntent param, worker_transition excluded from hasUserIntent. Pre-fix noisy origins still need triage + scope-approve rebaseline.

## Recommended References

- active/missions/public/MSN-INTENT-DRIFT-CANONICAL-20261003/evidence/implementation-report.md
- active/missions/public/MSN-INTENT-DRIFT-CANONICAL-20261003/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-INTENT-DRIFT-CANONICAL-20261003/evidence/retrospective.md

## Evidence

- active/missions/public/MSN-INTENT-DRIFT-CANONICAL-20261003/evidence/implementation-report.md
- active/missions/public/MSN-INTENT-DRIFT-CANONICAL-20261003/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-INTENT-DRIFT-CANONICAL-20261003/evidence/retrospective.md

## Artifacts
