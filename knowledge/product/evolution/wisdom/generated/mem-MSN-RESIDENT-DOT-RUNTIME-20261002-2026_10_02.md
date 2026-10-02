---
record_id: mem-MSN-RESIDENT-DOT-RUNTIME-20261002-2026_10_02
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-RESIDENT-DOT-RUNTIME-20261002-2026_10_02
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-02T03:31:48.854Z
source_branch: devin/resident-dot-runtime-20261002
source_commit: edeb61cc25591d8f1344475ee147d7675ee1b0dc
---

# Resident dot runtime: governed wake loop and lifecycle/runtime role separation

How to wire a resident agent contract into bounded wakes safely: gate activation on role existence + heartbeat uniqueness; dedupe wake keys per dot in a durable ledger (delivered/rejected consume, failed retries with backoff, skipped never consumes); re-validate the bound role on every wake; separate charter-writing authority from the runtime-bound role so a resident cannot rewrite its own contract; give each dot a heartbeat whose staleness budget is the charter max_idle_wake_ms, not the daemon default; degrade to one delegated turn bounded by wall_clock_ms_per_wake when the reasoning backend lacks tool use.

## Hint Scope

mission

## Trigger Phrases

- See knowledge/product/architecture/resident-dot-model.md and dots/README.md for the landed contract. Implementation seams: libs/core/dot/dot-runtime.ts (due-ness + ledgers + runDotWake), libs/core/dot/dot-lifecycle.ts (gated transitions under dot_lifecycle_writer), agent-runtime-supervisor sweep multiplexing, daemon_watchdog heartbeat union.

## Recommended References

- active/missions/public/MSN-RESIDENT-DOT-RUNTIME-20261002/evidence/implementation-report.md
- active/missions/public/MSN-RESIDENT-DOT-RUNTIME-20261002/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-RESIDENT-DOT-RUNTIME-20261002/evidence/test-report.md
- active/missions/public/MSN-RESIDENT-DOT-RUNTIME-20261002/evidence/distillation.md

## Evidence

- active/missions/public/MSN-RESIDENT-DOT-RUNTIME-20261002/evidence/implementation-report.md
- active/missions/public/MSN-RESIDENT-DOT-RUNTIME-20261002/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-RESIDENT-DOT-RUNTIME-20261002/evidence/test-report.md
- active/missions/public/MSN-RESIDENT-DOT-RUNTIME-20261002/evidence/distillation.md

## Artifacts
