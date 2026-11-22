---
record_id: mem-MSN-CHARTER-DELEGATION-PILOT5-20261122-2026_11_22
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CHARTER-DELEGATION-PILOT5-20261122-2026_11_22
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-22T15:15:07.823Z
source_branch: agent/factory-pilot5-charter
source_commit: e3292e5eb029b6ee6d5071366d3b50873b2f9c60
---

# Charter delegation: 4-layer model and issuance conditions

Charter delegation is a 4-layer model: registry registration → exact grant match → envelope gate → execution reservation.

## Hint Scope

mission

## Trigger Phrases

- Approval-required actions delegate via accountability charter only when: (1) the operation is registered in EXTERNAL_OPERATION_DELEGATION; (2) envelope.external_operations grant exactly matches the built target (repo+branch+visibility for VCS); (3) the gate evaluates envelope/appetite/availability/tripwires and the policy is charter-eligible (never mandatoryApproval, runtime floors, dual_key); (4) the durable execution reservation still applies after allow. external_operations grants require owner/officer authority_basis with evidence_ref; person-scope charter I/O runs only inside withInstalledPersonCharterRuntime binding; real CLI delegation requires an installed onboarding runtime (active member + NHI).

## Recommended References

- active/missions/public/MSN-CHARTER-DELEGATION-PILOT5-20261122/evidence/charter-dryrun-report.json
- active/missions/public/MSN-CHARTER-DELEGATION-PILOT5-20261122/evidence/test-report.md

## Evidence

- active/missions/public/MSN-CHARTER-DELEGATION-PILOT5-20261122/evidence/charter-dryrun-report.json
- active/missions/public/MSN-CHARTER-DELEGATION-PILOT5-20261122/evidence/test-report.md

## Artifacts
