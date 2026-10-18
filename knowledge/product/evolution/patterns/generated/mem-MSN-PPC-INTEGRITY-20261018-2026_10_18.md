---
record_id: mem-MSN-PPC-INTEGRITY-20261018-2026_10_18
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-PPC-INTEGRITY-20261018-2026_10_18
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-18T07:24:04.302Z
source_branch: feat/ppc-integrity-20261018
source_commit: 1f1bdd679bcae5040bfbd5d3f33c779a2f842ab2
---

# Adopted bytes must equal probed bytes — manifest-verify every copy boundary

Contrastive-probe adoption must verify sha256 manifests at every copy boundary, not just copy from a snapshot.

## Applicability

- mission
- mission:MSN-PPC-INTEGRITY-20261018

## Reusable Steps

1. Contrastive-probe adoption must verify sha256 manifests at every copy boundary, not just copy from a snapshot

## Expected Outcome

When an agent materializes an auto_advance winner overlay onto the next round base, source it from the staged snapshot — never the live overlayDir. Under an unsandboxed scenario command every verification point is a window: (1) hash bytes AS READ into the run dir (copyTreeHashed), not a second read; (2) re-verify snapshot AND current-base manifests before copying; (3) re-hash the materialized tree and require it to equal base-manifest overridden by snapshot-manifest; (4) carry the verified manifest into the next round so a mutation in the verify->next-manifest window is recorded, not silently re-baselined. Failure mode at each step: materialization_error halt with the reason mirrored into the round record and the report.

## Evidence

- active/missions/public/MSN-PPC-INTEGRITY-20261018/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-PPC-INTEGRITY-20261018/evidence/test-report.md
- active/missions/public/MSN-PPC-INTEGRITY-20261018/evidence/delivery-report.md
- active/missions/public/MSN-PPC-INTEGRITY-20261018/evidence/retrospective.md

## Artifacts
