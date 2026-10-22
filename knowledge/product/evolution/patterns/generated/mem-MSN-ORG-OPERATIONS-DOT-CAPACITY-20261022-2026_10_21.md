---
record_id: mem-MSN-ORG-OPERATIONS-DOT-CAPACITY-20261022-2026_10_21
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-ORG-OPERATIONS-DOT-CAPACITY-20261022-2026_10_21
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-21T20:30:26.041Z
source_branch: work/main-20261022
source_commit: a875643b8c72c07c68210b140012162823599a69
---

# Organization management requires real IO and browser verification

Expose configurable Dot admission and organization people operations through the same governed CLI and UI facades.

## Applicability

- mission
- mission:MSN-ORG-OPERATIONS-DOT-CAPACITY-20261022

## Reusable Steps

1. Expose configurable Dot admission and organization people operations through the same governed CLI and UI facades

## Expected Outcome

Keep Dot admission capacity distinct from execution concurrency; default bundled charters to 100 while preserving explicit custom limits. Apply live changes through pause, preview, apply and activate, retaining unrelated charter fields. Expose humans, plural roles, the current operator, agent lifecycle and accountable humans. Mocked facade tests can miss journal lease grants: validate real secure IO, authority, leases and projections in a product-policy-only synthetic fixture. Also verify an authenticated browser save and tenant denial. Preserve the native Request origin for Next mutation guards; never compensate for host normalization by trusting aliases or forwarded headers. Keep owner/context/version checks and ambiguous-write recovery in the UI.

## Evidence

- active/missions/public/MSN-ORG-OPERATIONS-DOT-CAPACITY-20261022/evidence/implementation-report.md
- active/missions/public/MSN-ORG-OPERATIONS-DOT-CAPACITY-20261022/evidence/test-report.md

## Artifacts
