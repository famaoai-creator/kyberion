---
record_id: mem-MSN-OPS-SEAM-HARDENING-20261007-2026_10_06
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-OPS-SEAM-HARDENING-20261007-2026_10_06
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-06T20:46:18.088Z
source_branch: fix/mission-repair-visibility-20261007
source_commit: ebe73ce0d145e28175b36233da4dea1ebe14c4ec
---

# Operator-visibility seams: zero-config alert delivery + stale-dist detection

Ops alerts with no configured channel were recorded-but-undelivered (a 6.4h daemon hang went unseen). sendOpsAlert now falls back to the local deliverable inbox, preserving the retryable envelope on failure. Separately, stale dist artifacts after a branch switch surfaced as opaque ERR_PACKAGE_PATH_NOT_EXPORTED fatal_errors; baseline-check L2 now scans dist workspace imports (incl. dist/libs, workspace-only) and reports needs_recovery with a rebuild hint.

## Hint Scope

mission

## Trigger Phrases

- Two operator-visibility seams closed: (1) ops-alert fallback to the local inbox when no webhook/prefs exist — explicit mute still wins, failed fallback keeps the undelivered envelope for redelivery; (2) dist staleness detected at baseline-check L2 via workspace-import resolution, with dist/libs added as a workspace-only scan root so package-level deps (jsdom) do not false-positive. Operator verbs now hint mission repair for exists-but-invisible missions instead of bare not-found.

## Recommended References

- active/missions/public/MSN-OPS-SEAM-HARDENING-20261007/evidence/retrospective.md
- active/missions/public/MSN-OPS-SEAM-HARDENING-20261007/evidence/implementation-report.md
- active/missions/public/MSN-OPS-SEAM-HARDENING-20261007/evidence/test-report.md

## Evidence

- active/missions/public/MSN-OPS-SEAM-HARDENING-20261007/evidence/retrospective.md
- active/missions/public/MSN-OPS-SEAM-HARDENING-20261007/evidence/implementation-report.md
- active/missions/public/MSN-OPS-SEAM-HARDENING-20261007/evidence/test-report.md

## Artifacts
