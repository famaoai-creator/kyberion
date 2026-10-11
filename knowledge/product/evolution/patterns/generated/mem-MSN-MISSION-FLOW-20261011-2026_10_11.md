---
record_id: mem-MSN-MISSION-FLOW-20261011-2026_10_11
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-MISSION-FLOW-20261011-2026_10_11
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-11T15:50:28.826Z
source_branch: feat/mission-flow-projection-20261011
source_commit: 3149517ea106b5278b7b1c45ebe425d7f2a0f9c9
---

# Read-only mission advice needs scoped evidence and clean-build proof

Mission status should explain observed work and uncertainty through one advisory projection, using canonical read-only readers and executable cross-consumer checks rather than lifecycle labels alone.

## Applicability

- mission
- mission:MSN-MISSION-FLOW-20261011

## Reusable Steps

1. Mission status should explain observed work and uncertainty through one advisory projection, using canonical read-only readers and executable cross-consumer checks rather than lifecycle labels alone

## Expected Outcome

Use a versioned, non-authorizing projection over the canonical normalized task board, same-scope mission prerequisites, exact-scoped approval observations, recorded gate results and structural completion evidence. Missing, unreadable or stale observations must not become readiness. Candidate actions grant no authority and require execution-time revalidation by the existing governed facade. Lifecycle completion does not establish merge or deployment.

Dependency admissibility must match the dispatcher, including its exact completed status. Validate duplicate IDs, self-dependencies, missing targets and cycles. Keep legacy unscoped approvals unassociated, and do not turn a successfully consumed approval into a new expired-approval blocker. Parse gate timestamps; absent or invalid chronology remains unknown, and historic passes or overrides do not authorize current execution.

Keep read-only readers and validators in dependency leaves, with compatibility re-exports for existing callers. Importing a mixed approval mutation store into a status projection can create a runtime cycle through steering and lifecycle status. Compare extracted function bodies, run the exact module-boundary regression and require zero direction violations; do not relax the architecture baseline.

A status query must not discover or start providers by default. Cached observations should say that current readiness was not probed. Evaluate the real read model, freshly built CLI and existing consumer on isolated fixture stores, compare their reason/evidence output, and hash every fixture file before and after repeated reads. Exercise safe synthetic transitions separately. Clearly distinguish in-memory approval tests, persisted-store tests and unavailable browser checks; do not invent time-saving figures.

Bootstrap diagnostics also need executable fixtures for the actual TypeScript rootDir layout. A root program can retain the src directory in emitted paths. Keep broad output-directory existence checks while applying the source prefix to file mapping, and test both a missing single emit and a missing entire source-output subtree so real stale output cannot be silently skipped.

Planned public scope is the technical projection, canonical reader extraction, regression tests, local emit-mapping recovery, operating guidance and this lesson. Credentials, private user or tenant data, approval decisions, persistent security changes, external execution, merge and deployment are excluded. The local browser limitation is recorded as an open validation gap; it is not converted into a passing result.

## Evidence

- active/missions/public/MSN-MISSION-FLOW-20261011/evidence/validation-checkpoint.md
- active/missions/public/MSN-MISSION-FLOW-20261011/evidence/independent-review.md
- active/missions/public/MSN-MISSION-FLOW-20261011/evidence/implementation-report.md

## Artifacts
