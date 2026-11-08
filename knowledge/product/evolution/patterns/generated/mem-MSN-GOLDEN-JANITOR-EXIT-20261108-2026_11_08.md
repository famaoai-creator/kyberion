---
record_id: mem-MSN-GOLDEN-JANITOR-EXIT-20261108-2026_11_08
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-GOLDEN-JANITOR-EXIT-20261108-2026_11_08
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-08T00:48:00.101Z
source_branch: fix/golden-janitor-exit-20261108
source_commit: 33ef7d8dec6fa624802ff71b831072541721bb68
---

# Detached maintenance must release its Node event-loop reference

A detached OS process can still retain its parent's Node event loop. Release only explicitly background, ignored-stdio child handles after managed registration and prove natural exit.

## Applicability

- mission
- mission:MSN-GOLDEN-JANITOR-EXIT-20261108

## Reusable Steps

1. A detached OS process can still retain its parent's Node event loop
2. Release only explicitly background, ignored-stdio child handles after managed registration and prove natural exit

## Expected Outcome

When a one-shot check prints success but does not exit, distinguish output correctness from process lifetime. Inspect owned child handles before changing deadlines or golden baselines. For intentionally detached maintenance with ignored stdio, call child.unref() after spawnManagedProcess has registered supervision; preserve registration failure handling, submission markers and asynchronous job behavior. Do not globally unref managed children: watch and manual execution owners may require their handles. Use a finite timer-only child through the real compiled managed-process module: referenced control retains ProcessWrap and exits after child completion; released variant has no ProcessWrap and naturally exits while child exitCode is null. Avoid forced process.exit and wall-clock thresholds. Register any new boundary-test consumer and run strict state checks without overlapping runtime writers. This mechanism is proven by a controlled fixture; the original failed CI runner's child PID was not recovered.

## Evidence

- active/missions/public/MSN-GOLDEN-JANITOR-EXIT-20261108/evidence/implementation-report.md
- active/missions/public/MSN-GOLDEN-JANITOR-EXIT-20261108/evidence/test-report.md
- active/missions/public/MSN-GOLDEN-JANITOR-EXIT-20261108/evidence/REVIEW-execution-implement.md

## Artifacts
