---
record_id: mem-MSN-EVIDENCE-FRESHNESS-20261006-2026_10_06
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-EVIDENCE-FRESHNESS-20261006-2026_10_06
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-06T14:25:58.586Z
source_branch: main
source_commit: 17529cb2a131466b81a5293c09d011a52fa490a2
---

# Retrofit detection needs two observations: frozen stamp at record time AND re-observed file state at collect

MSN-EVIDENCE-FRESHNESS-20261006 added evidence_timing to mission retrospectives: record-evidence stamps deliverable_path/deliverable_mtime into the ledger, and collect time re-stats the file — a frozen stamp alone is dead logic (mtime can never exceed the ts written in the same append). Burst detection uses densest-window-share (>=80% of >=3 evidence events inside any 10-min window on a >=1h mission); verified on real data: retrofitted mission flags, honest fast missions do not.

## Applicability

- mission
- mission:MSN-EVIDENCE-FRESHNESS-20261006

## Reusable Steps

1. MSN-EVIDENCE-FRESHNESS-20261006 added evidence_timing to mission retrospectives: record-evidence stamps deliverable_path/deliverable_mtime into the ledger, and collect time re-stats the file — a frozen stamp alone is dead logic (mtime can never exceed the ts written in the same append)
2. Burst detection uses densest-window-share (>=80% of >=3 evidence events inside any 10-min window on a >=1h mission); verified on real data: retrofitted mission flags, honest fast missions do not

## Expected Outcome

Pattern: when auditing whether an artifact was edited after an event, compare the LIVE file state to the frozen event timestamp — comparing two frozen stamps fails silently. The mission evidence-freshness signal lives in MissionExecutionStats.evidence_timing (events/span/mission_active_ms/densest_window_share/closing_burst/edited_after_record) and renders a warning section in retrospective.md. Known FP: legitimately batched task closes can trip closing_burst — it is a hedged warning, never a gate.

## Evidence

- active/missions/public/MSN-EVIDENCE-FRESHNESS-20261006/evidence/implementation-report.md

## Artifacts
