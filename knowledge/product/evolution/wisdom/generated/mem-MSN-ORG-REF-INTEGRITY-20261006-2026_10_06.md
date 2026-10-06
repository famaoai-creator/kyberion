---
record_id: mem-MSN-ORG-REF-INTEGRITY-20261006-2026_10_06
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-ORG-REF-INTEGRITY-20261006-2026_10_06
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-06T13:54:51.611Z
source_branch: main
source_commit: 17529cb2a131466b81a5293c09d011a52fa490a2
---

# Organization refs: reconcile is the validity contract — keep add-time in parity and prefer durable evidence paths

Two seams fixed under MSN-ORG-REF-INTEGRITY-20261006: (1) operation add accepted task_session/pipeline without --execution-ref while reconcile flags ref-less non-actuator targets — now rejected at add time (mission/actuator exempt: onboarding provisions unbound mission ops); (2) reconcile resolves active/missions/... evidence refs through the configured mission archive (directories.archive, flat layout) since finish moves the directory. Prefer durable evidence refs (knowledge/...) when recording runs.

## Hint Scope

mission

## Trigger Phrases

- Details: organizationEvidenceRefExists probes path segments against the archive root so both public/<ID> and confidential/<tenant>/<ID> layouts resolve; segments containing .. . or backslash are rejected before probing. Ref-less mission-kind ops provisioned by onboarding-context.ts still flag invalid_execution_refs — intentional unbound signal, documented in organization CLI help. Bare mission IDs (no slashes) are valid --execution-ref shorthand resolving to mission-state.json.

## Recommended References

- active/missions/public/MSN-ORG-REF-INTEGRITY-20261006/evidence/implementation-report.md
- active/missions/public/MSN-ORG-REF-INTEGRITY-20261006/evidence/test-report.md

## Evidence

- active/missions/public/MSN-ORG-REF-INTEGRITY-20261006/evidence/implementation-report.md
- active/missions/public/MSN-ORG-REF-INTEGRITY-20261006/evidence/test-report.md

## Artifacts
