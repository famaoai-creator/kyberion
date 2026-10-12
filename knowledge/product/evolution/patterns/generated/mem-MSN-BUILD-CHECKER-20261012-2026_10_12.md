---
record_id: mem-MSN-BUILD-CHECKER-20261012-2026_10_12
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-BUILD-CHECKER-20261012-2026_10_12
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-12T10:34:47.758Z
source_branch: fix/build-artifact-checker-20261012
source_commit: 3ef06996f604e4c58d72a1c12d66f0b06a3d79ed
---

# Keep build-artifact membership and diagnostic provenance precise

Build freshness checks need directory-boundary matching, paired file timestamps, and native-platform coverage.

## Applicability

- mission
- mission:MSN-BUILD-CHECKER-20261012

## Reusable Steps

1. Build freshness checks need directory-boundary matching, paired file timestamps, and native-platform coverage

## Expected Outcome

Apply this procedure when changing build-artifact freshness checks. Determine source-root membership by a normalized relative path and reject parent, absolute, and empty relations; a textual prefix can incorrectly admit sibling paths such as src-other or src.ts. Keep case and slash normalization local to build metadata, never security or tenant paths. Derive each reported source and emitted file together with its own timestamp, using null when that file is absent. Regress older changed sources alongside newer unchanged sources, missing emits, orphan output, and foreign buildinfo entries. Register platform-only tests in the matching native CI job and distinguish skipped local cases from native passes.

## Evidence

- active/missions/public/MSN-BUILD-CHECKER-20261012/evidence/test-report.md
- active/missions/public/MSN-BUILD-CHECKER-20261012/evidence/REVIEW-execution-implement.md

## Artifacts
