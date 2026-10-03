---
record_id: mem-MSN-MISSION-LOOKUP-P2-20261003-2026_10_03
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-MISSION-LOOKUP-P2-20261003-2026_10_03
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-03T06:45:08.714Z
source_branch: claude/mission-lookup-phase2
source_commit: b25632893abaefb0e18b39314e98e0fe21b4ad78
---

# A strict-by-default lookup needs a registry: absent is only safe where it is a conservative no-op

Moving read paths onto a non-throwing mission lookup looked like the obvious second phase, but classifying the 54 callers showed it would make scope-deriving code fail open. The durable fix was an explicit contract: strict stays the default, each direct caller is pinned to a reason by a boundary test, and only conservative no-op sites use a lenient helper.

## Applicability

- mission
- mission:MSN-MISSION-LOOKUP-P2-20261003

## Reusable Steps

1. Moving read paths onto a non-throwing mission lookup looked like the obvious second phase, but classifying the 54 callers showed it would make scope-deriving code fail open
2. The durable fix was an explicit contract: strict stays the default, each direct caller is pinned to a reason by a boundary test, and only conservative no-op sites use a lenient helper

## Expected Outcome

- Before loosening a throwing lookup for 'read paths', ask what 'absent' becomes at each caller: a looser default (tier, tenant, visibility, classification derived from the record) is fail-open; another location or create-on-miss yields a second copy. Both want the throw.
- Lenient is right only where absent is a conservative no-op: an optional write (log a warning), a report row, 'no identity' for a permission check, and list/feed filters whose downstream check already denies the tenant-less item (so one bad record cannot abort the whole list).
- Pin the classification, not just the helper: a boundary test that scans non-test sources for direct calls and compares them to a registry with a category per file turns every new caller into a conscious choice and fails on stale entries.
- Make the lenient helper mock-safe by passing the finder in (missionPathOrNull(findMissionPath, id)) instead of importing a sibling function, so vi.mock'ed finders in 18 test files keep working; detect refusals by an error .code so the helper has no imports.
- Surfaces that map errors through a wire sanitizer (fixed message per class) need no extra handling for strict refusals; verify that before adding lenient wrappers.
- A new @agent/core subpath export needs a rebuilt dist before contract tests that load every export (core-runtime-import-contract, workspace-build-contract) pass.

## Evidence

- active/missions/public/MSN-MISSION-LOOKUP-P2-20261003/evidence/implementation-report.md
- active/missions/public/MSN-MISSION-LOOKUP-P2-20261003/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-MISSION-LOOKUP-P2-20261003/evidence/test-report.md

## Artifacts
