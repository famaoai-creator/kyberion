---
record_id: mem-MSN-CLI-USABILITY-20261031-2026_10_31
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CLI-USABILITY-20261031-2026_10_31
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-31T09:25:36.275Z
source_branch: feat/cli-reliability-20261031
source_commit: 4e5d8d880e309636eaf0840d8a44873c02430712
---

# Probe-driven CLI usability reviews: log raw runs, synthesize per question, review before reporting

A broad CLI usability investigation stays auditable when raw probe output is logged verbatim, findings are organized per research question with confidence and counter-evidence, and an independent review gates the reader-facing report.

## Procedure Steps

1. During MSN-CLI-USABILITY-20261031, 26 probe executions were captured in an append-only probe log, condensed into a per-question synthesis (conclusion, confidence, counter-evidence), and passed independent review before the final usability report shipped. Lesson: for wide product investigations run the chain probe-log -> per-question synthesis -> independent review -> reader report, keep the whole chain as one evidence trail, and never write the report from memory of the runs.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-CLI-USABILITY-20261031/evidence/distillation.md
- active/missions/public/MSN-CLI-USABILITY-20261031/evidence/probe-log.txt
- active/missions/public/MSN-CLI-USABILITY-20261031/evidence/research-synthesis.md
- active/missions/public/MSN-CLI-USABILITY-20261031/evidence/research-report-final.md

## Artifacts
