---
record_id: mem-MSN-WINDOWS-PATHS-20261116-2026_11_15
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-WINDOWS-PATHS-20261116-2026_11_15
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-15T19:03:14.896Z
source_branch: codex/windows-llm
source_commit: 380995741fbf60d74c3874de6e946b252158d877
---

# Normalize Windows paths before binding repository resource scopes

Portable repository paths and physical OS paths serve different purposes; normalize at the conversion boundary rather than weakening a capability issuer.

## Hint Scope

mission

## Trigger Phrases

- Windows path.relative returns backslashes. toRepoRelative and normalizeStoredPath must emit slash-separated references for paths within the checkout while preserving foreign and relative path semantics. Keep physical filesystem assertions OS-aware and canonical resource assertions portable. Do not accept backslashes in grant issuers to compensate for unnormalized caller paths. The diagnosed defect caused five production autonomy receipt tests to fail; all five passed after canonical conversion was repaired. Independent review verified drive and UNC containment and unchanged POSIX behavior.

## Recommended References

- active/missions/public/MSN-WINDOWS-PATHS-20261116/evidence/test-report.md
- active/missions/public/MSN-WINDOWS-PATHS-20261116/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-WINDOWS-PATHS-20261116/evidence/test-report.md
- active/missions/public/MSN-WINDOWS-PATHS-20261116/evidence/REVIEW-execution-implement.md

## Artifacts
