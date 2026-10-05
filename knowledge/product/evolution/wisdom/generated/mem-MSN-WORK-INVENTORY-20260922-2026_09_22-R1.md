---
record_id: mem-MSN-WORK-INVENTORY-20260922-2026_09_22-R1
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-WORK-INVENTORY-20260922-2026_09_22-R1
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T13:31:31.549Z
source_branch: fix/voice-media-session-id-20261005
source_commit: 3914948b3e61c1a44cc2ec7e79234920b20756a7
---

# Consent-first design and isolation-rerun triage for recording features

Privacy scope belongs in requirements; review findings become regression tests; full-suite timeouts are rerun in isolation.

## Hint Scope

mission

## Trigger Phrases

- For inventory features that include consented PC/device recording: (1) declare consent model, captured-data scope and privacy constraints in requirements-draft and design-spec before implementation — retrofitting them later forces schema churn; (2) convert each independent-review finding into a named regression test so the correction is durable (this mission resolved 9 findings with regression coverage before merge); (3) split a broad change set into implementation waves with a checkpoint per wave — 12 items stayed traceable under one governed delivery; (4) a full-suite Vitest timeout under load is an infrastructure symptom, not a product defect — rerun the timed-out tests in isolation, and document both the suite-level failure and the isolated pass instead of treating either as the truth alone.

## Recommended References

- active/missions/public/MSN-WORK-INVENTORY-20260922/evidence/retrospective.md
- active/missions/public/MSN-WORK-INVENTORY-20260922/evidence/delivery-report.md
- active/missions/public/MSN-WORK-INVENTORY-20260922/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-WORK-INVENTORY-20260922/evidence/retrospective.md
- active/missions/public/MSN-WORK-INVENTORY-20260922/evidence/delivery-report.md
- active/missions/public/MSN-WORK-INVENTORY-20260922/evidence/REVIEW-execution-implement.md

## Artifacts
