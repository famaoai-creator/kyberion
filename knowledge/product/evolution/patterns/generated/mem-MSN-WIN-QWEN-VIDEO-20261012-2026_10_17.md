---
record_id: mem-MSN-WIN-QWEN-VIDEO-20261012-2026_10_17
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-WIN-QWEN-VIDEO-20261012-2026_10_17
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-17T10:31:45.960Z
source_branch: feat/windows-multimodal-chronos-20261017
source_commit: 6cc36a075fe37b7d5ea7309aad6f67c4dc000385
---

# Probe Windows desktop capabilities per source

Windows desktop readiness can be partial across UI Automation, visible Chrome tabs, and screen capture, so probe and report each source separately.

## Applicability

- mission
- mission:MSN-WIN-QWEN-VIDEO-20261012

## Reusable Steps

1. Windows desktop readiness can be partial across UI Automation, visible Chrome tabs, and screen capture, so probe and report each source separately

## Expected Outcome

Treat Windows desktop observation as independent capabilities rather than a single available/unavailable bridge. Probe UI Automation, visible Chrome tab enumeration, and the screen capture backend separately, and report an actionable reason for each unavailable source. Keep an empty focused control distinct from UI Automation being unavailable. For screen redaction, use local OCR that returns pixel coordinates; text-only vision output cannot define a safe masking region. When using a local vision model, require explicit model selection and restrict the endpoint to loopback.

## Evidence

- active/missions/public/MSN-WIN-QWEN-VIDEO-20261012/evidence/implementation-report.md
- active/missions/public/MSN-WIN-QWEN-VIDEO-20261012/evidence/test-report.md
- active/missions/public/MSN-WIN-QWEN-VIDEO-20261012/evidence/REVIEW-execution-implement.md

## Artifacts
