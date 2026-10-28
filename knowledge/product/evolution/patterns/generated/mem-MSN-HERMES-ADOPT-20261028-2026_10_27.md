---
record_id: mem-MSN-HERMES-ADOPT-20261028-2026_10_27
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-HERMES-ADOPT-20261028-2026_10_27
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-27T19:20:46.335Z
source_branch: feat/hermes-adoption-20261028
source_commit: 6e9c2a827dfb68f673d27db62cec69cb7dcdb32e
---

# Bind shared-runtime recovery to exact identity, content and generation

Credential lookup, plugin publication, compaction restore and operational acknowledgements must remain bound to their current task, bytes and episode rather than ambient state.

## Applicability

- mission
- mission:MSN-HERMES-ADOPT-20261028

## Reusable Steps

1. Credential lookup, plugin publication, compaction restore and operational acknowledgements must remain bound to their current task, bytes and episode rather than ambient state

## Expected Outcome

In a shared runtime, credential binding must come from trusted dispatch and remain pinned to tenant, mission and task at lookup and send time. A scoped miss must not fall back to operator environment, personal cache, vault or keychain; cached clients cannot cross owners. Reject tenant-native transports whose authentication isolation is unverified rather than silently reuse operator state. A validated CLI HOME is a spawn precondition, not an OS sandbox. Publish plugin code and install records with a per-plugin lock, old-content comparison and recovery journal; never transfer an old grant to a new digest, and stop on unknown recovery bytes. Before replacing context, require a scoped immutable snapshot receipt and committed lineage when durability is requested; preserve history on failure and reject expired, mismatched or ambiguous restore tips without replaying effects. Incident acknowledgement belongs to the observed episode, and OAuth observation does not replace callback completion authority. Quality freshness is content-bound and scoped; instruction-write observations are intent, not proof of a committed diff. Scheduled physical deletion, real OAuth and generic native isolation require separate verification.

## Evidence

- active/missions/public/MSN-HERMES-ADOPT-20261028/evidence/implementation-report.md
- active/missions/public/MSN-HERMES-ADOPT-20261028/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-HERMES-ADOPT-20261028/evidence/test-report.md
- active/missions/public/MSN-HERMES-ADOPT-20261028/evidence/replay-probe.json

## Artifacts
