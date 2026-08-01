---
title: 'Asymmetric Shell Policy Hardening Through Adversarial Review'
category: Evolution
tags: ['development', 'security-policy', 'TypeScript', 'scheduler-portability', 'work-coordination']
importance: 7
source_mission: QM-ADOPTION-SECURITY-B1
author: Kyberion Wisdom Distiller
last_updated: 2026-08-01
---

# Asymmetric Shell Policy Hardening Through Adversarial Review

## Summary

Implemented the first two QM adoption batches, adding hardened command screening, fail-closed content controls, lease recovery, poison-work parking, and portable scheduler paths. A fresh-context adversarial review exposed four critical policy bypasses, which were redesigned and verified with 150 passing tests across 10 suites plus typecheck, build, lint, and governance checks.

## Key Learnings

- Command-policy normalization must be asymmetric: deny rules should inspect both raw input and normalized command units, while allow rules should evaluate original allowable command words with explicit privilege, environment, redirect, and risky-argument guards.
- Security screening must fail closed for invalid verdicts or broken deny policies; unavailable optional scanners may preserve labeled content only when downstream handling remains explicit and constrained.
- Lease renewal must validate both ownership and expiry, while bounded attempt budgets and parking prevent repeatedly failing work from remaining indefinitely in active coordination queues.
- Persist repository-relative scheduler paths and resolve them at execution time; migrate recognizable legacy paths and reject paths outside the repository boundary.

## Patterns Discovered

- A fresh-context adversarial review after incremental checkpoints is an effective security gate because it uncovered quote-erasure, sudo/environment inheritance, and symmetric de-obfuscation bypasses that component tests had not exposed.
- Security hardening is strongest when normalization, screening, quarantine limits, safe-regex constraints, and consumer regression tests are treated as one policy boundary rather than independent utilities.
- Operational recovery mechanisms should combine strict state validation with bounded retries and a terminal parking state, making stranded or poison work observable without allowing endless reprocessing.

## Failures & Recoveries

- Fresh-context review returned NO-GO with four P0 command-policy bypasses → redesigned evaluation asymmetrically, hardened deny and allow semantics, added privilege/environment/redirect/risky-argument guards, and expanded regression coverage.
- Malformed deny policy could degrade into approval → changed policy evaluation to fail closed.
- Shadow synchronization, continuations, pure filters, weak rm matching, and unbounded quarantine behavior produced additional P1 risks → neutralized synchronization paths, handled continuations, restricted filters, hardened destructive-command rules, and capped quarantine storage.

## Reusable Artifacts

- shell-command-normalize.ts: wrapper-aware command normalization and de-obfuscation with MIT attribution
- security-screen.ts: posture floors, provenance payloads, fail-closed verdicts, shadow screening, and quarantine storage
- Work-coordination lease reaping and poison-pill parking primitives with holder, expiry, claim, and error-budget checks
- resolveScheduledPipelinePath and registry migration logic for repository-relative scheduler paths
- 150-test verification set spanning command policy, screening, coordination, scheduling, and consumer regressions

---

_Distilled by Kyberion | Mission: QM-ADOPTION-SECURITY-B1 | 2026-08-01_
