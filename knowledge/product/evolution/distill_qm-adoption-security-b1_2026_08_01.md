---
title: 'Asymmetric Command Screening and Ledger Reconciliation'
category: Evolution
tags: ['development', 'security-governance', 'TypeScript', 'command-policy', 'mission-control']
importance: 7
source_mission: QM-ADOPTION-SECURITY-B1
author: Kyberion Wisdom Distiller
last_updated: 2026-08-01
---

# Asymmetric Command Screening and Ledger Reconciliation

## Summary

The mission delivered hardened command screening, fail-closed content controls, recoverable work leases, and portable scheduler paths, with 150 tests and all governance checks passing. A fresh-context adversarial review and commit-bound reconciliation converted direct implementation work into a verified, deliverable mission outcome.

## Key Learnings

- De-obfuscation must be asymmetric: deny policies should inspect both raw commands and normalized units, while allow policies should evaluate only guarded original command words to prevent normalization from accidentally widening permissions.
- Security verdict parsing should fail closed when a verdict is invalid; genuine scanner unavailability should remain explicitly labeled so operators can distinguish degraded screening from approval.
- Lease recovery needs both ownership-aware renewal and bounded retry budgets, allowing expired work to be reclaimed while parking poison-pill items instead of cycling indefinitely.
- Persist scheduler references as repository-relative paths, migrate recognizable legacy absolute paths, and reject paths outside the repository to preserve portability and containment.

## Patterns Discovered

- A two-round fresh-context review pattern—NO-GO with concrete bypasses, targeted remediation, then GO—exposed quote-erasure, privilege-wrapper, environment, continuation, redirect, and risky-argument cases that ordinary implementation tests missed.
- Checkpoint commits provide implementation evidence but do not complete governed task records; direct owner work requires a manifest-based reconciliation step that binds completed tasks to a source commit.
- External delivery should remain a separately gated task: pause after verified implementation, obtain explicit operator approval, then reconcile the delivery and retrospective artifacts.

## Failures & Recoveries

- Fresh-context review found four P0 command-policy bypass classes and multiple P1 weaknesses → redesigned evaluation around asymmetric deny/allow semantics, hardened regexes and quarantine behavior, expanded tests, and passed the second review.
- Mission finish was blocked because checkpoints and evidence did not update NEXT_TASKS task status → used mission_controller reconcile-work with commit-bound manifests to adopt six implementation tasks and later the delivery and retrospective tasks.
- Initial work was distilled before lifecycle completion and PR delivery remained approval-gated → paused safely, resumed after operator approval, delivered PR #648, reconciled the final tasks, and re-verified the mission.

## Reusable Artifacts

- shell-command-normalize.ts and its wrapper-aware, ReDoS-guarded command normalization tests
- security-screen.ts primitives for posture floors, provenance, fail-closed verdicts, shadow screening, and bounded quarantine storage
- Work-coordination lease reaping and poison-pill parking with claim/error attempt budgets
- Repository-relative scheduler path migration and resolveScheduledPipelinePath
- Manifest-based existing-work reconciliation receipts tied to source commits
- knowledge/product/evolution/distill_qm-adoption-security-b1_2026_08_01.md

---

_Distilled by Kyberion | Mission: QM-ADOPTION-SECURITY-B1 | 2026-08-01_
