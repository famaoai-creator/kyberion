---
record_id: mem-MSN-TENANT-INGEST-20261009-2026_10_09
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-TENANT-INGEST-20261009-2026_10_09
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-09T04:49:43.997Z
source_branch: fix/ingest-flow-20261009
source_commit: 32647f42dadb8dc80e18f5b0bc1608d717f4b04a
---

# Keep document duplicate evidence within the selected tenant

A successful import in one tenant must not suppress filing identical bytes into another authorized destination.

## Applicability

- mission
- mission:MSN-TENANT-INGEST-20261009

## Reusable Steps

1. A successful import in one tenant must not suppress filing identical bytes into another authorized destination

## Expected Outcome

The explicit document-ingest ceremony should use committed asset hashes from the selected tenant information-asset ledger, rather than a global content-hash registry. A global registry confuses content identity with destination-specific completion, can expose unrelated target hints, and adds a failure point after a successful card/ledger commit. Leave ambiguous legacy registry rows untouched and consume only the scoped duplicate verdict. Preserve historical-hash and same-source version/reparse semantics. Verify identical documents and independent updates across two tenants, read-only previews, a foreign legacy hash, a failed append after card write, and a retry from committed ledger state without a registry row. Sequential retry evidence does not establish atomic concurrent commits.

## Evidence

- active/missions/public/MSN-TENANT-INGEST-20261009/evidence/implementation-report.md
- active/missions/public/MSN-TENANT-INGEST-20261009/evidence/test-report.md
- active/missions/public/MSN-TENANT-INGEST-20261009/evidence/REVIEW-execution-implement.md

## Artifacts
