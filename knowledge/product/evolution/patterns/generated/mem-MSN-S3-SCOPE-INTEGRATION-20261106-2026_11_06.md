---
record_id: mem-MSN-S3-SCOPE-INTEGRATION-20261106-2026_11_06
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-S3-SCOPE-INTEGRATION-20261106-2026_11_06
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-06T01:25:39.960Z
source_branch: feat/scope-independent-resolution-20261106
source_commit: 509a7c34898f84331b1f94db044a293a2af1b254
---

# Preflight tenant migrations and preserve attachment bytes

Validate every source before any copy or deletion, preserve non-JSON bytes, and refuse destination overwrites.

## Applicability

- mission
- mission:MSN-S3-SCOPE-INTEGRATION-20261106

## Reusable Steps

1. Validate every source before any copy or deletion, preserve non-JSON bytes, and refuse destination overwrites

## Expected Outcome

A tenant data migration must plan and validate all tenants before its first copy or deletion, including dry-run. Reject symlinks, nonregular entries and README directories or links rather than silently dropping them during recursive cleanup. Relink only the declared JSON/JSONL reference files; read and write all other attachments as bytes. Use exclusive destination writes and keep existing sources when a destination already exists. Exercise the actual migration under real policies in an isolated root, including invalid UTF-8 attachments, unsupported later-tenant entries, dry-run and no-overwrite cases. Copy/delete is not transactional: an I/O failure may leave a partial destination and requires manual reconciliation with source writers quiesced. Synthetic tests do not establish success on actual user data. See migration/0003-deal-home.ts and its regression suite.

## Evidence

- active/missions/public/MSN-S3-SCOPE-INTEGRATION-20261106/evidence/implementation-report.md
- active/missions/public/MSN-S3-SCOPE-INTEGRATION-20261106/evidence/test-report.md

## Artifacts
