---
record_id: mem-MSN-PUBLIC-ATTESTATION-SCOPE-20261019-2026_10_19
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-PUBLIC-ATTESTATION-SCOPE-20261019-2026_10_19
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-19T14:23:44.467Z
source_branch: fix/tenant-attestation-scope-20261019
source_commit: 93a0004b80a0176b3049b90b3d1035264125821f
---

# Preserve approval scope and workflow bindings across surfaces

Tenant approvals require consistent canonical scope, effect, digest and workflow roles; failure diagnostics must be bounded and safe.

## Applicability

- mission
- mission:MSN-PUBLIC-ATTESTATION-SCOPE-20261019

## Reusable Steps

1. Tenant approvals require consistent canonical scope, effect, digest and workflow roles; failure diagnostics must be bounded and safe

## Expected Outcome

## Applicability
Use when tenant approvals disappear, do not complete their workflow, or fail without useful feedback.

## Procedure
Create tenant-wide provider attestations with exact confidential tenant scope. Deduplicate only when complete scope, payload and workflow agree. Preserve legacy records; issue a new compatible request rather than rewriting them. Reject scope, payload and effect mismatches before claiming application.

Resolve decision membership against the canonical resource tenant. Preserve the actual member role and align only the specific workflow with owner/approver roles. Keep authenticated-human proof, presented digest, expiry, separation of duties and one-use protections. Check workflow completion as well as top-level status.

Expose only allowlisted error codes and validated HTTP status with localized guidance. Never echo raw bodies, exception text, paths, tokens, stacks or correlation fields. Bound diagnostic reads to 4096 bytes and 1000 ms, clean up timers/readers, and never await a stalled cancellation. Preserve authorization, request payloads and dispatch counts. Uncertain transport outcomes require checking status, never automatic resubmission.

## Verification
Test same-hash incompatible scopes, legacy immutability, tenant isolation, stale digest, changed effect, owner/approver real-store application, agent/viewer denial and replay. Test malformed, HTML, oversized, never-ending responses and nonsettling cancellation. Synthetic tests and production builds do not establish successful live human approval or provider execution.

## Evidence

- active/missions/public/MSN-PUBLIC-ATTESTATION-SCOPE-20261019/evidence/implementation-report.md
- active/missions/public/MSN-PUBLIC-ATTESTATION-SCOPE-20261019/evidence/test-report.md
- active/missions/public/MSN-PUBLIC-ATTESTATION-SCOPE-20261019/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-PUBLIC-ATTESTATION-SCOPE-20261019/evidence/ux-diagnostics-implementation-report.md
- active/missions/public/MSN-PUBLIC-ATTESTATION-SCOPE-20261019/evidence/ux-diagnostics-test-report.md
- active/missions/public/MSN-PUBLIC-ATTESTATION-SCOPE-20261019/evidence/REVIEW-ux-diagnostics.md

## Artifacts
