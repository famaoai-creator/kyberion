---
record_id: mem-MSN-APPROVAL-ROLE-TYPE-20261028-2026_10_27
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-APPROVAL-ROLE-TYPE-20261028-2026_10_27
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-27T19:21:17.489Z
source_branch: feat/hermes-adoption-20261028
source_commit: 6e9c2a827dfb68f673d27db62cec69cb7dcdb32e
---

# Repair domain writer types without impersonating roles or widening global grants

When runtime policy already authorizes a specialized approval writer, expose that identity through an approval-only type seam rather than unsafe casts or global artifact-role expansion.

## Applicability

- mission
- mission:MSN-APPROVAL-ROLE-TYPE-20261028

## Reusable Steps

1. When runtime policy already authorizes a specialized approval writer, expose that identity through an approval-only type seam rather than unsafe casts or global artifact-role expansion

## Expected Outcome

When standalone frontend typechecking exposes an authorized approval writer missing from a generic artifact-role union, first verify the existing policy and actual caller identity. Introduce a type-only approval-domain role alias and propagate it through the approval storage, locking and human/passkey helpers needed by the real call path. Keep the caller's identity unchanged; do not impersonate a broader role, suppress the error or expand generic artifact writers and data-driven surface role mappings. The alias changes compile-time admissibility, not permission grants. Preserve active-tenant binding, caller channel-write checks, presented-content binding, agent refusal and human/passkey assurance at runtime. Verify an actual decision and event under the intended identity, refusal of insufficient human proof and unauthorized channel writers, and exclusion from generic artifact roles. Run standalone frontend typechecking as well as core builds: a production web build configured to skip typechecking is not proof of a clean frontend type contract.

## Evidence

- active/missions/public/MSN-APPROVAL-ROLE-TYPE-20261028/evidence/implementation-report.md
- active/missions/public/MSN-APPROVAL-ROLE-TYPE-20261028/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-APPROVAL-ROLE-TYPE-20261028/evidence/test-report.md

## Artifacts
