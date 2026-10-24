---
record_id: mem-MSN-CUSTOMER-DECISION-HARDENING-20261025-2026_10_24
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CUSTOMER-DECISION-HARDENING-20261025-2026_10_24
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-24T18:28:37.686Z
source_branch: fix/customer-decision-hardening-20261025
source_commit: 4f17be062eee6c7e2b156b4c08a5e20431f8c3d9
---

# Narrow roles are enforced at the guard; shared records carry ids on every path; slots release when work settles

Lessons from hardening customer decision governance: content rules for narrow roles must be enforced where secure-io writes, every path into shared approval / notification / alert stores must carry ids only, and concurrency slots must be released when the work settles.

## Applicability

- mission
- mission:MSN-CUSTOMER-DECISION-HARDENING-20261025

## Reusable Steps

1. Lessons from hardening customer decision governance: content rules for narrow roles must be enforced where secure-io writes, every path into shared approval / notification / alert stores must carry ids only, and concurrency slots must be released when the work settles

## Expected Outcome

Applies when adding narrow authority roles, customer outbound paths or rate-limited surface endpoints.

1. A content rule that lives only in a store is a coding convention: enforce it at the guard by passing write content from safeWriteFile to tier-guard for the roles that need it, and refuse content-less writes (append, rename, copy, link) for those roles.
2. A shared role that may write a shared file (e.g. the deliverable inbox) needs an append-only content rule; write appends as raw text so one malformed older line does not block every writer.
3. When one outbound path is fixed to carry ids only, audit every other path into the same shared stores (approval requests, operator notifications, ops alerts, worker events) and fix them together; give operators a tenant-bound read command for the content.
4. Bind an approval to the effect: body hash and channel in the payload and the correlation id, so a second channel needs a new approval.
5. Release concurrency slots when the work settles, not when the client disconnects, and cap in-flight work per address as well as globally.
6. An explicitly configured reasoning backend must not silently fall back to another provider.

## Evidence

- active/missions/public/MSN-CUSTOMER-DECISION-HARDENING-20261025/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CUSTOMER-DECISION-HARDENING-20261025/evidence/retrospective.md
- active/missions/public/MSN-CUSTOMER-DECISION-HARDENING-20261025/evidence/implementation-report.md

## Artifacts
