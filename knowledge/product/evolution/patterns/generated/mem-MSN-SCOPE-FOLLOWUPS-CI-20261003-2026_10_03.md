---
record_id: mem-MSN-SCOPE-FOLLOWUPS-CI-20261003-2026_10_03
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-SCOPE-FOLLOWUPS-CI-20261003-2026_10_03
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-03T04:41:11.926Z
source_branch: claude/scope-followups-ci-stability
source_commit: 8a9f388d7dbf5e2995ed9c7d348030d07ca4dd00
---

# Routing a low-level lookup through a governed resolver: re-entrancy, invisible-not-absent, and test doubles

Backing path-resolver's findMissionPath with the owner-scope resolver (which sits above it) needed a registration hook, and three non-obvious failure modes appeared: unbounded re-entrancy through secure-io's permission check, invisible missions reading as absent (inviting duplicate creation), and module mocks lacking the hook. Separately, CI flakes were fixed by measuring, not by retrying.

## Applicability

- mission
- mission:MSN-SCOPE-FOLLOWUPS-CI-20261003

## Reusable Steps

1. Backing path-resolver's findMissionPath with the owner-scope resolver (which sits above it) needed a registration hook, and three non-obvious failure modes appeared: unbounded re-entrancy through secure-io's permission check, invisible missions reading as absent (inviting duplicate creation), and module mocks lacking the hook
2. Separately, CI flakes were fixed by measuring, not by retrying

## Expected Outcome

- When a low-level module must answer through a higher-level one (import cycle), register a locator on a globalThis symbol and import the registering module from the main consumers (mission-state) so semantics do not depend on import order.
- Guard the hook against re-entrancy: the resolver reads through secure-io, whose permission check resolves identity, which calls the same lookup. A nested call must take the plain path; otherwise lookups recurse without bound (symptom: test workers at 85% CPU forever, no output). Find such hangs by attaching the inspector to the stuck worker (kill -USR1 + Debugger.pause over CDP) and reading the stack.
- A resource that exists but is not visible to the caller must not read as absent: callers do 'find ?? create' and would make a second copy, turning the id ambiguous for everyone. Fail closed with a distinct code (OWNER_NOT_VISIBLE), and let permission/identity paths degrade to a clean deny instead of throwing.
- Registration must tolerate module test doubles (vi.mock of the low-level module without the hook); test doubles already stub the looked-up function.
- Timing smokes on shared runners: judge an over-budget case by best-of-N re-runs (noise does not repeat, catastrophic backtracking does) and prove it still catches the real failure with a deliberately bad pattern.
- Module-scope 'registered once' guards reset on every vi.resetModules re-import; process-wide registrations (exit listeners) must be deduplicated on globalThis, or MaxListeners warnings and leaks follow.

## Evidence

- active/missions/public/MSN-SCOPE-FOLLOWUPS-CI-20261003/evidence/implementation-report.md
- active/missions/public/MSN-SCOPE-FOLLOWUPS-CI-20261003/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-SCOPE-FOLLOWUPS-CI-20261003/evidence/test-report.md

## Artifacts
