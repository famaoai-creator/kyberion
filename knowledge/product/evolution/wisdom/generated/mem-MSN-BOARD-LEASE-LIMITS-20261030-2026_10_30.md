---
record_id: mem-MSN-BOARD-LEASE-LIMITS-20261030-2026_10_30
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-BOARD-LEASE-LIMITS-20261030-2026_10_30
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-30T08:40:53.680Z
source_branch: fix/board-lease-limits-20261030
source_commit: 86df8dcbd8aa26308774fff43435c258df89d8d9
---

# Checking a board snapshot outside its writer lease, and repairing partial applies

Keep slow checks out of a non-re-entrant writer lease by planning on a snapshot and writing only if the board is unchanged; make multi-store applies re-runnable by detecting the store the earlier run never wrote; compute dependency closures over every graph a cycle can span.

## Hint Scope

mission

## Trigger Phrases

- - A non-re-entrant writer lease must not wrap slow checks or caller callbacks: a callback that writes the board (or just runs long) hits the lock timeout. Check a snapshot outside the lease, then write under it only if the board still equals the snapshot; re-check a changed board a bounded number of times, then fall back to checking under the lease so progress is guaranteed.
- A command that updates several stores in order (WorkItems, ledger, board, receipt) must treat 'already applied' per store. Deciding from the first store alone (WorkItem done with this manifest hash) makes a re-run report success while the board stays stale. Detect the stale store, re-validate against the approved input rather than trusting worker-writable metadata, and dedupe append-only records per task and input hash.
- When rewiring dependencies under a lease, a task added after the plan was read needs the same rewiring, and the same safety checks: never point a task the replacement (transitively) waits on at the replacement. Build the dependency closure over the union of every graph (board and WorkItems); a closure over one graph misses cycles that span both.
- Following a supersede chain to redirect authority (dependencies, review targets) requires the supersede to be proven; an unproven record stays on disk and stays pending.
- Running two vitest processes in the same worktree on the same files collides on shared fixtures and looks like real failures; run the suite alone before trusting a red result.

## Recommended References

- active/missions/public/MSN-BOARD-LEASE-LIMITS-20261030/evidence/distillation.md

## Evidence

- active/missions/public/MSN-BOARD-LEASE-LIMITS-20261030/evidence/distillation.md

## Artifacts
