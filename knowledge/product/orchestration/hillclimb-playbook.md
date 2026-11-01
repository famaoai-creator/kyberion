---
title: 'Hillclimb Playbook — one metric, frozen harness, keep or revert'
tags: [orchestration, engineering, perf, hillclimb, verification, playbook, pstack]
last_updated: 2026-11-01
runtime_stages: [execution, verification]
---

# Hillclimb Playbook

Distilled from pstack Hillclimb (MIT; see [pstack-import-map](./pstack-import-map.md)).
Use for **sustained improvement of one measurable thing against a target**. A one-off slowness
fix is [engineering-perf-playbook](./engineering-perf-playbook.md). Harness/prompt improvement
loops stay under [contrastive-harness-tuning-playbook](./contrastive-harness-tuning-playbook.md)
(PPC) — do not confuse product metrics with harness probes.

## Owner stance

You own the metric and experiment integrity. Supervise; delegate attempts. One change, one
measurement, keep or revert. Never claim a win from code inspection alone.

## Steps

1. **Ground the workload** with [engineering-investigation-playbook](./engineering-investigation-playbook.md)
   over the target. Name realistic dimensions (data size, history, concurrency). Select a case that
   reproduces the complaint. Fix the repro before hillclimbing if it does not fire.
2. **Fix one metric**, the better direction, and a stop predicate that pairs a target with a floor
   on attempts (so a lucky early win cannot end the run). Agree numbers with the operator when unset.
3. **Build and freeze the measurement harness.** Prove sensitivity (target case vs easier cases).
   Vet with [benchmark-checklist-playbook](./benchmark-checklist-playbook.md) before freeze. The
   harness must print error count and work done. One repeatable command emits the metric (median of
   N). Record baseline + green regression gate before any change.
4. **Open a decision trail** via [decision-trail-playbook](./decision-trail-playbook.md)
   (complement to mission ledger — one row per attempt). Keep local/gitignored unless audit requires
   commit.
5. **Loop, one hypothesis per iteration** grounded in architecture (named mechanism, not "try
   memoizing"):
   - Scoped change (subagent/worktree when independent)
   - Measure before/after with the frozen harness; run the regression gate
   - Accept only when the metric moves past noise and the gate stays green; otherwise full revert
   - One commit per accepted win; log kept or reverted either way
6. **Past the first plateau:** pivot category, combine near-misses, or try a more radical mechanism
   before declaring done. Correctness and simplicity outrank the count. Revert a win that breaks
   behavior; keep a simplification that holds the number.
7. **Stop** when the predicate is met, or remaining ideas are not worth their cost. Do not relax
   the predicate. Surface stuck instead of spinning.
8. Ship ordered commits; `record-evidence` with baseline → final, delta, decision-trail path.

## Reply shape

Metric and target; baseline → final with % delta; iterations (kept vs reverted); each accepted fix
on one line; decision-trail path; next best untried idea.
