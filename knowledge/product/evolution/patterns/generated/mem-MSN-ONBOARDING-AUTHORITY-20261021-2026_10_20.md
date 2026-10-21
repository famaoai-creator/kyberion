---
record_id: mem-MSN-ONBOARDING-AUTHORITY-20261021-2026_10_20
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-ONBOARDING-AUTHORITY-20261021-2026_10_20
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-20T21:26:07.081Z
source_branch: feat/onboarding-authority-20261021
source_commit: f3eca3e68604bffce475fae5dafd322bd7fa67fe
---

# Onboarding delegation must bind consent, runtime identity and transport confinement

Separate connection authentication from exact owner consent, preserve Charter accounting and lifecycle, and enforce destination grants at the actual transport boundary.

## Applicability

- mission
- mission:MSN-ONBOARDING-AUTHORITY-20261021

## Reusable Steps

1. Separate connection authentication from exact owner consent, preserve Charter accounting and lifecycle, and enforce destination grants at the actual transport boundary

## Expected Outcome

Use a real installed receiving NHI to request scoped delegation and record the authenticated human initiator separately; this is owner consent, not independent review. Freeze the recipient, scope, operations, targets, expiry, activation and complete renewal limits in the reviewed digest. Revalidate ownership, suspension, live-versus-renewal lifecycle and standing stops before application; serialize retirement and acceptance under the same lock. Initial activation must not lift a concurrent suspension during journal replay. Carry spend, pending reservations, late settlements and stops through replacements and verified renewal. A public destination grant never declassifies protected content or widens a child egress policy. Browser origin matching alone is insufficient: require a fresh isolated context, blocked service workers/scripts/forms and a network fence installed before any navigation, with redirects and other origins denied. Verify both actual identity/approval stores with signed principals and a separate real Chromium owned-HTTPS network fixture. Reuse the canonical JSON loader, CLI module registry, workspace ledger and partitioned storage floors rather than raising registration ratchets.

## Evidence

- active/missions/public/MSN-ONBOARDING-AUTHORITY-20261021/evidence/implementation-report.md
- active/missions/public/MSN-ONBOARDING-AUTHORITY-20261021/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-ONBOARDING-AUTHORITY-20261021/evidence/test-report.md

## Artifacts
