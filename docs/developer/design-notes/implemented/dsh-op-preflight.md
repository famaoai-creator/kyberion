---
title: Governed operation preflight waterfall
status: implemented
decision_date: 2026-08-17
scope: operation dispatch and ADF execution
decision: Adopt a serial preflight waterfall with repaired input and terminal block/ask outcomes.
evidence: libs/core/op-preflight.test.ts; scripts/check_op_preflight_coverage.ts; run_pipeline regression tests
---

The operation boundary is the policy seam. Scope, ADF, egress, spend, and approval checks run
serially before a handler receives parameters. A block or ask decision is terminal for that
operation and cannot be bypassed by a step fallback.
