---
record_id: mem-MSN-SCOPE-STACK-REVIEW-20261108-2026_11_07
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-SCOPE-STACK-REVIEW-20261108-2026_11_07
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-07T21:32:49.587Z
source_branch: fix/scope-p3-review-20261108
source_commit: 5345582403e6d7afabb2c6e07a9785d8392a0ffd
---

# Protect derivation lineage without disclosing receipt metadata

Separate advisory asset indexes from producer-attested lineage, scoped receipt reads and tenant-container mutation authority.

## Procedure Steps

1. Derivation indexes are discovery data, not authority. Bind protected producer issuance to immutable source and output generations; preserve inherited tenant custody and traverse historical aliases through trusted proofs. Reject hash, path or source-custody mismatches rather than replaying any older receipt.

Ordinary tenant operations must authorize their own canonical index even when absent before entering the exact receipt-file read capability. Keep that grant synchronous and private, preserve caller resource ceilings, and revoke it before planning. Redact errors that could disclose another tenant's paths or proof metadata. A producer's system receipt permission does not grant authority over a confidential container holding foreign tenant indexes; ancestor mutation needs both checks.

Offboarding exports the validated snapshot and revalidates file identity and bytes before deletion. If a generation changes or deletion fails, return error and retain lineage. Cooperative locks do not make filesystem deletion atomic against arbitrary external writers. Unproven legacy lineage requires trusted review or reissuance.

Keep feature logic in information-assets and storage; foundation holds only the sealed capability registry. Verify real operator positive cases, foreign denials, aggregate mutation, recreated files and unchanged bytes. Run frozen leak-strict validation after builds finish so concurrent build logs are not mistaken for test pollution.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-SCOPE-STACK-REVIEW-20261108/evidence/implementation-report.md
- active/missions/public/MSN-SCOPE-STACK-REVIEW-20261108/evidence/review-findings.md
- active/missions/public/MSN-SCOPE-STACK-REVIEW-20261108/evidence/test-report.md

## Artifacts
