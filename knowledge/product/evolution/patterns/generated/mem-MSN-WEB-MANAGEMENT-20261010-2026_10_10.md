---
record_id: mem-MSN-WEB-MANAGEMENT-20261010-2026_10_10
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-WEB-MANAGEMENT-20261010-2026_10_10
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-10T09:13:44.466Z
source_commit: c9f6970b3edce6dadc2b6cccf4c91c0f016c0f3a
---

# Bound Web entity management with authenticated scope and exact resource capabilities

A usable management flow must bind confirmed edits to the authenticated human and canonical tenant/organization/project scope, then confine all filesystem effects independently of ambient roles.

## Applicability

- mission
- mission:MSN-WEB-MANAGEMENT-20261010

## Reusable Steps

1. A usable management flow must bind confirmed edits to the authenticated human and canonical tenant/organization/project scope, then confine all filesystem effects independently of ambient roles

## Expected Outcome

Resolve the authenticated human and intersect viewer/principal entity grants on the server. Re-read active owner membership, tenant status and credential expiry after waiting for a mutation lock. Client-selected scope can only narrow authority; a confirmed draft must carry a non-secret actor-and-grant context identifier so changed login cookies cannot silently rebind it.

Put immutable exact read/write/mkdir/metadata capabilities ahead of default, persona and elevated ambient grants. Apply them to both literal and canonical paths, including existence/realpath probes and implicitly created parent directories. Keep management roles dedicated to the intended surface and call typed facades rather than arbitrary CLI commands.

Use versions and deterministic idempotency receipts for repeated actions. Distinguish a committed mutation with pending audit from a failed mutation; retry the exact request only to complete its audit. Retain committed entity selection when refresh fails. Preserve unchanged or absent descriptive fields during name-only edits, and disclose any purpose-approval reset before saving.

Hash newly recorded audit entries in the same normalized field order used by persisted verification. Prove legacy SHA/HMAC compatibility with unchanged historical bytes; do not migrate or rewrite history as part of a Web feature.

State durability limits explicitly: a Web-only mutex does not coordinate CLI writers, exception rollback is not a crash-atomic journal, and page-local retry handles disappear on navigation. Idempotency receipts are load-bearing evidence and require review before deletion. A successful component test or build is not visual browser verification; report blocked browser dependencies separately.

Implementation examples: libs/core/foundation/resource-access-scope.test.ts; libs/core/surface/surface-management-integration.test.ts; presence/displays/concierge/test/management-ui.test.ts; docs/developer/WEB_ENTITY_MANAGEMENT.ja.md.

## Evidence

- active/missions/public/MSN-WEB-MANAGEMENT-20261010/evidence/implementation-report.md
- active/missions/public/MSN-WEB-MANAGEMENT-20261010/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-WEB-MANAGEMENT-20261010/evidence/test-report.md

## Artifacts
