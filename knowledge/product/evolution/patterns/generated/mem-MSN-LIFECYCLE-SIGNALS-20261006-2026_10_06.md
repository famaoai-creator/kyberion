---
record_id: mem-MSN-LIFECYCLE-SIGNALS-20261006-2026_10_06
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-LIFECYCLE-SIGNALS-20261006-2026_10_06
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-06T15:10:53.252Z
source_branch: main
source_commit: 17529cb2a131466b81a5293c09d011a52fa490a2
---

# Lifecycle blind spots are cheap to close: warn on thin intent + dirty tree at kickoff, aggregate review suggestions across missions

MSN-LIFECYCLE-SIGNALS-20261006: (1) kickoff now warns when no intent baseline (--goal/--intent-goal) — verify/drift would be vacuous, and when the working tree is dirty (tracked changes only — untracked artifacts are routine). (2) pnpm mission suggestions aggregates non-blocking review findings across live+archived missions — receipts no longer die unseen. (3) operation add --preset runbook shrinks first-registration flags. (4) tenant pin test skips archived profiles.

## Applicability

- mission
- mission:MSN-LIFECYCLE-SIGNALS-20261006

## Reusable Steps

1. MSN-LIFECYCLE-SIGNALS-20261006: (1) kickoff now warns when no intent baseline (--goal/--intent-goal) — verify/drift would be vacuous, and when the working tree is dirty (tracked changes only — untracked artifacts are routine)
2. (2) pnpm mission suggestions aggregates non-blocking review findings across live+archived missions — receipts no longer die unseen
3. (3) operation add --preset runbook shrinks first-registration flags
4. (4) tenant pin test skips archived profiles

## Expected Outcome

Details: mission-dir detection must be marker-driven (mission-state.json/evidence/), not layout-driven — public/ mixes flat and tenant-nested, confidential/ mixes flat and nested. Sort findings by mission then time or grouped printing breaks. Ephemeral missions skip the intent warn (no gates). Per-process reasoning bootstrap probe caching remains a follow-up (staleness).

## Evidence

- active/missions/public/MSN-LIFECYCLE-SIGNALS-20261006/evidence/implementation-report.md

## Artifacts
