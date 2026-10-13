---
record_id: mem-MSN-COSESSION-HOOKS-20261014-2026_10_13
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-COSESSION-HOOKS-20261014-2026_10_13
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-13T18:34:42.608Z
source_branch: feat/cosession-hook-bridge
source_commit: cc1e03740bcaf3f3fa7fd19b14a2fbdc6d856b89
---

# Co-session hook bridge: delivery and enforcement for same-checkout coordination

A host-agnostic bridge joins a co-session at session start, drains pending handoffs on each prompt turn, denies writes to foreign-leased paths, and releases leases at session end. Lease acquire/release are serialized by a shared inter-process lock. CLIs without lifecycle hooks poll the generic monitor instead.

## Hint Scope

mission

## Trigger Phrases

- Pattern: keep all coordination logic in one neutral core (join/heartbeat/drain/lease-gate/end) and make each host a thin stdin/stdout adapter around its native hook events. Bind cleanup to the real session-end event, not a per-turn stop event. Identity derives from the host's stable session key (<provider>-<session_id>); when a host acquires a lease from its own CLI it must pass that id explicitly, since one-shot CLI processes fall back to a pid and the gate would deny the holder's own writes. Fail open everywhere except the affirmative lease deny; deny text names holder, expiry and alternatives. Wiring must be deliberate: a tracked settings file in the repo, or a generation ceremony for gitignored host state dirs — hand-installed configs drift silently.

## Recommended References

- active/missions/public/MSN-COSESSION-HOOKS-20261014/evidence/implementation-report.md
- active/missions/public/MSN-COSESSION-HOOKS-20261014/evidence/distillation.md
- active/missions/public/MSN-COSESSION-HOOKS-20261014/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-COSESSION-HOOKS-20261014/evidence/test-report.md

## Evidence

- active/missions/public/MSN-COSESSION-HOOKS-20261014/evidence/implementation-report.md
- active/missions/public/MSN-COSESSION-HOOKS-20261014/evidence/distillation.md
- active/missions/public/MSN-COSESSION-HOOKS-20261014/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-COSESSION-HOOKS-20261014/evidence/test-report.md

## Artifacts
