---
record_id: mem-MSN-RECEIPT-VIEWER-20261006-2026_10_06
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-RECEIPT-VIEWER-20261006-2026_10_06
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-06T08:26:24.677Z
source_branch: feat/diagnostic-receipt-viewer-20261006
source_commit: cb4214b60e4e8308bcfaed0bb2b1d097ace8f12d
---

# Deliver the same scoped artifact bytes that were verified

A governed artifact viewer should resolve scope on the server, bound the actual read, and deliver the exact verified buffer under immutable version identity.

## Applicability

- mission
- mission:MSN-RECEIPT-VIEWER-20261006

## Reusable Steps

1. A governed artifact viewer should resolve scope on the server, bound the actual read, and deliver the exact verified buffer under immutable version identity

## Expected Outcome

## Applicability

Use when exposing retained execution receipts through an authenticated diagnostic viewer.

## Design rules

1. Derive identity, tenant, conversation and tier from the server. Accept immutable request/revision/hash selectors rather than filesystem paths, and constrain the endpoint to its specific JSON artifact contract.
2. Apply the strict repository path guard to the receipt and its parent. Checking only the leaf does not establish that ancestors are ordinary directories. Validate real helpers with symlink fixtures as well as mocks.
3. Bound the byte read itself. A pathname size check can become stale before open. Hash and compare the returned buffer with exact expected content, then use that same buffer for delivery without reopening the path. This does not establish atomic protection against a malicious filesystem actor changing ancestors after validation.
4. Preserve selected versions by immutable identity. Distinguish older verified history from the latest version and honor currentness returned with the body. Render the exact text without HTML injection or reformatting.
5. Clear cached and pending body data when authorization or scope is lost. Bind asynchronous completion to a generation and version identity so an obsolete response cannot restore revoked or replaced content.

## Verification boundaries

Source tests and independent review support these rules. Keep aggregate test outcomes separate from focused passes. Synthetic API and DOM fixtures do not establish a real authenticated browser journey. An unavailable external consistency check supplies no verdict. Preserve source-only checkpoints and bind promoted provenance to the published source commit.

## Evidence

- active/missions/public/MSN-RECEIPT-VIEWER-20261006/evidence/implementation-report.md
- active/missions/public/MSN-RECEIPT-VIEWER-20261006/evidence/test-report.md
- active/missions/public/MSN-RECEIPT-VIEWER-20261006/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-RECEIPT-VIEWER-20261006/evidence/distillation.md

## Artifacts
