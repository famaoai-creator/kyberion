---
record_id: mem-MSN-ARTIFACT-FEEDBACK-20261005-2026_10_05
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-ARTIFACT-FEEDBACK-20261005-2026_10_05
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-05T10:42:08.364Z
source_branch: feat/artifact-feedback-regeneration-20261005
source_commit: 453d01a20729df148baf17ff97cf11868ac1664a
---

# Artifact revisions need fresh authority and immutable byte lineage

Treat a diagnostic artifact revision as a new digest-bound request: verify its parent, obtain fresh scoped approval, publish without replacement under the same write-policy checks, and recover reports without replaying effects.

## Applicability

- mission
- mission:MSN-ARTIFACT-FEEDBACK-20261005

## Reusable Steps

1. Treat a diagnostic artifact revision as a new digest-bound request: verify its parent, obtain fresh scoped approval, publish without replacement under the same write-policy checks, and recover reports without replaying effects

## Expected Outcome

# Artifact revisions need fresh authority and immutable byte lineage

Use this pattern when extending a bounded artifact-producing capability with user-requested revisions.

1. Resolve the parent from the authenticated server-owned conversation and verify its exact version and content digest. Client paths, old approval displays and prose references are not authority.
2. Atomically reserve a distinct child request and its future WorkItem identity; create the WorkItem only after fresh scoped approval. Bind parent identity, revision, digest and the allowed change into the new request digest, require fresh scoped human approval, and reject stale or competing child reservations.
3. Recheck current scope, capability, approval and parent bytes both before effects and before publication. Propagate the executor's configured state root into verification; a fresh-process test catches default-root reads hidden by in-process mocks.
4. Publish to a distinct version path through an atomic no-replace operation. An existence check followed by an overwriting rename is insufficient. Keep the canonical sensitive-path, tier and policy-engine gates when introducing exclusive publication, and test a competing creator at the final publication boundary.
5. Fence durable schema upgrades so old writers cannot discard lineage. History carries inert target-selection metadata, never restored approval. Completed terminal versions must remain parseable even when capacity prevents another revision.
6. Keep unknown outcomes quarantined. Duplicate requests, restarts and missing delivery receipts may reconcile existing state or reports; they must not regenerate work automatically.

Browser-safe selection parsers belong in a dependency-free contract module shared by the UI and server contract, rather than making a contract import a history/domain module.

For the initial diagnostic slice, keep inputs public-only and changes restricted to explicit compact/readable JSON formats. Additional content-editing capabilities require their own scope and approval contract. Do not confuse metadata-only artifact copies with physical snapshots, and do not claim general regeneration from a formatting-only implementation.

## Evidence

- active/missions/public/MSN-ARTIFACT-FEEDBACK-20261005/evidence/design-spec.json
- active/missions/public/MSN-ARTIFACT-FEEDBACK-20261005/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-ARTIFACT-FEEDBACK-20261005/evidence/test-report.md

## Artifacts
