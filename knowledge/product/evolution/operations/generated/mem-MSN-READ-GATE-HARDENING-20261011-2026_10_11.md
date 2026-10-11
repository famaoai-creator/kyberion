---
record_id: mem-MSN-READ-GATE-HARDENING-20261011-2026_10_11
kind: sop_candidate
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-READ-GATE-HARDENING-20261011-2026_10_11
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-11T11:32:53.747Z
source_branch: fix/read-gate-hardening-20261011
source_commit: 412d93b94a69f1159b4ad7a7eae8202f2f095bdf
---

# Security-gate rollout needs enumerator coverage, scope-source parity, and emit completeness

Landing an io-layer gate is only half the work — every enumerator must adopt the bound-partition probe via a shared helper (not per-site fallbacks), the binding must come from resolveProjectScope (env + scope.env + execution scope), and dist checks need completeness alongside freshness.

## Procedure Steps

1. (1) When a protected prefix starts denying enumeration, find every enumerator (grep safeReaddir/safeLstat over the prefix) — the ones bypassing the shared scan break silently or crash sweeps; consolidate behind one helper (missionTierScanDirs). (2) Identity binding has three sources (env, persisted scope.env, execution scope) — a check that reads only process.env misses scope.env-bound daemons; always resolve via the same resolver the io layer uses. (3) Denial asymmetry: existsSync reads as false while lstat/readdir throw — enumerators must treat invisible and missing the same at tier roots. (4) Freshness and completeness are different axes for dist: incremental tsc can credit un-emitted outputs; verify recorded sources have their expected .js (emit_missing). (5) A third copy of a fallback is the signal to centralize — the per-site try/probe pattern drifted before the shared helper landed.

## Safety Notes

- Require approval before irreversible or high-risk actions.
- Capture evidence before and after the action.

## Escalation Conditions

- Unexpected runtime failure
- Policy or approval mismatch
- Result does not match the expected state

## Evidence

- active/missions/public/MSN-READ-GATE-HARDENING-20261011/evidence/implementation-report.md
- active/missions/public/MSN-READ-GATE-HARDENING-20261011/evidence/retrospective.md

## Artifacts
