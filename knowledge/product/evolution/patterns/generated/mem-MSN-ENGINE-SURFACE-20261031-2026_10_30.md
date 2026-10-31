---
record_id: mem-MSN-ENGINE-SURFACE-20261031-2026_10_30
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-ENGINE-SURFACE-20261031-2026_10_30
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-30T19:22:20.136Z
source_branch: fix/engine-runtime-surface-20261031
source_commit: 47a6bcb36a4b792476e222f9f1927c716df9361e
---

# Local settings surfaces separate HTTP and profile authority

Pin local transport and origin before entering an exact profile capability, and verify cold policy dependencies through real HTTP operations.

## Applicability

- mission
- mission:MSN-ENGINE-SURFACE-20261031

## Reusable Steps

1. Pin local transport and origin before entering an exact profile capability, and verify cold policy dependencies through real HTTP operations

## Expected Outcome

A local settings surface must authenticate the direct loopback peer, pin the local Host even for reads, and require same-origin mutations before resolving private settings. Use a fixed-operation facade paired with a revocable exact profile capability and narrow role; preserve outer resource ceilings and nested capability intersection. Admit directory creation separately from content reads or writes. Include the cold write-policy loader and exact product schema/config dependencies, and test role-only denial plus actual policy loading. Compare a profile-bound revision under the same lock as save, apply only dirty fields and explicit unset operations, and preserve drafts on failure. Disable saving until a valid snapshot loads. Cover body-parser errors with a route-scoped authenticated JSON error boundary and no-store responses. Validate save/unset, invalid Host/Origin, stale revisions, malformed/oversized JSON and unknown errors over HTTP in an isolated profile. These are implementation contracts verified by focused tests, real HTTP probes and independent review; extraction was structural and manually curated.

## Evidence

- active/missions/public/MSN-ENGINE-SURFACE-20261031/evidence/implementation-report.md
- active/missions/public/MSN-ENGINE-SURFACE-20261031/evidence/test-report.md
- active/missions/public/MSN-ENGINE-SURFACE-20261031/evidence/REVIEW-execution-implement.md

## Artifacts
